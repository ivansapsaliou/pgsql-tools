import * as vscode from 'vscode';
import { PostgreSQLTreeDataProvider } from './providers/treeDataProvider';
import { ConnectionManager } from './database/connectionManager';
import { QueryExecutor } from './database/queryExecutor';
import { ConnectionWebview } from './views/connectionWebview';
import { QueryEditorPanel } from './views/queryEditorPanel';
import { ObjectDetailsPanel } from './views/objectDetailsPanel';
import { ResultsViewProvider } from './views/resultsPanel';
import { SQLCompletionProvider } from './language/sqlCompletionProvider';
import { SQLHoverProvider } from './language/sqlHoverProvider';
import { ExecuteSqlFileCommand } from './commands/executeSqlFile';
import { SchemaDiffCommand } from './commands/schemaDiff';
import { ShowERDCommand } from './commands/showERD';
import { HealthCommands } from './commands/healthCommands';
import { ExplainQueryCommand } from './commands/explainQuery';

let connectionManager: ConnectionManager;
let databaseTreeProvider: PostgreSQLTreeDataProvider;
let queryExecutor: QueryExecutor;
let sqlCompletionProvider: SQLCompletionProvider;
let resultsViewProvider: ResultsViewProvider;

export async function activate(context: vscode.ExtensionContext) {
	console.log('pgsql-tools extension is now active!');

	connectionManager = new ConnectionManager(context);
	databaseTreeProvider = new PostgreSQLTreeDataProvider(connectionManager);
	queryExecutor = new QueryExecutor(connectionManager);
	sqlCompletionProvider = new SQLCompletionProvider(queryExecutor, connectionManager);
	resultsViewProvider = new ResultsViewProvider(context.extensionUri);

	vscode.commands.executeCommand('setContext', 'pgsqlToolsActive', true);

	// Восстанавливаем подключения из прошлой сессии
	await connectionManager.restoreConnections();
	databaseTreeProvider.refresh();

	// Results Panel (нижняя панель)
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			ResultsViewProvider.viewType,
			resultsViewProvider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	// SQL автодополнение и hover
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider('sql', sqlCompletionProvider, '.', ' ', '\t')
	);
	context.subscriptions.push(
		vscode.languages.registerHoverProvider('sql', new SQLHoverProvider())
	);

	// Единое дерево
	const databaseTreeView = vscode.window.createTreeView('pgsqlDatabases', {
		treeDataProvider: databaseTreeProvider,
		showCollapseAll: true,
	});

	const commands = [
		// ── Подключение ─────────────────────────────────────────────────────
		vscode.commands.registerCommand('pgsql-tools.addConnection', () => {
			ConnectionWebview.show(context, connectionManager, () => {
				databaseTreeProvider.refresh();
				sqlCompletionProvider.refresh();
			});
		}),

		// ── Редактор запросов ────────────────────────────────────────────────
		vscode.commands.registerCommand('pgsql-tools.openQueryEditor', () => {
			QueryEditorPanel.show(context, queryExecutor, connectionManager);
		}),

		vscode.commands.registerCommand('pgsql-tools.openQueryFile', async () => {
			const doc = await vscode.workspace.openTextDocument({
				language: 'sql',
				content: `-- PostgreSQL Query\n-- Connection: ${connectionManager.getActiveConnectionName() || 'Not selected'}\n\n`,
			});
			await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		}),

		// ── Детали таблицы ───────────────────────────────────────────────────
		vscode.commands.registerCommand('pgsql-tools.viewTableDetails', async (node: any) => {
			const schema = node.parentSchema || 'public';
			const tableName = node.parentTable || node.label;
			await ObjectDetailsPanel.show(
				context, schema, tableName, 'table',
				queryExecutor, connectionManager, resultsViewProvider
			);
		}),

		// ── Refresh ──────────────────────────────────────────────────────────
		vscode.commands.registerCommand('pgsql-tools.refreshDatabases', () => {
			databaseTreeProvider.refresh();
			sqlCompletionProvider.refresh();
		}),

		// ── Управление подключениями ─────────────────────────────────────────
		vscode.commands.registerCommand('pgsql-tools.deleteConnection', async (node: any) => {
			const name = node?.connectionName ?? node?.label;
			if (!name) return;
			const confirm = await vscode.window.showWarningMessage(
				`Delete connection "${name}"?`, 'Delete', 'Cancel'
			);
			if (confirm === 'Delete') {
				await connectionManager.removeConnection(name);
				databaseTreeProvider.refresh();
				sqlCompletionProvider.refresh();
				vscode.window.showInformationMessage(`Connection "${name}" deleted`);
			}
		}),

		vscode.commands.registerCommand('pgsql-tools.selectConnection', (node: any) => {
			const name = node?.connectionName ?? node?.label;
			if (!name) return;
			connectionManager.setActiveConnection(name);
			databaseTreeProvider.refresh();
			sqlCompletionProvider.refresh();
			vscode.window.showInformationMessage(`Active connection: ${name}`);
		}),

		// ── SQL выполнение (F9 / Ctrl+Shift+E) ──────────────────────────────
		ExecuteSqlFileCommand.register(queryExecutor, connectionManager, resultsViewProvider),

		// ── Schema Diff ──────────────────────────────────────────────────────
		SchemaDiffCommand.register(queryExecutor, connectionManager, resultsViewProvider),

		// ── ERD (теперь отдельная панель) ────────────────────────────────────
		...ShowERDCommand.register(queryExecutor, connectionManager, context),

		// ── Health ───────────────────────────────────────────────────────────
		...HealthCommands.registerAll(queryExecutor, connectionManager, context),

		// ── Explain ──────────────────────────────────────────────────────────
		ExplainQueryCommand.register(queryExecutor, connectionManager, resultsViewProvider),
	];

	const visibilityListener = databaseTreeView.onDidChangeVisibility((e) => {
		if (e.visible) databaseTreeProvider.refresh();
	});

	context.subscriptions.push(...commands, visibilityListener);
}

export function deactivate() {
	connectionManager?.closeAllConnections();
}