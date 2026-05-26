import * as vscode from 'vscode';
import * as fs from 'fs';
import type * as pg from 'pg';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor, GitDdlObjectKind } from '../database/queryExecutor';
import { GitFileIndexer } from './gitFileIndexer';
import { GitConnectionSettings } from './gitConnectionSettings';
import { ddlTextsEqual } from './gitDdlCompare';
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

function cacheKey(ref: GitObjectRef): string {
	return `${ref.connectionName}:${ref.schema}:${ref.kind}:${ref.objectName}`;
}

const CONCURRENCY = 6;

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
}

export class GitStatusCache {
	private cache = new Map<string, GitObjectStatus>();
	private indexersByPath = new Map<string, GitFileIndexer>();
	private refreshGeneration = 0;
	private progressBar: vscode.StatusBarItem | undefined;
	private onUpdateEmitter = new vscode.EventEmitter<void>();
	readonly onDidUpdate = this.onUpdateEmitter.event;

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

	hasAnyCompareEnabled(): boolean {
		return this.gitSettings
			.getConnectionsWithCompareEnabled(this.connectionManager.getSavedConnectionNames())
			.length > 0;
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

	scheduleRefresh(connectionName?: string): void {
		if (!this.hasAnyCompareEnabled()) {
			this.cache.clear();
			this.fileDecorationProvider.clear();
			this.onUpdateEmitter.fire();
			return;
		}
		void this.runRefresh(connectionName);
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

	async syncToGitFile(ref: GitObjectRef): Promise<string> {
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
		const uri = buildGitDdlUri(ref.connectionName, ref.schema, ref.kind, ref.objectName);
		this.documentProvider.setContent(uri, ddl);
		this.cache.set(cacheKey(ref), { status: 'in_sync', filePath });
		this.publishFileDecorations();
		this.onUpdateEmitter.fire();
		return filePath;
	}

	prepareDiffUri(ref: GitObjectRef, dbDdl: string): vscode.Uri {
		const uri = buildGitDdlUri(ref.connectionName, ref.schema, ref.kind, ref.objectName);
		this.documentProvider.setContent(uri, dbDdl);
		return uri;
	}

	private indexerForConnection(connectionName: string): GitFileIndexer | undefined {
		const root = this.gitSettings.getRepositoryPath(connectionName);
		if (!root) {
			return undefined;
		}
		return this.indexersByPath.get(root);
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
				for (const key of [...this.cache.keys()]) {
					if (key.startsWith(`${name}:`)) {
						this.cache.delete(key);
					}
				}
			}
		}

		if (enabled.length === 0) {
			this.fileDecorationProvider.clear();
			this.onUpdateEmitter.fire();
			return;
		}

		const jobs: CompareJob[] = [];
		for (const connName of enabled) {
			const client = this.connectionManager.getConnectionByName(connName);
			if (!client) {
				continue;
			}
			const indexer = this.indexerForConnection(connName);
			if (!indexer) {
				continue;
			}
			try {
				const [objects, routineDdlMap] = await Promise.all([
					this.listObjects(client),
					this.queryExecutor.fetchAllRoutineDdlMapOnClient(client),
				]);
				for (const obj of objects) {
					jobs.push({ connectionName: connName, obj, indexer, routineDdlMap });
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
			if (!this.connectionManager.getConnectionByName(connName)) {
				for (const key of [...this.cache.keys()]) {
					if (key.startsWith(`${connName}:`)) {
						this.cache.delete(key);
					}
				}
			}
		}

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
				const ref: GitObjectRef = {
					connectionName: job.connectionName,
					schema: job.obj.schema,
					kind: job.obj.kind,
					objectName: job.obj.objectName,
				};
				const key = cacheKey(ref);
				this.cache.set(key, { status: 'pending' });
				try {
					const status = await this.compareOne(ref, job.indexer, job.routineDdlMap);
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
					this.onUpdateEmitter.fire();
				}
			}
		});

		await Promise.all(workers);
		this.hideProgress();
		if (gen === this.refreshGeneration) {
			this.publishFileDecorations();
			this.onUpdateEmitter.fire();
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
		routineDdlMap: Map<string, string>
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
			const client = this.connectionManager.getConnectionByName(ref.connectionName);
			if (!client) {
				return { status: 'error', message: 'Not connected' };
			}
			dbDdl = await this.queryExecutor.getObjectDdlOnClient(
				client,
				ref.schema,
				ref.objectName,
				ref.kind
			);
		}

		const uri = buildGitDdlUri(ref.connectionName, ref.schema, ref.kind, ref.objectName);
		this.documentProvider.setContent(uri, dbDdl);

		if (ddlTextsEqual(fileText, dbDdl, ref.kind)) {
			return { status: 'in_sync', filePath };
		}
		return { status: 'diff', filePath };
	}

	private async listObjects(client: pg.Client): Promise<ListedObject[]> {
		const res = await this.queryExecutor.executeQueryOnClient(client, `
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
		`);

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
		this.progressBar?.dispose();
		this.onUpdateEmitter.dispose();
	}
}
