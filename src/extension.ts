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
const routineDdlOriginalText = new Map<string, string>();
let routineDdlDecorationType: vscode.TextEditorDecorationType;

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
	routineDdlDecorationType = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
		borderWidth: '0 0 0 2px',
		borderStyle: 'solid',
		borderColor: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
		overviewRulerColor: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	context.subscriptions.push(routineDdlDecorationType);

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
	const computeChangedLineNumbers = (originalText: string, currentText: string): number[] => {
		const orig = originalText.split(/\r?\n/);
		const cur = currentText.split(/\r?\n/);
		const n = orig.length;
		const m = cur.length;
		const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i][j] = orig[i] === cur[j]
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		const unchangedCurrentLines = new Set<number>();
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (orig[i] === cur[j]) {
				unchangedCurrentLines.add(j + 1);
				i++;
				j++;
				continue;
			}
			if (dp[i + 1][j] >= dp[i][j + 1]) {
				i++;
			} else {
				j++;
			}
		}
		const changed: number[] = [];
		for (let line = 1; line <= m; line++) {
			if (!unchangedCurrentLines.has(line)) {
				changed.push(line);
			}
		}
		return changed;
	};
	const updateRoutineDdlDecorations = (editor: vscode.TextEditor | undefined) => {
		if (!editor || editor.document.languageId !== 'sql') return;
		const key = editor.document.uri.toString();
		const original = routineDdlOriginalText.get(key);
		if (original === undefined) return;
		const current = editor.document.getText();
		if (current === original) {
			editor.setDecorations(routineDdlDecorationType, []);
			return;
		}
		const changedLines = computeChangedLineNumbers(original, current);
		const decorations = changedLines.map((lineNo) => {
			const line = editor.document.lineAt(Math.max(0, lineNo - 1));
			return new vscode.Range(line.lineNumber, 0, line.lineNumber, line.text.length);
		});
		editor.setDecorations(routineDdlDecorationType, decorations);
	};
	const openRoutineDdlDocument = async (
		schema: string,
		objectName: string,
		objectType: 'function' | 'procedure'
	) => {
		try {
			const ddl = objectType === 'function'
				? await queryExecutor.getFunctionDDL(schema, objectName)
				: await queryExecutor.getProcedureDDL(schema, objectName);
			const fileName = `${objectName}.sql`;
			const uri = vscode.Uri.from({ scheme: 'untitled', path: `/${fileName}` });
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
			if (doc.getText().length === 0) {
				await editor.edit((editBuilder) => {
					editBuilder.insert(new vscode.Position(0, 0), ddl);
				});
			}
			routineDdlOriginalText.set(doc.uri.toString(), doc.getText());
			updateRoutineDdlDecorations(editor);
			updateConnectionStatusBar();
			refreshSqlConnectionCodeLens();
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to open ${objectType} DDL: ${err}`);
		}
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
				if (objectType === 'function' || objectType === 'procedure') {
					void openRoutineDdlDocument(schema, objectName, objectType);
				} else {
					ObjectDetailsPanel.show(
						context, schema, objectName, objectType,
						queryExecutor, connectionManager, resultsViewProvider
					);
				}
			}
		}
	});

	const commands = [
		vscode.commands.registerCommand('pgsql-tools.noop', () => undefined),
		vscode.commands.registerCommand('pgsql-tools.searchTree', async () => {
			const current = databaseTreeProvider.getFilterText();
			const value = await vscode.window.showInputBox({
				prompt: 'Поиск по дереву (только активное подключение)',
				placeHolder: 'Введите текст…',
				value: current,
			});
			if (value === undefined) return; // cancelled
			const term = value.trim();
			await databaseTreeProvider.applySearch(term);

			// Если дерево отфильтровано — просто раскрываем ветки с совпадениями.
			if (!term) return;
			const activeConn = connectionManager.getActiveConnectionName();
			if (!activeConn) return;

			const root = await databaseTreeProvider.getChildren();
			const connNode = (root as any[]).find((n) => n?.contextValue === 'connection' && n?.label === activeConn);
			if (!connNode) return;

			// Раскрываем активное подключение → схемы → группы (объекты уже будут видны).
			await databaseTreeView.reveal(connNode as any, { expand: 1, focus: false, select: false });
			const schemas = await databaseTreeProvider.getChildren(connNode as any);
			for (const schemaNode of schemas as any[]) {
				if (schemaNode?.contextValue !== 'schema') continue;
				await databaseTreeView.reveal(schemaNode, { expand: 1, focus: false, select: false });
				const groups = await databaseTreeProvider.getChildren(schemaNode);
				for (const groupNode of groups as any[]) {
					if (!String(groupNode?.contextValue ?? '').startsWith('group_')) continue;
					await databaseTreeView.reveal(groupNode, { expand: 1, focus: false, select: false });
				}
			}
		}),
		vscode.commands.registerCommand('pgsql-tools.clearTreeSearch', () => {
			databaseTreeProvider.clearFilterText();
		}),
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
		vscode.commands.registerCommand('pgsql-tools.editDDL', async (node: any) => {
			const doc = await vscode.workspace.openTextDocument({
				language: 'sql',
				content: '',
			});
			await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
			updateConnectionStatusBar();
			refreshSqlConnectionCodeLens();
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
			if (objectType === 'function' || objectType === 'procedure') {
				await openRoutineDdlDocument(schema, objectName, objectType);
			} else {
				await ObjectDetailsPanel.show(
					context, schema, objectName, objectType,
					queryExecutor, connectionManager, resultsViewProvider
				);
			}
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
		const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === event.document.uri.toString());
		if (editor) {
			updateRoutineDdlDecorations(editor);
		}
	});
	const visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors((editors) => {
		for (const editor of editors) {
			updateRoutineDdlDecorations(editor);
		}
	});
	const closeDocumentListener = vscode.workspace.onDidCloseTextDocument((doc) => {
		routineDdlOriginalText.delete(doc.uri.toString());
	});

	updateConnectionStatusBar();
	refreshSqlConnectionCodeLens();
	context.subscriptions.push(
		...commands,
		visibilityListener,
		activeEditorListener,
		openDocumentListener,
		changeDocumentListener,
		visibleEditorsListener,
		closeDocumentListener
	);
}

export function deactivate() {
	connectionManager?.closeAllConnections();
}