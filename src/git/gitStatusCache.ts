import * as vscode from 'vscode';
import * as fs from 'fs';
import type * as pg from 'pg';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor, GitDdlObjectKind } from '../database/queryExecutor';
import { GitFileIndexer } from './gitFileIndexer';
import { GitConnectionSettings } from './gitConnectionSettings';
import { ddlTextsEqual } from './gitDdlCompare';
import { applyGitDdlOnClient } from './gitDdlApply';
import { buildGitDdlUri } from './gitDocumentProvider';
import { GitDdlDocumentProvider } from './gitDocumentProvider';
import { GitDdlFileDecorationProvider } from './gitFileDecorationProvider';
import { buildGitStatusTreeUri, parseCacheKey } from './gitStatusUri';

export type GitSyncStatus = 'in_sync' | 'diff' | 'missing_in_git' | 'error' | 'pending';

export interface GitObjectStatus {
	status: GitSyncStatus;
	message?: string;
	filePath?: string;
}

export interface GitObjectRef {
	connectionName: string;
	schema: string;
	kind: GitDdlObjectKind;
	objectName: string;
}

export interface SchemaSyncResult {
	succeeded: number;
	failed: number;
	skipped: number;
	errors: Array<{ ref: GitObjectRef; message: string }>;
}

interface SyncUiOptions {
	deferUi?: boolean;
}

function cacheKey(ref: GitObjectRef): string {
	return `${ref.connectionName}:${ref.schema}:${ref.kind}:${ref.objectName}`;
}

function objectJobKey(obj: ListedObject): string {
	return `${obj.schema}:${obj.kind}:${obj.objectName}`;
}

const CONCURRENCY = 3;
const REFRESH_DEBOUNCE_MS = 2500;
const DECORATION_DEBOUNCE_MS = 1000;

interface ListedObject {
	schema: string;
	kind: GitDdlObjectKind;
	objectName: string;
}

interface CompareJob {
	connectionName: string;
	obj: ListedObject;
	indexer: GitFileIndexer;
	routineDdlMap: Map<string, string>;
	client: pg.Client;
}

export interface GitRefreshOptions {
	/** Без debounce — для ручного обновления и подключения к БД. */
	immediate?: boolean;
}

export class GitStatusCache {
	private cache = new Map<string, GitObjectStatus>();
	private indexersByPath = new Map<string, GitFileIndexer>();
	private refreshGeneration = 0;
	private refreshRunning = false;
	private refreshAgain = false;
	private scheduledConnection?: string;
	private refreshDebounceTimer: ReturnType<typeof setTimeout> | undefined;
	private decorationTimer: ReturnType<typeof setTimeout> | undefined;
	private progressBar: vscode.StatusBarItem | undefined;
	private onTreeRefreshEmitter = new vscode.EventEmitter<void>();
	/** Полное обновление дерева — только в начале/конце сверки. */
	readonly onDidRequestTreeRefresh = this.onTreeRefreshEmitter.event;

	constructor(
		private connectionManager: ConnectionManager,
		private queryExecutor: QueryExecutor,
		private documentProvider: GitDdlDocumentProvider,
		private fileDecorationProvider: GitDdlFileDecorationProvider,
		private gitSettings: GitConnectionSettings
	) {}

	isCompareEnabled(connectionName: string): boolean {
		return this.gitSettings.isCompareEnabled(connectionName);
	}

	isKindCompareEnabled(connectionName: string, kind: GitDdlObjectKind): boolean {
		return this.gitSettings.isKindCompareEnabled(connectionName, kind);
	}

	hasAnyCompareEnabled(): boolean {
		return this.gitSettings
			.getConnectionsWithCompareEnabled(this.connectionManager.getSavedConnectionNames())
			.length > 0;
	}

	hasConnectedCompareEnabled(): boolean {
		return this.gitSettings
			.getConnectionsWithCompareEnabled(this.connectionManager.getSavedConnectionNames())
			.some((name) => this.connectionManager.isConnected(name));
	}

	isRefreshInProgress(): boolean {
		return this.refreshRunning;
	}

	getStatus(ref: GitObjectRef): GitObjectStatus | undefined {
		return this.cache.get(cacheKey(ref));
	}

