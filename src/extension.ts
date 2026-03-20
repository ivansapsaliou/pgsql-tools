import * as vscode from 'vscode';
import { PostgreSQLTreeDataProvider } from './providers/treeDataProvider';
import { ConnectionsTreeProvider } from './providers/connectionsTreeProvider';
import { ConnectionManager } from './database/connectionManager';
import { QueryExecutor } from './database/queryExecutor';
import { ConnectionWebview } from './views/connectionWebview';
import { QueryEditorPanel } from './views/queryEditorPanel';
import { ObjectDetailsPanel } from './views/objectDetailsPanel';
import { ResultsViewProvider } from './views/resultsPanel';
import { ThemeManager } from './theme/themeManager';
import { SQLCompletionProvider } from './language/sqlCompletionProvider';
import { SQLHoverProvider } from './language/sqlHoverProvider';
import { ExecuteSqlFileCommand } from './commands/executeSqlFile';

let connectionManager: ConnectionManager;
let databaseTreeProvider: PostgreSQLTreeDataProvider;
let connectionsTreeProvider: ConnectionsTreeProvider;
let queryExecutor: QueryExecutor;
let themeManager: ThemeManager;
let sqlCompletionProvider: SQLCompletionProvider;
let resultsViewProvider: ResultsViewProvider;

export function activate(context: vscode.ExtensionContext) {
	console.log('pgsql-tools extension is now active!');

	// Initialize managers
	connectionManager = new ConnectionManager(context);
	databaseTreeProvider = new PostgreSQLTreeDataProvider(connectionManager);
	connectionsTreeProvider = new ConnectionsTreeProvider(connectionManager);
	queryExecutor = new QueryExecutor(connectionManager);
	themeManager = new ThemeManager();
	sqlCompletionProvider = new SQLCompletionProvider(queryExecutor, connectionManager);
	resultsViewProvider = new ResultsViewProvider(context.extensionUri);

	// Set context flag
	vscode.commands.executeCommand('setContext', 'pgsqlToolsActive', true);

	// Register WebviewViewProvider for Results Panel
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			ResultsViewProvider.viewType,
			resultsViewProvider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	// Register language providers
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider('sql', sqlCompletionProvider, '.', ' ')
	);

	context.subscriptions.push(
		vscode.languages.registerHoverProvider('sql', new SQLHoverProvider())
	);

	// Register Tree Views
	const databaseTreeView = vscode.window.createTreeView('pgsqlDatabases', {
		treeDataProvider: databaseTreeProvider,
		showCollapseAll: true
	});

	const connectionsTreeView = vscode.window.createTreeView('pgsqlConnections', {
		treeDataProvider: connectionsTreeProvider,
		showCollapseAll: false
	});

	// Register Commands
	const commands = [
		vscode.commands.registerCommand('pgsql-tools.addConnection', () => {
			ConnectionWebview.show(context, connectionManager, databaseTreeProvider, connectionsTreeProvider, themeManager);
		}),
		vscode.commands.registerCommand('pgsql-tools.executeQuery', () => {
			QueryEditorPanel.show(context, queryExecutor, connectionManager, themeManager);
		}),
		vscode.commands.registerCommand('pgsql-tools.openQueryFile', async () => {
			// Create a new untitled SQL file
			const document = await vscode.workspace.openTextDocument({
				language: 'sql',
				content: '-- PostgreSQL Query\n-- Connection: ' + (connectionManager.getActiveConnectionName() || 'Not selected') + '\n\nSELECT * FROM information_schema.tables LIMIT 10;\n'
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
				themeManager
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
		ExecuteSqlFileCommand.register(queryExecutor, connectionManager, resultsViewProvider)
	];

	// Listen for theme changes
	const themeChangeListener = vscode.window.onDidChangeActiveColorTheme((theme) => {
		console.log('Theme changed to:', theme.kind);
		themeManager.updateTheme(theme);
	});

	// Auto-refresh tree when views become visible
	const databaseViewVisibilityListener = databaseTreeView.onDidChangeVisibility((e) => {
		if (e.visible) {
			databaseTreeProvider.refresh();
		}
	});

	const connectionsViewVisibilityListener = connectionsTreeView.onDidChangeVisibility((e) => {
		if (e.visible) {
			connectionsTreeProvider.refresh();
		}
	});

	context.subscriptions.push(
		...commands,
		themeChangeListener,
		databaseViewVisibilityListener,
		connectionsViewVisibilityListener
	);
}

export function deactivate() {
	connectionManager?.closeAllConnections();
}