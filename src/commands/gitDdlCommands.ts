import * as fs from 'fs';
import * as vscode from 'vscode';
import * as path from 'path';
import { GitStatusCache, GitObjectRef } from '../git/gitStatusCache';
import { setGitRepositoryPath, getGitRepositoryPath, resolveGitFilePath } from '../git/gitPaths';
import { buildGitDdlUri } from '../git/gitDocumentProvider';
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
	ref: GitObjectRef
): Promise<vscode.Uri> {
	const indexed = gitStatusCache.getGitFilePath(ref.kind, ref.objectName);
	const candidates = [
		indexed,
		getGitRepositoryPath() ? resolveGitFilePath(getGitRepositoryPath(), ref.kind, ref.objectName) : undefined,
	].filter((p): p is string => !!p);

	for (const filePath of candidates) {
		try {
			await fs.promises.access(filePath);
			return vscode.Uri.file(filePath);
		} catch {
			// try next path variant (Tables/tables, Function/function, …)
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
	treeView?: vscode.TreeView<TreeNode>
): Promise<void> {
	const treeNode = resolveTreeNode(node, treeView);
	const ref = treeNode ? refFromTreeNode(treeNode) : undefined;
	if (!ref) {
		vscode.window.showWarningMessage('Выберите таблицу, функцию или процедуру в дереве.');
		return;
	}
	if (!getGitRepositoryPath()) {
		vscode.window.showWarningMessage('Укажите каталог Git DDL.');
		return;
	}
	try {
		await gitStatusCache.reloadIndexer();
		const leftUri = await resolveLeftGitUri(gitStatusCache, ref);
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
	gitStatusCache: GitStatusCache,
	treeView: vscode.TreeView<TreeNode>
): void {
	const compare = (node: unknown) => runGitDdlDiff(node, gitStatusCache, treeView);

	context.subscriptions.push(
		vscode.commands.registerCommand('pgsql-tools.configureGitRepository', async () => {
			const current = getGitRepositoryPath();
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Select Git DDL folder',
				defaultUri: current ? vscode.Uri.file(current) : undefined,
			});
			if (!picked?.[0]) {
				return;
			}
			const folder = picked[0].fsPath;
			try {
				await fs.promises.access(folder);
			} catch {
				vscode.window.showErrorMessage(`Folder not accessible: ${folder}`);
				return;
			}
			const gitDir = path.join(folder, '.git');
			try {
				await fs.promises.access(gitDir);
			} catch {
				const proceed = await vscode.window.showWarningMessage(
					`В каталоге нет папки .git. Продолжить? (Git-операции выполняются отдельно.)`,
					'Продолжить',
					'Отмена'
				);
				if (proceed !== 'Продолжить') {
					return;
				}
			}
			await setGitRepositoryPath(folder);
			vscode.window.showInformationMessage(`Git DDL folder: ${folder}`);
			gitStatusCache.scheduleRefresh();
		}),

		vscode.commands.registerCommand('pgsql-tools.refreshGitStatus', () => {
			if (!getGitRepositoryPath()) {
				vscode.window.showWarningMessage('Укажите каталог Git DDL: PostgreSQL: Configure Git DDL Folder…');
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
			if (!getGitRepositoryPath()) {
				vscode.window.showWarningMessage('Укажите каталог Git DDL.');
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
