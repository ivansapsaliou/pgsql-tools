import * as fs from 'fs';
import * as vscode from 'vscode';
import { GitStatusCache, GitObjectRef, SchemaSyncResult } from '../git/gitStatusCache';
import { resolveGitFilePath } from '../git/gitPaths';
import { GitConnectionSettings } from '../git/gitConnectionSettings';
import { ConnectionManager } from '../database/connectionManager';
import { CommandLogService } from '../services/commandLogService';
import { GitSettingsWebview } from '../views/gitSettingsWebview';
import type { GitDdlObjectKind } from '../database/queryExecutor';
import { stripGitStatusContextValue } from '../git/gitTreeContext';
import type { TreeNode } from '../providers/treeDataProvider';

function refFromTreeNode(node: {
	parentSchema?: string;
	parentTable?: string;
	label?: string | { label: string };
	contextValue?: string;
	connectionName?: string;
}): GitObjectRef | undefined {
	const kind = stripGitStatusContextValue(node.contextValue);
	if (kind !== 'table' && kind !== 'function' && kind !== 'procedure') {
		return undefined;
	}
	const connectionName = node.connectionName;
	const schema = node.parentSchema;
	const objectName = node.parentTable ?? (typeof node.label === 'string' ? node.label : node.label?.label);
	if (!connectionName || !schema || !objectName) {
		return undefined;
	}
	return {
		connectionName,
		schema,
		kind: kind as GitDdlObjectKind,
		objectName: String(objectName),
	};
}

function schemaFromTreeNode(node: {
	parentSchema?: string;
	label?: string | { label: string };
	contextValue?: string;
	connectionName?: string;
}): { connectionName: string; schema: string } | undefined {
	const kind = stripGitStatusContextValue(node.contextValue) ?? node.contextValue;
	if (kind !== 'schema') {
		return undefined;
	}
	const connectionName = node.connectionName;
	const schema =
		node.parentSchema ??
		(typeof node.label === 'string' ? node.label : node.label?.label);
	if (!connectionName || !schema) {
		return undefined;
	}
	return { connectionName, schema: String(schema) };
}

function resolveTreeNode(
	node: unknown,
	treeView?: vscode.TreeView<TreeNode>
): TreeNode | undefined {
	const n = node as TreeNode | undefined;
	if (n?.connectionName && n.parentSchema) {
		return n;
	}
	if (n?.connectionName && stripGitStatusContextValue(n.contextValue) === 'schema') {
		return n;
	}
	return treeView?.selection?.[0];
}

async function resolveLeftGitUri(
	gitStatusCache: GitStatusCache,
	gitSettings: GitConnectionSettings,
	ref: GitObjectRef
): Promise<vscode.Uri> {
	const indexed = gitStatusCache.getGitFilePath(ref.connectionName, ref.kind, ref.objectName);
	const root = gitSettings.getRepositoryPath(ref.connectionName);
	const candidates = [
		indexed,
		root ? resolveGitFilePath(root, ref.kind, ref.objectName) : undefined,
	].filter((p): p is string => !!p);

	for (const filePath of candidates) {
		try {
			await fs.promises.access(filePath);
			return vscode.Uri.file(filePath);
		} catch {
			// try next path variant
		}
	}

	const emptyDoc = await vscode.workspace.openTextDocument({
		language: 'sql',
		content: '',
	});
	return emptyDoc.uri;
}

function ensureGitCompareEnabled(
	gitSettings: GitConnectionSettings,
	connectionName: string
): boolean {
	if (!gitSettings.isCompareEnabled(connectionName)) {
		vscode.window.showWarningMessage(
			'Git comparison is disabled for this connection. Enable it in Git DDL settings.'
		);
		return false;
	}
	return true;
}

function showSchemaSyncSummary(schema: string, result: SchemaSyncResult): void {
	const parts = [`${result.succeeded} succeeded`];
	if (result.skipped > 0) {
		parts.push(`${result.skipped} skipped`);
	}
	if (result.failed > 0) {
		parts.push(`${result.failed} failed`);
	}
	const headline = `Schema ${schema}: ${parts.join(', ')}`;
	if (result.failed === 0) {
		vscode.window.showInformationMessage(headline);
		return;
	}
	const detail = result.errors
		.slice(0, 5)
		.map((e) => `${e.ref.kind} ${e.ref.objectName}: ${e.message}`)
		.join('\n');
	vscode.window.showWarningMessage(
		headline,
		{ modal: true, detail: result.errors.length > 5 ? `${detail}\n…` : detail }
	);
}