	getTreeResourceUri(ref: GitObjectRef): vscode.Uri | undefined {
		if (!this.isCompareEnabled(ref.connectionName) || !this.getStatus(ref)) {
			return undefined;
		}
		return buildGitStatusTreeUri(ref);
	}

	getGitFilePath(connectionName: string, kind: GitDdlObjectKind, objectName: string): string | undefined {
		const root = this.gitSettings.getRepositoryPath(connectionName);
		if (!root) {
			return undefined;
		}
		return this.indexersByPath.get(root)?.getFilePath(kind, objectName);
	}

	getStatusForNode(
		connectionName: string | undefined,
		schema: string | undefined,
		kind: string | undefined,
		objectName: string | undefined
	): GitObjectStatus | undefined {
		if (!connectionName || !schema || !kind || !objectName) {
			return undefined;
		}
		if (!this.isCompareEnabled(connectionName)) {
			return undefined;
		}
		if (kind !== 'table' && kind !== 'function' && kind !== 'procedure') {
			return undefined;
		}
		if (!this.isKindCompareEnabled(connectionName, kind)) {
			return undefined;
		}
		return this.getStatus({
			connectionName,
			schema,
			kind,
			objectName,
		});
	}

	async reloadIndexer(connectionName?: string): Promise<void> {
		const names = connectionName
			? [connectionName]
			: this.connectionManager.getSavedConnectionNames();
		const paths = this.gitSettings.getActiveRepositoryPaths(names);
		for (const root of paths) {
			let indexer = this.indexersByPath.get(root);
			if (!indexer) {
				indexer = new GitFileIndexer(root);
				this.indexersByPath.set(root, indexer);
			} else if (indexer.rootPath !== root) {
				indexer = new GitFileIndexer(root);
				this.indexersByPath.set(root, indexer);
			}
			await indexer.rescan();
		}
	}

