import * as vscode from 'vscode';
import { PostgreSQLTreeDataProvider } from './providers/treeDataProvider';
import { ConnectionsTreeProvider } from './providers/connectionsTreeProvider';
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
let connectionsTreeProvider: ConnectionsTreeProvider;
let queryExecutor: QueryExecutor;
let sqlCompletionProvider: SQLCompletionProvider;
let resultsViewProvider: ResultsViewProvider;

export async function activate(context: vscode.ExtensionContext) {
	console.log('pgsql-tools extension is now active!');

	connectionManager = new ConnectionManager(context);
	databaseTreeProvider = new PostgreSQLTreeDataProvider(connectionManager);
	connectionsTreeProvider = new ConnectionsTreeProvider(connectionManager);
	queryExecutor = new QueryExecutor(connectionManager);
	sqlCompletionProvider = new SQLCompletionProvider(queryExecutor, connectionManager);
	resultsViewProvider = new ResultsViewProvider(context.extensionUri);

	vscode.commands.executeCommand('setContext', 'pgsqlToolsActive', true);

	// Restore saved connections from previous session (passwords from SecretStorage)
	await connectionManager.restoreConnections();
	connectionsTreeProvider.refresh();
	databaseTreeProvider.refresh();

	// Register WebviewViewProvider for Results Panel (bottom panel)
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			ResultsViewProvider.viewType,
			resultsViewProvider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	// Language providers
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			'sql',
			sqlCompletionProvider,
			'.', ' ', '\t'
		)
	);

	context.subscriptions.push(
		vscode.languages.registerHoverProvider('sql', new SQLHoverProvider())
	);

	// Tree Views
	const databaseTreeView = vscode.window.createTreeView('pgsqlDatabases', {
		treeDataProvider: databaseTreeProvider,
		showCollapseAll: true
	});

	const connectionsTreeView = vscode.window.createTreeView('pgsqlConnections', {
		treeDataProvider: connectionsTreeProvider,
		showCollapseAll: false
	});

	// Commands
	const commands = [
		vscode.commands.registerCommand('pgsql-tools.addConnection', () => {
			ConnectionWebview.show(
				context,
				connectionManager,
				databaseTreeProvider,
				connectionsTreeProvider
			);
		}),

		vscode.commands.registerCommand('pgsql-tools.openQueryEditor', () => {
			QueryEditorPanel.show(context, queryExecutor, connectionManager);
		}),

		vscode.commands.registerCommand('pgsql-tools.openQueryFile', async () => {
			const document = await vscode.workspace.openTextDocument({
				language: 'sql',
				content: `-- PostgreSQL Query\n-- Connection: ${connectionManager.getActiveConnectionName() || 'Not selected'}\n\n`
			});
			await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
		}),

		vscode.commands.registerCommand('pgsql-tools.viewTableDetails', async (node: any) => {
			const schema = node.parentSchema || 'public';
			const tableName = node.label;
			await ObjectDetailsPanel.show(
				context,
				schema,
				tableName,
				'table',
				queryExecutor,
				connectionManager,
				resultsViewProvider
			);
		}),

		vscode.commands.registerCommand('pgsql-tools.refreshDatabases', () => {
			databaseTreeProvider.refresh();
			sqlCompletionProvider.refresh();
		}),

		vscode.commands.registerCommand('pgsql-tools.deleteConnection', async (node) => {
			if (node && node.label) {
				const confirm = await vscode.window.showWarningMessage(
					`Delete connection "${node.label}"?`,
					'Delete',
					'Cancel'
				);
				if (confirm === 'Delete') {
					await connectionManager.removeConnection(node.label);
					connectionsTreeProvider.refresh();
					databaseTreeProvider.refresh();
					sqlCompletionProvider.refresh();
					vscode.window.showInformationMessage(`Connection "${node.label}" deleted`);
				}
			}
		}),

		vscode.commands.registerCommand('pgsql-tools.selectConnection', (node) => {
			if (node && node.label) {
				connectionManager.setActiveConnection(node.label);
				connectionsTreeProvider.refresh();
				databaseTreeProvider.refresh();
				sqlCompletionProvider.refresh();
				vscode.window.showInformationMessage(`Selected connection: ${node.label}`);
			}
		}),

		ExecuteSqlFileCommand.register(queryExecutor, connectionManager, resultsViewProvider),

		// ── Introspection & Generation ────────────────────────────────────────
		SchemaDiffCommand.register(queryExecutor, connectionManager, resultsViewProvider),
		ShowERDCommand.register(queryExecutor, connectionManager, resultsViewProvider),

		// ── Health / Diagnostics ──────────────────────────────────────────────
		...HealthCommands.registerAll(queryExecutor, connectionManager, resultsViewProvider),

		// ── Explain ───────────────────────────────────────────────────────────
		ExplainQueryCommand.register(queryExecutor, connectionManager, resultsViewProvider)
	];

	const databaseViewVisibilityListener = databaseTreeView.onDidChangeVisibility((e) => {
		if (e.visible) databaseTreeProvider.refresh();
	});

	const connectionsViewVisibilityListener = connectionsTreeView.onDidChangeVisibility((e) => {
		if (e.visible) connectionsTreeProvider.refresh();
	});

	context.subscriptions.push(
		...commands,
		databaseViewVisibilityListener,
		connectionsViewVisibilityListener
	);
}

export function deactivate() {
	connectionManager?.closeAllConnections();
}