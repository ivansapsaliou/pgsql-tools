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
let connectionStatusBar: vscode.StatusBarItem;
let sqlCodeLensEmitter: vscode.EventEmitter<void>;

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
	await vscode.workspace.getConfiguration('workbench').update(
		'tree.expandMode',
		'doubleClick',
		vscode.ConfigurationTarget.Workspace
	);

	connectionStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	connectionStatusBar.name = 'PostgreSQL Connection';
	context.subscriptions.push(connectionStatusBar);
	sqlCodeLensEmitter = new vscode.EventEmitter<void>();
	context.subscriptions.push(sqlCodeLensEmitter);

	const updateConnectionStatusBar = () => {
		const activeConnection = connectionManager.getActiveConnectionName();
		connectionStatusBar.text = activeConnection
			? `$(database) PostgreSQL: ${activeConnection}`
			: '$(warning) PostgreSQL: Not connected';
		connectionStatusBar.tooltip = activeConnection
			? `Active PostgreSQL connection: ${activeConnection}`
			: 'No active PostgreSQL connection selected';
		connectionStatusBar.show();
	};

	const refreshSqlConnectionCodeLens = () => {
		sqlCodeLensEmitter.fire();
	};
	const refreshConnectionUi = () => {
		databaseTreeProvider.refresh();
		sqlCompletionProvider.refresh();
		updateConnectionStatusBar();
		refreshSqlConnectionCodeLens();
	};

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
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ language: 'sql' }, {
			onDidChangeCodeLenses: sqlCodeLensEmitter.event,
			provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
				if (document.languageId !== 'sql') return [];
				const info = connectionManager.getActiveConnectionDisplayInfo();
				const title = info
					? `$(database) ${info.name} | ${info.database}`
					: '$(warning) Not connected';
				return [
					new vscode.CodeLens(
						new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
						{
							title,
							command: 'pgsql-tools.noop',
						}
					),
				];
			},
		})
	);

	// Единое дерево
	const databaseTreeView = vscode.window.createTreeView('pgsqlDatabases', {
		treeDataProvider: databaseTreeProvider,
		showCollapseAll: true,
	});
	let lastConnectionClickName: string | null = null;
	let lastConnectionClickAt = 0;

	// Обработка клика - открытие деталей объекта
	databaseTreeView.onDidChangeSelection((e) => {
		const selection = e.selection;
		if (selection && selection.length > 0) {
			const item = selection[0];
			const contextValue = (item as any).contextValue;
			if (contextValue === 'connection' || contextValue === 'connection_disconnected') {
				const name = (item as any).connectionName ?? (item as any).label?.replace(/^● /, '');
				if (!name) return;
				const now = Date.now();
				const isDoubleClick = lastConnectionClickName === name && now - lastConnectionClickAt <= 450;
				lastConnectionClickName = name;
				lastConnectionClickAt = now;
				if (isDoubleClick) {
					void (async () => {
						if (connectionManager.isConnected(name)) {
							await connectionManager.disconnect(name);
							vscode.window.showInformationMessage(`Disconnected: ${name}`);
						} else {
							const connected = await connectionManager.connectSavedConnection(name);
							if (connected) {
								vscode.window.showInformationMessage(`Connected: ${name}`);
							}
						}
						refreshConnectionUi();
					})();
				}
				return;
			}
			// Открываем детали только для конечных объектов
			if (contextValue === 'table' || contextValue === 'view' || contextValue === 'function' || contextValue === 'procedure') {
				const schema = (item as any).parentSchema || 'public';
				const objectName = (item as any).parentTable || (item as any).label;
				const objectType = contextValue === 'function' ? 'function' 
					: contextValue === 'procedure' ? 'procedure' 
					: contextValue === 'view' ? 'view'
					: 'table';
				ObjectDetailsPanel.show(
					context, schema, objectName, objectType,
					queryExecutor, connectionManager, resultsViewProvider
				);
			}
		}
	});

	const commands = [
		vscode.commands.registerCommand('pgsql-tools.noop', () => undefined),
		// ── Подключение ─────────────────────────────────────────────────────
		vscode.commands.registerCommand('pgsql-tools.addConnection', () => {
			ConnectionWebview.show(context, connectionManager, () => {
				refreshConnectionUi();
			});
		}),

		// ── Редактор запросов ────────────────────────────────────────────────
		vscode.commands.registerCommand('pgsql-tools.openQueryEditor', () => {
			QueryEditorPanel.show(context, queryExecutor, connectionManager);
		}),

		vscode.commands.registerCommand('pgsql-tools.openQueryFile', async () => {
			const doc = await vscode.workspace.openTextDocument({
				language: 'sql',
				content: '',
			});
			await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
			updateConnectionStatusBar();
			refreshSqlConnectionCodeLens();
		}),

		// ── Детали таблицы / функции / процедуры ─────────────────────────────
		vscode.commands.registerCommand('pgsql-tools.viewTableDetails', async (node: any) => {
			const schema = node.parentSchema || 'public';
			const objectName = node.parentTable || node.label;
			// Determine object type: function, procedure, view, or default to table
			const objectType = node.contextValue === 'function' ? 'function' 
				: node.contextValue === 'procedure' ? 'procedure' 
				: node.contextValue === 'view' ? 'view'
				: 'table';
			await ObjectDetailsPanel.show(
				context, schema, objectName, objectType,
				queryExecutor, connectionManager, resultsViewProvider
			);
		}),

		// ── Refresh ──────────────────────────────────────────────────────────
		vscode.commands.registerCommand('pgsql-tools.refreshDatabases', () => {
			refreshConnectionUi();
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
				refreshConnectionUi();
				vscode.window.showInformationMessage(`Connection "${name}" deleted`);
			}
		}),

		vscode.commands.registerCommand('pgsql-tools.selectConnection', (node: any) => {
			const name = node?.connectionName ?? node?.label;
			if (!name) return;
			connectionManager.setActiveConnection(name);
			refreshConnectionUi();
			vscode.window.showInformationMessage(`Active connection: ${name}`);
		}),
		vscode.commands.registerCommand('pgsql-tools.connectConnection', async (node: any) => {
			const name = node?.connectionName ?? node?.label;
			if (!name) return;
			const ok = await connectionManager.connectSavedConnection(name);
			if (ok) {
				refreshConnectionUi();
				vscode.window.showInformationMessage(`Connected: ${name}`);
			}
		}),
		vscode.commands.registerCommand('pgsql-tools.disconnectConnection', async (node: any) => {
			const name = node?.connectionName ?? node?.label;
			if (!name) return;
			await connectionManager.disconnect(name);
			refreshConnectionUi();
			vscode.window.showInformationMessage(`Disconnected: ${name}`);
		}),

		// ── SQL выполнение (F9 / Ctrl+Shift+E) ──────────────────────────────
		ExecuteSqlFileCommand.register(queryExecutor, connectionManager, resultsViewProvider),

		// ── Schema Diff ──────────────────────────────────────────────────────
		SchemaDiffCommand.register(queryExecutor, connectionManager, context),

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
	const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
		updateConnectionStatusBar();
		refreshSqlConnectionCodeLens();
	});
	const openDocumentListener = vscode.workspace.onDidOpenTextDocument((doc) => {
		if (doc.languageId === 'sql') {
			updateConnectionStatusBar();
			refreshSqlConnectionCodeLens();
		}
	});
	const changeDocumentListener = vscode.workspace.onDidChangeTextDocument((event) => {
		if (event.document.languageId === 'sql') {
			refreshSqlConnectionCodeLens();
		}
	});

	updateConnectionStatusBar();
	refreshSqlConnectionCodeLens();
	context.subscriptions.push(
		...commands,
		visibilityListener,
		activeEditorListener,
		openDocumentListener,
		changeDocumentListener
	);
}

export function deactivate() {
	connectionManager?.closeAllConnections();
}