	scheduleRefresh(connectionName?: string, options?: GitRefreshOptions): void {
		if (!this.hasAnyCompareEnabled()) {
			this.cache.clear();
			this.fileDecorationProvider.clear();
			this.requestTreeRefresh();
			return;
		}
		if (!this.hasConnectedCompareEnabled()) {
			return;
		}
		if (connectionName !== undefined) {
			if (!this.connectionManager.isConnected(connectionName)) {
				return;
			}
			this.scheduledConnection = connectionName;
		}
		if (options?.immediate) {
			if (this.refreshDebounceTimer) {
				clearTimeout(this.refreshDebounceTimer);
				this.refreshDebounceTimer = undefined;
			}
			void this.beginRefresh();
			return;
		}
		if (this.refreshDebounceTimer) {
			clearTimeout(this.refreshDebounceTimer);
		}
		this.refreshDebounceTimer = setTimeout(() => {
			this.refreshDebounceTimer = undefined;
			void this.beginRefresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	async getDatabaseDdl(ref: GitObjectRef): Promise<string> {
		const client = this.connectionManager.getConnectionByName(ref.connectionName);
		if (!client) {
			throw new Error(
				`Подключение «${ref.connectionName}» не активно. Подключитесь к БД в дереве и повторите.`
			);
		}
		try {
			return await this.queryExecutor.getObjectDdlOnClient(
				client,
				ref.schema,
				ref.objectName,
				ref.kind
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`DDL из «${ref.connectionName}» (${ref.schema}.${ref.objectName}): ${msg}`);
		}
	}

	async syncToGitFile(ref: GitObjectRef, options?: SyncUiOptions): Promise<string> {
		if (!this.isKindCompareEnabled(ref.connectionName, ref.kind)) {
			throw new Error(
				`Синхронизация для типа «${ref.kind}» отключена в настройках Git DDL для «${ref.connectionName}».`
			);
		}
		const root = this.gitSettings.getRepositoryPath(ref.connectionName);
		if (!root) {
			throw new Error('Каталог Git DDL для подключения не настроен');
		}
		await this.reloadIndexer(ref.connectionName);
		const indexer = this.indexersByPath.get(root);
		if (!indexer) {
			throw new Error('Индексатор Git DDL не инициализирован');
		}
		const ddl = await this.getDatabaseDdl(ref);
		const filePath = await indexer.writeFile(ref.kind, ref.objectName, ddl);
		let onDisk = ddl;
		try {
			onDisk = await fs.promises.readFile(filePath, 'utf8');
		} catch {
			// use in-memory ddl
		}
		const status = ddlTextsEqual(onDisk, ddl, ref.kind) ? 'in_sync' : 'diff';
		this.cache.set(cacheKey(ref), { status, filePath });
		if (!options?.deferUi) {
			this.publishFileDecorations();
			this.requestTreeRefresh();
		}
		return filePath;
	}

	async syncFromGitToDatabase(ref: GitObjectRef, options?: SyncUiOptions): Promise<void> {
		if (!this.isKindCompareEnabled(ref.connectionName, ref.kind)) {
			throw new Error(
				`Сравнение для типа «${ref.kind}» отключено в настройках Git DDL для «${ref.connectionName}».`
			);
		}
		const root = this.gitSettings.getRepositoryPath(ref.connectionName);
		if (!root) {
			throw new Error('Каталог Git DDL для подключения не настроен');
		}
		await this.reloadIndexer(ref.connectionName);
		const indexer = this.indexersByPath.get(root);
		if (!indexer) {
			throw new Error('Индексатор Git DDL не инициализирован');
		}
		const filePath = indexer.getFilePath(ref.kind, ref.objectName);
		if (!filePath) {
			throw new Error('Нет файла в Git для этого объекта');
		}

		const client = this.connectionManager.getConnectionByName(ref.connectionName);
		if (!client) {
			throw new Error(
				`Подключение «${ref.connectionName}» не активно. Подключитесь к БД в дереве и повторите.`
			);
		}

		const gitDdl = await fs.promises.readFile(filePath, 'utf8');
		await applyGitDdlOnClient(
			this.queryExecutor,
			client,
			ref.schema,
			ref.objectName,
			ref.kind,
			gitDdl
		);

		const dbDdl = await this.queryExecutor.getObjectDdlOnClient(
			client,
			ref.schema,
			ref.objectName,
			ref.kind
		);
		const status = ddlTextsEqual(gitDdl, dbDdl, ref.kind) ? 'in_sync' : 'diff';
		this.cache.set(cacheKey(ref), { status, filePath });
		if (!options?.deferUi) {
			this.publishFileDecorations();
			this.requestTreeRefresh();
		}
	}

	async listSchemaRefs(connectionName: string, schema: string): Promise<GitObjectRef[]> {
		const client = this.connectionManager.getConnectionByName(connectionName);
		if (!client) {
			throw new Error(
				`Connection «${connectionName}» is not active. Connect to the database and try again.`
			);
		}
		const compareKinds = this.gitSettings.getCompareKinds(connectionName);
		const objects = await this.listObjects(client, connectionName);
		const seen = new Set<string>();
		const refs: GitObjectRef[] = [];
		for (const obj of objects) {
			if (obj.schema !== schema || !compareKinds[obj.kind]) {
				continue;
			}
			const dedupeKey = objectJobKey(obj);
			if (seen.has(dedupeKey)) {
				continue;
			}
			seen.add(dedupeKey);
			refs.push({
				connectionName,
				schema: obj.schema,
				kind: obj.kind,
				objectName: obj.objectName,
			});
		}
		return refs;
	}

	async syncSchemaToGit(connectionName: string, schema: string): Promise<SchemaSyncResult> {
		const refs = await this.listSchemaRefs(connectionName, schema);
		const result: SchemaSyncResult = { succeeded: 0, failed: 0, skipped: 0, errors: [] };
		if (refs.length === 0) {
			return result;
		}
		await this.reloadIndexer(connectionName);
		for (const ref of refs) {
			try {
				await this.syncToGitFile(ref, { deferUi: true });
				result.succeeded++;
			} catch (err) {
				result.failed++;
				result.errors.push({
					ref,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
		this.publishFileDecorations();
		this.requestTreeRefresh();
		return result;
	}

	async syncSchemaFromGitToDatabase(connectionName: string, schema: string): Promise<SchemaSyncResult> {
		const refs = await this.listSchemaRefs(connectionName, schema);
		const result: SchemaSyncResult = { succeeded: 0, failed: 0, skipped: 0, errors: [] };
		if (refs.length === 0) {
			return result;
		}
		const root = this.gitSettings.getRepositoryPath(connectionName);
		if (!root) {
			throw new Error('Git DDL folder is not configured for this connection');
		}
		await this.reloadIndexer(connectionName);
		const indexer = this.indexersByPath.get(root);
		if (!indexer) {
			throw new Error('Git DDL indexer is not initialized');
		}
		for (const ref of refs) {
			if (!indexer.getFilePath(ref.kind, ref.objectName)) {
				result.skipped++;
				continue;
			}
			try {
				await this.syncFromGitToDatabase(ref, { deferUi: true });
				result.succeeded++;
			} catch (err) {
				result.failed++;
				result.errors.push({
					ref,
					message: err instanceof Error ? err.message : String(err),
				});
			}
		}
		this.publishFileDecorations();
		this.requestTreeRefresh();
		return result;
	}

	prepareDiffUri(ref: GitObjectRef, dbDdl: string): vscode.Uri {
		const uri = buildGitDdlUri(ref.connectionName, ref.schema, ref.kind, ref.objectName);
		this.documentProvider.setContent(uri, dbDdl);
		return uri;
	}

	onConnectionDisconnected(connectionName: string): void {
		++this.refreshGeneration;
		this.refreshAgain = false;
		if (this.refreshDebounceTimer) {
			clearTimeout(this.refreshDebounceTimer);
			this.refreshDebounceTimer = undefined;
		}
		if (this.decorationTimer) {
			clearTimeout(this.decorationTimer);
			this.decorationTimer = undefined;
		}
		if (this.scheduledConnection === connectionName) {
			this.scheduledConnection = undefined;
		}
		this.clearCacheForConnections([connectionName]);
		this.publishFileDecorations();
		this.hideProgress();
		this.requestTreeRefresh();
	}

	private indexerForConnection(connectionName: string): GitFileIndexer | undefined {
		const root = this.gitSettings.getRepositoryPath(connectionName);
		if (!root) {
			return undefined;
		}
		return this.indexersByPath.get(root);
	}

	private async beginRefresh(): Promise<void> {
		if (this.refreshRunning) {
			this.refreshAgain = true;
			return;
		}
		this.refreshRunning = true;
		try {
			const onlyConnection = this.scheduledConnection;
			this.scheduledConnection = undefined;
			await this.runRefresh(onlyConnection);
		} finally {
			this.refreshRunning = false;
			if (this.refreshAgain) {
				this.refreshAgain = false;
				this.scheduleRefresh();
			}
		}
	}

	private requestTreeRefresh(): void {
		this.onTreeRefreshEmitter.fire();
	}

	private scheduleDecorationUpdate(): void {
		if (this.decorationTimer) {
			return;
		}
		this.decorationTimer = setTimeout(() => {
			this.decorationTimer = undefined;
			if (this.refreshRunning) {
				this.publishFileDecorations();
			}
		}, DECORATION_DEBOUNCE_MS);
	}

	private clearCacheForConnections(connectionNames: string[]): void {
		for (const name of connectionNames) {
			const prefix = `${name}:`;
			for (const key of [...this.cache.keys()]) {
				if (key.startsWith(prefix)) {
					this.cache.delete(key);
				}
			}
		}
	}

	private async runRefresh(onlyConnection?: string): Promise<void> {
		const gen = ++this.refreshGeneration;
		await this.reloadIndexer(onlyConnection);

		const allNames = this.connectionManager.getSavedConnectionNames();
		const enabled = this.gitSettings.getConnectionsWithCompareEnabled(
			onlyConnection ? [onlyConnection] : allNames
		);

		for (const name of allNames) {
			if (!this.gitSettings.isCompareEnabled(name)) {
				this.clearCacheForConnections([name]);
			}
		}

		if (enabled.length === 0) {
			this.fileDecorationProvider.clear();
			this.requestTreeRefresh();
			return;
		}

		this.clearCacheForConnections(enabled);
		for (const key of [...this.cache.keys()]) {
			const ref = parseCacheKey(key);
			if (!ref || !enabled.includes(ref.connectionName)) {
				continue;
			}
			if (!this.isKindCompareEnabled(ref.connectionName, ref.kind)) {
				this.cache.delete(key);
			}
		}
		this.fileDecorationProvider.clear();
		this.requestTreeRefresh();

		const jobs: CompareJob[] = [];

		for (const connName of enabled) {
			if (!this.connectionManager.isConnected(connName)) {
				continue;
			}
			const indexer = this.indexerForConnection(connName);
			if (!indexer) {
				continue;
			}
			const pooledClient = this.connectionManager.getConnectionByName(connName);
			if (!pooledClient) {
				continue;
			}

			try {
				const [objects, routineDdlMap] = await Promise.all([
					this.listObjects(pooledClient, connName),
					this.queryExecutor.fetchAllRoutineDdlMapOnClient(pooledClient, { skipLog: true }),
				]);
				const compareKinds = this.gitSettings.getCompareKinds(connName);
				const seen = new Set<string>();
				for (const obj of objects) {
					if (!compareKinds[obj.kind]) {
						continue;
					}
					const dedupeKey = objectJobKey(obj);
					if (seen.has(dedupeKey)) {
						continue;
					}
					seen.add(dedupeKey);
					jobs.push({
						connectionName: connName,
						obj,
						indexer,
						routineDdlMap,
						client: pooledClient,
					});
				}
			} catch (err) {
				console.error(`Git DDL: failed to list objects for "${connName}":`, err);
				vscode.window.showWarningMessage(
					`Git DDL: не удалось получить список объектов для «${connName}»: ${
						err instanceof Error ? err.message : String(err)
					}`
				);
			}
		}

		for (const connName of onlyConnection ? [onlyConnection] : allNames) {
			if (!this.connectionManager.isConnected(connName)) {
				this.clearCacheForConnections([connName]);
			}
		}

		for (const job of jobs) {
			const ref: GitObjectRef = {
				connectionName: job.connectionName,
				schema: job.obj.schema,
				kind: job.obj.kind,
				objectName: job.obj.objectName,
			};
			this.cache.set(cacheKey(ref), { status: 'pending' });
		}
		this.publishFileDecorations();
		this.requestTreeRefresh();

		let done = 0;
		const total = jobs.length;
		this.showProgress(0, total);

		const queue = [...jobs];
		const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length || 1) }, async () => {
			while (queue.length > 0) {
				if (gen !== this.refreshGeneration) {
					return;
				}
				const job = queue.shift()!;
				if (!this.connectionManager.isConnected(job.connectionName)) {
					continue;
				}
				const ref: GitObjectRef = {
					connectionName: job.connectionName,
					schema: job.obj.schema,
					kind: job.obj.kind,
					objectName: job.obj.objectName,
				};
				const key = cacheKey(ref);
				try {
					const status = await this.compareOne(
						ref,
						job.indexer,
						job.routineDdlMap,
						job.client,
						job.connectionName
					);
					if (gen === this.refreshGeneration) {
						this.cache.set(key, status);
					}
				} catch (err) {
					if (gen === this.refreshGeneration) {
						this.cache.set(key, {
							status: 'error',
							message: err instanceof Error ? err.message : String(err),
						});
					}
				}
				done++;
				this.showProgress(done, total);
				if (gen === this.refreshGeneration) {
					this.scheduleDecorationUpdate();
				}
				if (done % 8 === 0) {
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
			}
		});

		await Promise.all(workers);

		this.hideProgress();
		if (this.decorationTimer) {
			clearTimeout(this.decorationTimer);
			this.decorationTimer = undefined;
		}
		if (gen === this.refreshGeneration) {
			this.publishFileDecorations();
			this.requestTreeRefresh();
		}
	}

	private publishFileDecorations(): void {
		const statusPriority: Record<GitSyncStatus, number> = {
			error: 5,
			diff: 4,
			pending: 3,
			missing_in_git: 2,
			in_sync: 1,
		};
		const byUri = new Map<string, { uri: vscode.Uri; status: GitObjectStatus }>();
		for (const [key, status] of this.cache.entries()) {
			const ref = parseCacheKey(key);
			if (!ref || !this.isCompareEnabled(ref.connectionName)) {
				continue;
			}
			if (!this.isKindCompareEnabled(ref.connectionName, ref.kind)) {
				continue;
			}
			const uri = buildGitStatusTreeUri(ref);
			const uriKey = uri.toString();
			const prev = byUri.get(uriKey);
			if (!prev || statusPriority[status.status] > statusPriority[prev.status.status]) {
				byUri.set(uriKey, { uri, status });
			}
		}
		this.fileDecorationProvider.setUriStatuses(
			[...byUri.values()].map(({ uri, status }) => ({
				uri,
				status: status.status,
				tooltip: status.message,
			}))
		);
	}

	private async compareOne(
		ref: GitObjectRef,
		indexer: GitFileIndexer,
		routineDdlMap: Map<string, string>,
		client: pg.Client,
		connectionName: string
	): Promise<GitObjectStatus> {
		const filePath = indexer.getFilePath(ref.kind, ref.objectName);
		if (!filePath) {
			return { status: 'missing_in_git' };
		}

		let fileText: string;
		try {
			fileText = await fs.promises.readFile(filePath, 'utf8');
		} catch (err) {
			return {
				status: 'error',
				message: err instanceof Error ? err.message : String(err),
				filePath,
			};
		}

		const routineKey = `${ref.schema}:${ref.kind}:${ref.objectName}`;
		let dbDdl: string;
		if ((ref.kind === 'function' || ref.kind === 'procedure') && routineDdlMap.has(routineKey)) {
			dbDdl = routineDdlMap.get(routineKey)!;
		} else {
			dbDdl = await this.queryExecutor.getObjectDdlOnClient(
				client,
				ref.schema,
				ref.objectName,
				ref.kind,
				{ skipLog: true, connectionName }
			);
		}

		if (ddlTextsEqual(fileText, dbDdl, ref.kind)) {
			return { status: 'in_sync', filePath };
		}
		return { status: 'diff', filePath };
	}

	private async listObjects(client: pg.Client, connectionName: string): Promise<ListedObject[]> {
		const res = await this.queryExecutor.executeQueryOnClient(
			client,
			`
			SELECT table_schema AS schema_name, table_name AS obj_name, 'table' AS kind
			FROM information_schema.tables
			WHERE table_schema NOT LIKE 'pg\\_%' ESCAPE '\\'
			  AND table_schema <> 'information_schema'
			  AND table_type = 'BASE TABLE'
			UNION ALL
			SELECT routine_schema, routine_name,
				CASE WHEN routine_type = 'FUNCTION' THEN 'function' ELSE 'procedure' END
			FROM information_schema.routines
			WHERE routine_schema NOT LIKE 'pg\\_%' ESCAPE '\\'
			  AND routine_schema <> 'information_schema'
			  AND routine_type IN ('FUNCTION', 'PROCEDURE')
			ORDER BY 1, 3, 2
		`,
			{ skipLog: true, connectionName }
		);

		return res.rows.map((row) => ({
			schema: String(row.schema_name),
			kind: row.kind as GitDdlObjectKind,
			objectName: String(row.obj_name),
		}));
	}

	private showProgress(done: number, total: number): void {
		if (!this.progressBar) {
			this.progressBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
		}
		if (total === 0) {
			this.progressBar.text = '$(database) Git DDL: no objects';
		} else {
			this.progressBar.text = `$(sync~spin) Git DDL: ${done}/${total}`;
		}
		this.progressBar.show();
	}

	private hideProgress(): void {
		if (this.progressBar) {
			this.progressBar.hide();
		}
	}

	dispose(): void {
		if (this.refreshDebounceTimer) {
			clearTimeout(this.refreshDebounceTimer);
			this.refreshDebounceTimer = undefined;
		}
		if (this.decorationTimer) {
			clearTimeout(this.decorationTimer);
			this.decorationTimer = undefined;
		}
		this.progressBar?.dispose();
		this.onTreeRefreshEmitter.dispose();
	}
}