async function runGitDdlDiff(
	node: unknown,
	gitStatusCache: GitStatusCache,
	gitSettings: GitConnectionSettings,
	treeView?: vscode.TreeView<TreeNode>
): Promise<void> {
	const treeNode = resolveTreeNode(node, treeView);
	const ref = treeNode ? refFromTreeNode(treeNode) : undefined;
	if (!ref) {
		vscode.window.showWarningMessage('Select a table, function, or procedure in the tree.');
		return;
	}
	if (!ensureGitCompareEnabled(gitSettings, ref.connectionName)) {
		return;
	}
	if (!gitSettings.isKindCompareEnabled(ref.connectionName, ref.kind)) {
		vscode.window.showWarningMessage(
			`Git comparison for ${ref.kind} is disabled in Git DDL settings.`
		);
		return;
	}
	try {
		await gitStatusCache.reloadIndexer(ref.connectionName);
		const leftUri = await resolveLeftGitUri(gitStatusCache, gitSettings, ref);
		const dbDdl = await gitStatusCache.getDatabaseDdl(ref);
		const rightUri = gitStatusCache.prepareDiffUri(ref, dbDdl);
		const title = `${ref.objectName} (${ref.schema} @ ${ref.connectionName}) — Git ↔ DB`;
		await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
	} catch (err) {
		vscode.window.showErrorMessage(
			`Failed to open comparison: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

export function registerGitDdlCommands(
	context: vscode.ExtensionContext,
	connectionManager: ConnectionManager,
	gitSettings: GitConnectionSettings,
	gitStatusCache: GitStatusCache,
	commandLogService: CommandLogService,
	getTreeView: () => vscode.TreeView<TreeNode> | undefined,
	onGitSettingsChanged: () => void
): void {
	const logCmd = (connectionName: string, commandId: string, detail?: string) => {
		void commandLogService.logCommand(connectionName, commandId, detail);
	};
	const compare = (node: unknown) =>
		runGitDdlDiff(node, gitStatusCache, gitSettings, getTreeView());

	context.subscriptions.push(
		vscode.commands.registerCommand('pgsql-tools.configureGitRepository', () => {
			GitSettingsWebview.show(context, connectionManager, gitSettings, onGitSettingsChanged);
		}),

		vscode.commands.registerCommand('pgsql-tools.refreshGitStatus', () => {
			if (!gitStatusCache.hasAnyCompareEnabled()) {
				vscode.window.showWarningMessage(
					'No connections with Git comparison enabled. Open Git DDL settings.'
				);
				return;
			}
			gitStatusCache.scheduleRefresh(undefined, { immediate: true });
			const active = connectionManager.getActiveConnectionName();
			if (active) {
				logCmd(active, 'pgsql-tools.refreshGitStatus');
			}
		}),

		vscode.commands.registerCommand('pgsql-tools.showGitDdlDiff', compare),
		vscode.commands.registerCommand('pgsql-tools.gitCompareInSync', compare),
		vscode.commands.registerCommand('pgsql-tools.gitCompareDiff', compare),
		vscode.commands.registerCommand('pgsql-tools.gitCompareMissing', compare),

		vscode.commands.registerCommand('pgsql-tools.syncGitDdlFromDatabase', async (node) => {
			const treeNode = resolveTreeNode(node, getTreeView());
			const ref = treeNode ? refFromTreeNode(treeNode) : undefined;
			if (!ref) {
				vscode.window.showWarningMessage('Select a table, function, or procedure in the tree.');
				return;
			}
			if (!gitSettings.getRepositoryPath(ref.connectionName)) {
				vscode.window.showWarningMessage('Set a Git DDL folder for this connection.');
				return;
			}
			if (!gitSettings.isKindCompareEnabled(ref.connectionName, ref.kind)) {
				vscode.window.showWarningMessage(
					`Sync for ${ref.kind} is disabled in Git DDL settings.`
				);
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Write DDL from database to Git?\n${ref.connectionName}: ${ref.schema}.${ref.objectName}`,
				{ modal: true },
				'Sync to Git'
			);
			if (confirm !== 'Sync to Git') {
				return;
			}
			try {
				const filePath = await gitStatusCache.syncToGitFile(ref);
				logCmd(
					ref.connectionName,
					'pgsql-tools.syncGitDdlFromDatabase',
					`schema=${ref.schema} object=${ref.objectName} kind=${ref.kind}`
				);
				gitStatusCache.scheduleRefresh(ref.connectionName);
				vscode.window.showInformationMessage(`Synced to Git: ${filePath}`);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Sync failed: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}),

		vscode.commands.registerCommand('pgsql-tools.syncGitDdlToDatabase', async (node) => {
			const treeNode = resolveTreeNode(node, getTreeView());
			const ref = treeNode ? refFromTreeNode(treeNode) : undefined;
			if (!ref) {
				vscode.window.showWarningMessage('Select a table, function, or procedure in the tree.');
				return;
			}
			if (!gitSettings.getRepositoryPath(ref.connectionName)) {
				vscode.window.showWarningMessage('Set a Git DDL folder for this connection.');
				return;
			}
			if (!gitSettings.isKindCompareEnabled(ref.connectionName, ref.kind)) {
				vscode.window.showWarningMessage(
					`Sync for ${ref.kind} is disabled in Git DDL settings.`
				);
				return;
			}
			const warning =
				ref.kind === 'table'
					? `Apply DDL from Git to database?\nTable ${ref.schema}.${ref.objectName} will be recreated (DROP CASCADE).\n${ref.connectionName}`
					: `Apply DDL from Git to database?\n${ref.connectionName}: ${ref.schema}.${ref.objectName}`;
			const confirm = await vscode.window.showWarningMessage(
				warning,
				{ modal: true },
				'Sync from Git'
			);
			if (confirm !== 'Sync from Git') {
				return;
			}
			try {
				await gitStatusCache.syncFromGitToDatabase(ref);
				logCmd(
					ref.connectionName,
					'pgsql-tools.syncGitDdlToDatabase',
					`schema=${ref.schema} object=${ref.objectName} kind=${ref.kind}`
				);
				gitStatusCache.scheduleRefresh(ref.connectionName);
				vscode.window.showInformationMessage(
					`Applied from Git: ${ref.schema}.${ref.objectName}`
				);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Failed to apply from Git: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}),

		vscode.commands.registerCommand('pgsql-tools.syncGitSchemaToGit', async (node) => {
			const treeNode = resolveTreeNode(node, getTreeView());
			const ctx = treeNode ? schemaFromTreeNode(treeNode) : undefined;
			if (!ctx) {
				vscode.window.showWarningMessage('Select a schema in the tree.');
				return;
			}
			if (!ensureGitCompareEnabled(gitSettings, ctx.connectionName)) {
				return;
			}
			if (!gitSettings.getRepositoryPath(ctx.connectionName)) {
				vscode.window.showWarningMessage('Set a Git DDL folder for this connection.');
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Write all DDL from database to Git for schema «${ctx.schema}»?\nConnection: ${ctx.connectionName}`,
				{ modal: true },
				'Sync Schema to Git'
			);
			if (confirm !== 'Sync Schema to Git') {
				return;
			}
			try {
				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Sync schema ${ctx.schema} to Git`,
						cancellable: false,
					},
					async (progress) => {
						progress.report({ message: 'Loading objects…' });
						return gitStatusCache.syncSchemaToGit(ctx.connectionName, ctx.schema);
					}
				);
				gitStatusCache.scheduleRefresh(ctx.connectionName);
				logCmd(
					ctx.connectionName,
					'pgsql-tools.syncGitSchemaToGit',
					`schema=${ctx.schema} succeeded=${result.succeeded} failed=${result.failed}`
				);
				showSchemaSyncSummary(ctx.schema, result);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Schema sync failed: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		}),

		vscode.commands.registerCommand('pgsql-tools.syncGitSchemaFromGit', async (node) => {
			const treeNode = resolveTreeNode(node, getTreeView());
			const ctx = treeNode ? schemaFromTreeNode(treeNode) : undefined;
			if (!ctx) {
				vscode.window.showWarningMessage('Select a schema in the tree.');
				return;
			}
			if (!ensureGitCompareEnabled(gitSettings, ctx.connectionName)) {
				return;
			}
			if (!gitSettings.getRepositoryPath(ctx.connectionName)) {
				vscode.window.showWarningMessage('Set a Git DDL folder for this connection.');
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Apply DDL from Git to database for schema «${ctx.schema}»?\nTables will be recreated (DROP CASCADE). Objects without Git files are skipped.\nConnection: ${ctx.connectionName}`,
				{ modal: true },
				'Sync Schema from Git'
			);
			if (confirm !== 'Sync Schema from Git') {
				return;
			}
			try {
				const result = await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: `Sync schema ${ctx.schema} from Git`,
						cancellable: false,
					},
					async (progress) => {
						progress.report({ message: 'Applying DDL…' });
						return gitStatusCache.syncSchemaFromGitToDatabase(ctx.connectionName, ctx.schema);
					}
				);
				gitStatusCache.scheduleRefresh(ctx.connectionName);
				logCmd(
					ctx.connectionName,
					'pgsql-tools.syncGitSchemaFromGit',
					`schema=${ctx.schema} succeeded=${result.succeeded} failed=${result.failed} skipped=${result.skipped}`
				);
				showSchemaSyncSummary(ctx.schema, result);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Schema sync failed: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		})
	);
}
