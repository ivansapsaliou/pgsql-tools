import * as fs from 'fs';
import * as vscode from 'vscode';
import { GitStatusCache, GitObjectRef } from '../git/gitStatusCache';
import { resolveGitFilePath } from '../git/gitPaths';
import { GitConnectionSettings } from '../git/gitConnectionSettings';
import { ConnectionManager } from '../database/connectionManager';
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

function resolveTreeNode(
	node: unknown,
	treeView?: vscode.TreeView<TreeNode>
): TreeNode | undefined {
	const n = node as TreeNode | undefined;
	if (n?.connectionName && n.parentSchema) {
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

async function runGitDdlDiff(
	node: unknown,
	gitStatusCache: GitStatusCache,
	gitSettings: GitConnectionSettings,
	treeView?: vscode.TreeView<TreeNode>
): Promise<void> {
	const treeNode = resolveTreeNode(node, treeView);
	const ref = treeNode ? refFromTreeNode(treeNode) : undefined;
	if (!ref) {
		vscode.window.showWarningMessage('Выберите таблицу, функцию или процедуру в дереве.');
		return;
	}
	if (!gitSettings.isCompareEnabled(ref.connectionName)) {
		vscode.window.showWarningMessage(
			'Сравнение с Git отключено для этого подключения. Включите в настройках Git DDL.'
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
			`Не удалось открыть сравнение: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

export function registerGitDdlCommands(
	context: vscode.ExtensionContext,
	connectionManager: ConnectionManager,
	gitSettings: GitConnectionSettings,
	gitStatusCache: GitStatusCache,
	treeView: vscode.TreeView<TreeNode>,
	onGitSettingsChanged: () => void
): void {
	const compare = (node: unknown) => runGitDdlDiff(node, gitStatusCache, gitSettings, treeView);

	context.subscriptions.push(
		vscode.commands.registerCommand('pgsql-tools.configureGitRepository', () => {
			GitSettingsWebview.show(context, connectionManager, gitSettings, onGitSettingsChanged);
		}),

		vscode.commands.registerCommand('pgsql-tools.refreshGitStatus', () => {
			if (!gitStatusCache.hasAnyCompareEnabled()) {
				vscode.window.showWarningMessage(
					'Нет подключений с включённым сравнением Git. Откройте настройки Git DDL.'
				);
				return;
			}
			gitStatusCache.scheduleRefresh();
		}),

		vscode.commands.registerCommand('pgsql-tools.showGitDdlDiff', compare),
		vscode.commands.registerCommand('pgsql-tools.gitCompareInSync', compare),
		vscode.commands.registerCommand('pgsql-tools.gitCompareDiff', compare),
		vscode.commands.registerCommand('pgsql-tools.gitCompareMissing', compare),

		vscode.commands.registerCommand('pgsql-tools.syncGitDdlFromDatabase', async (node) => {
			const treeNode = resolveTreeNode(node, treeView);
			const ref = treeNode ? refFromTreeNode(treeNode) : undefined;
			if (!ref) {
				vscode.window.showWarningMessage('Выберите таблицу, функцию или процедуру в дереве.');
				return;
			}
			const root = gitSettings.getRepositoryPath(ref.connectionName);
			if (!root) {
				vscode.window.showWarningMessage('Укажите каталог Git DDL для этого подключения.');
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Записать DDL из БД в файл Git?\n${ref.connectionName}: ${ref.schema}.${ref.objectName}`,
				{ modal: true },
				'Записать'
			);
			if (confirm !== 'Записать') {
				return;
			}
			try {
				const filePath = await gitStatusCache.syncToGitFile(ref);
				vscode.window.showInformationMessage(`Сохранено: ${filePath}`);
				gitStatusCache.scheduleRefresh(ref.connectionName);
			} catch (err) {
				vscode.window.showErrorMessage(
					`Синхронизация не удалась: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		})
	);
}
