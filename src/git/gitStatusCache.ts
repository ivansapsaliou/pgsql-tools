import * as vscode from 'vscode';
import * as fs from 'fs';
import type * as pg from 'pg';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor, GitDdlObjectKind } from '../database/queryExecutor';
import { GitFileIndexer } from './gitFileIndexer';
import { getGitRepositoryPath } from './gitPaths';
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

const CONCURRENCY = 4;

interface ListedObject {
	schema: string;
	kind: GitDdlObjectKind;
	objectName: string;
}

export class GitStatusCache {
	private cache = new Map<string, GitObjectStatus>();
	private indexer = new GitFileIndexer('');
	private refreshGeneration = 0;
	private progressBar: vscode.StatusBarItem | undefined;
	private onUpdateEmitter = new vscode.EventEmitter<void>();
	readonly onDidUpdate = this.onUpdateEmitter.event;

	constructor(
		private connectionManager: ConnectionManager,
		private queryExecutor: QueryExecutor,
		private documentProvider: GitDdlDocumentProvider,
		private fileDecorationProvider: GitDdlFileDecorationProvider
	) {}

	getIndexer(): GitFileIndexer {
		return this.indexer;
	}

	isEnabled(): boolean {
		return !!getGitRepositoryPath();
	}

	getStatus(ref: GitObjectRef): GitObjectStatus | undefined {
		return this.cache.get(cacheKey(ref));
	}

	/** URI для дерева — всегда уникален по подключению (один git-файл на имя для всех БД). */
	getTreeResourceUri(ref: GitObjectRef): vscode.Uri | undefined {
		if (!this.getStatus(ref)) {
			return undefined;
		}
		return buildGitStatusTreeUri(ref);
	}

	getGitFilePath(kind: GitDdlObjectKind, objectName: string): string | undefined {
		return this.indexer.getFilePath(kind, objectName);
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

	async reloadIndexer(): Promise<void> {
		const root = getGitRepositoryPath();
		this.indexer = new GitFileIndexer(root);
		if (root) {
			await this.indexer.rescan();
		}
	}

	scheduleRefresh(connectionName?: string): void {
		if (!this.isEnabled()) {
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
		const ddl = await this.getDatabaseDdl(ref);
		const root = getGitRepositoryPath();
		if (!root) {
			throw new Error('Git repository path is not configured');
		}
		if (this.indexer.rootPath !== root) {
			await this.reloadIndexer();
		}
		const filePath = await this.indexer.writeFile(ref.kind, ref.objectName, ddl);
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

	private async runRefresh(onlyConnection?: string): Promise<void> {
		const gen = ++this.refreshGeneration;
		await this.reloadIndexer();
		const root = getGitRepositoryPath();
		if (!root) {
			this.cache.clear();
			this.fileDecorationProvider.clear();
			this.onUpdateEmitter.fire();
			return;
		}

		const connections = onlyConnection
			? [onlyConnection]
			: this.connectionManager.getSavedConnectionNames();

		const jobs: Array<{ connectionName: string; obj: ListedObject }> = [];
		for (const connName of connections) {
			const client = this.connectionManager.getConnectionByName(connName);
			if (!client) {
				continue;
			}
			try {
				const objects = await this.listObjects(client);
				for (const obj of objects) {
					jobs.push({ connectionName: connName, obj });
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

		for (const connName of connections) {
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
					const status = await this.compareOne(ref);
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
			if (!ref) {
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

	private async compareOne(ref: GitObjectRef): Promise<GitObjectStatus> {
		const client = this.connectionManager.getConnectionByName(ref.connectionName);
		if (!client) {
			return { status: 'error', message: 'Not connected' };
		}

		const filePath = this.indexer.getFilePath(ref.kind, ref.objectName);
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

		const dbDdl = await this.queryExecutor.getObjectDdlOnClient(
			client,
			ref.schema,
			ref.objectName,
			ref.kind
		);

		const uri = buildGitDdlUri(ref.connectionName, ref.schema, ref.kind, ref.objectName);
		this.documentProvider.setContent(uri, dbDdl);

		if (ddlTextsEqual(fileText, dbDdl, ref.kind)) {
			return { status: 'in_sync', filePath };
		}
		return { status: 'diff', filePath };
	}

	private async listObjects(client: pg.Client): Promise<ListedObject[]> {
		const eq = (q: string) => this.queryExecutor.executeQueryOnClient(client, q);
		const esc = (s: string) => s.replace(/'/g, "''");

		const schemasRes = await eq(`
			SELECT schema_name FROM information_schema.schemata
			WHERE schema_name NOT LIKE 'pg\\_%' ESCAPE '\\'
			  AND schema_name <> 'information_schema'
			ORDER BY schema_name
		`);

		const out: ListedObject[] = [];
		for (const row of schemasRes.rows) {
			const schema = row.schema_name as string;

			const tablesRes = await eq(
				`SELECT table_name FROM information_schema.tables
				 WHERE table_schema = '${esc(schema)}' AND table_type = 'BASE TABLE'
				 ORDER BY table_name`
			);
			for (const t of tablesRes.rows) {
				out.push({ schema, kind: 'table', objectName: t.table_name });
			}

			const funcRes = await eq(
				`SELECT routine_name FROM information_schema.routines
				 WHERE routine_schema = '${esc(schema)}' AND routine_type = 'FUNCTION'
				 ORDER BY routine_name`
			);
			for (const f of funcRes.rows) {
				out.push({ schema, kind: 'function', objectName: f.routine_name });
			}

			const procRes = await eq(
				`SELECT routine_name FROM information_schema.routines
				 WHERE routine_schema = '${esc(schema)}' AND routine_type = 'PROCEDURE'
				 ORDER BY routine_name`
			);
			for (const p of procRes.rows) {
				out.push({ schema, kind: 'procedure', objectName: p.routine_name });
			}
		}
		return out;
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
