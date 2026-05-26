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
import { GitDdlDocumentProvider } from './git/gitDocumentProvider';
import { GitDdlFileDecorationProvider } from './git/gitFileDecorationProvider';
import { GitStatusCache } from './git/gitStatusCache';
import { GitConnectionSettings } from './git/gitConnectionSettings';
import { registerGitDdlCommands } from './commands/gitDdlCommands';
import { TreeSearchWebviewProvider } from './views/treeSearchWebview';
import { TreeSearchSettings } from './search/treeSearchSettings';
import type { TreeSearchObjectKind } from './search/treeSearchSettings';
import type { GitDdlObjectKind } from './database/queryExecutor';
import type { TreeNode } from './providers/treeDataProvider';

let connectionManager: ConnectionManager;
let databaseTreeProvider: PostgreSQLTreeDataProvider;
let queryExecutor: QueryExecutor;
let sqlCompletionProvider: SQLCompletionProvider;
let resultsViewProvider: ResultsViewProvider;
let connectionStatusBar: vscode.StatusBarItem;
let sqlCodeLensEmitter: vscode.EventEmitter<void>;
let gitStatusCache: GitStatusCache;
let gitConnectionSettings: GitConnectionSettings;
let gitFileWatchers: vscode.FileSystemWatcher[] = [];
let gitFileWatcherDebounce: ReturnType<typeof setTimeout> | undefined;
const routineDdlOriginalText = new Map<string, string>();
/** Ключ объекта → URI открытой вкладки DDL (редактируемый untitled). */
const openDdlDocumentsByKey = new Map<string, string>();
let routineDdlDecorationType: vscode.TextEditorDecorationType;

function ddlDocumentKey(
	connectionName: string,
	schema: string,
	objectType: GitDdlObjectKind,
	objectName: string
): string {
	return `${connectionName}:${schema}:${objectType}:${objectName}`;
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('pgsql-tools extension is now active!');

	connectionManager = new ConnectionManager(context);
	const treeSearchSettings = new TreeSearchSettings(context);
	databaseTreeProvider = new PostgreSQLTreeDataProvider(connectionManager);
	databaseTreeProvider.setTreeSearchSettings(treeSearchSettings);
	queryExecutor = new QueryExecutor(connectionManager);
	sqlCompletionProvider = new SQLCompletionProvider(queryExecutor, connectionManager);
	resultsViewProvider = new ResultsViewProvider(context.extensionUri);

	const gitDocumentProvider = new GitDdlDocumentProvider();
	gitDocumentProvider.register(context);
	const gitFileDecorationProvider = new GitDdlFileDecorationProvider();
	gitFileDecorationProvider.register(context);
	gitConnectionSettings = new GitConnectionSettings(context);
	gitStatusCache = new GitStatusCache(
		connectionManager,
		queryExecutor,
		gitDocumentProvider,
		gitFileDecorationProvider,
		gitConnectionSettings
	);
	databaseTreeProvider.setGitStatusCache(gitStatusCache);
	context.subscriptions.push(gitStatusCache);
	gitStatusCache.onDidUpdate(() => databaseTreeProvider.refresh());

	const installGitFileWatchers = () => {
		for (const w of gitFileWatchers) {
			w.dispose();
		}
		gitFileWatchers = [];
		const paths = gitConnectionSettings.getActiveRepositoryPaths(
			connectionManager.getSavedConnectionNames()
		);
		for (const root of paths) {
			const pattern = new vscode.RelativePattern(
				vscode.Uri.file(root),
				'{Tables,tables,Function,function,Procedures,procedures}/**/*.sql'
			);
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			const onFsChange = () => {
				if (gitFileWatcherDebounce) {
					clearTimeout(gitFileWatcherDebounce);
				}
				gitFileWatcherDebounce = setTimeout(() => {
					gitFileWatcherDebounce = undefined;
					void gitStatusCache.reloadIndexer().then(() => gitStatusCache.scheduleRefresh());
				}, 400);
			};
			watcher.onDidChange(onFsChange);
			watcher.onDidCreate(onFsChange);
			watcher.onDidDelete(onFsChange);
			gitFileWatchers.push(watcher);
		}
	};
	const onGitSettingsChanged = () => {
		installGitFileWatchers();
		gitStatusCache.scheduleRefresh();
		databaseTreeProvider.refresh();
	};
	installGitFileWatchers();
	context.subscriptions.push({ dispose: () => gitFileWatchers.forEach((w) => w.dispose()) });
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('pgsql-tools.gitRepositoryPath')) {
				onGitSettingsChanged();
			}
		})
	);

	vscode.commands.executeCommand('setContext', 'pgsqlToolsActive', true);

	// Восстанавливаем подключения из прошлой сессии
	await connectionManager.restoreConnections();
	databaseTreeProvider.refresh();
	if (gitStatusCache.hasAnyCompareEnabled()) {
		gitStatusCache.scheduleRefresh();
	}
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
	const loadSchemasForConnection = async (connectionName: string): Promise<string[]> => {
		const cached = treeSearchSettings.getCachedSchemas(connectionName);
		if (cached.length > 0) {
			return cached;
		}
		const client = connectionManager.getConnectionByName(connectionName);
		if (!client) {
			return [];
		}
		try {
			const res = await queryExecutor.executeQueryOnClient(
				client,
				`
				SELECT schema_name FROM information_schema.schemata
				WHERE schema_name NOT LIKE 'pg\\_%' ESCAPE '\\'
				  AND schema_name <> 'information_schema'
				ORDER BY schema_name
				`
			);
			const schemas = res.rows.map((r) => String(r.schema_name));
			treeSearchSettings.setSchemaList(connectionName, schemas);
			return schemas;
		} catch {
			return [];
		}
	};

	const refreshConnectionUi = () => {
		treeSearchSettings.clearSchemaCache();
		databaseTreeProvider.refresh();
		sqlCompletionProvider.refresh();
		updateConnectionStatusBar();
		refreshSqlConnectionCodeLens();
		if (gitStatusCache.hasAnyCompareEnabled()) {
			gitStatusCache.scheduleRefresh();
		}
		void treeSearchProvider?.refreshState();
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
		if (!editor || editor.document.languageId !== 'sql') {
			return;
		}
		const scheme = editor.document.uri.scheme;
		if (scheme === 'pgsql-tools-git') {
			return;
		}
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
	const openObjectDdlDocument = async (
		connectionName: string,
		schema: string,
		objectName: string,
		objectType: GitDdlObjectKind
	) => {
		try {
			const docKey = ddlDocumentKey(connectionName, schema, objectType, objectName);
			const existingUri = openDdlDocumentsByKey.get(docKey);
			if (existingUri) {
				const existing = vscode.workspace.textDocuments.find(
					(d) => d.uri.toString() === existingUri
				);
				if (existing) {
					const editor = await vscode.window.showTextDocument(existing, {
						viewColumn: vscode.ViewColumn.One,
						preview: true,
						preserveFocus: false,
					});
					if (!routineDdlOriginalText.has(existingUri)) {
						routineDdlOriginalText.set(existingUri, existing.getText());
					}
					updateRoutineDdlDecorations(editor);
					updateConnectionStatusBar();
					refreshSqlConnectionCodeLens();
					return;
				}
				openDdlDocumentsByKey.delete(docKey);
			}

			const client = connectionManager.getConnectionByName(connectionName);
			if (!client) {
				vscode.window.showWarningMessage(
					`Подключение «${connectionName}» не активно. Подключитесь к БД и повторите.`
				);
				return;
			}
			const ddl = await queryExecutor.getObjectDdlOnClient(
				client,
				schema,
				objectName,
				objectType
			);
			// content при создании — без editor.edit, документ не помечается изменённым
			const doc = await vscode.workspace.openTextDocument({
				language: 'sql',
				content: ddl,
			});
			const uriKey = doc.uri.toString();
			openDdlDocumentsByKey.set(docKey, uriKey);
			routineDdlOriginalText.set(uriKey, ddl);
			const editor = await vscode.window.showTextDocument(doc, {
				viewColumn: vscode.ViewColumn.One,
				preview: true,
				preserveFocus: false,
			});
			updateRoutineDdlDecorations(editor);
			updateConnectionStatusBar();
			refreshSqlConnectionCodeLens();
		} catch (err) {
			vscode.window.showErrorMessage(
				`Не удалось открыть DDL: ${err instanceof Error ? err.message : String(err)}`
			);
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

	const databaseTreeView = vscode.window.createTreeView('pgsqlDatabases', {
		treeDataProvider: databaseTreeProvider,
		showCollapseAll: true,
	});

	const revealSearchMatches = async () => {
		const term = databaseTreeProvider.getFilterText().trim();
		if (!term) {
			return;
		}
		const activeConn = connectionManager.getActiveConnectionName();
		if (!activeConn) {
			return;
		}
		const root = await databaseTreeProvider.getChildren();
		const connNode = (root as TreeNode[]).find(
			(n) => n?.contextValue === 'connection' && n?.label === activeConn
		);
		if (!connNode) {
			return;
		}
		await databaseTreeView.reveal(connNode, { expand: 1, focus: false, select: false });
		const schemas = await databaseTreeProvider.getChildren(connNode);
		for (const schemaNode of schemas) {
			if (schemaNode?.contextValue !== 'schema') {
				continue;
			}
			await databaseTreeView.reveal(schemaNode, { expand: 1, focus: false, select: false });
			const groups = await databaseTreeProvider.getChildren(schemaNode);
			for (const groupNode of groups) {
				if (!String(groupNode?.contextValue ?? '').startsWith('group_')) {
					continue;
				}
				await databaseTreeView.reveal(groupNode, { expand: 1, focus: false, select: false });
			}
		}
	};

	let treeSearchProvider: TreeSearchWebviewProvider;

	const rerunTreeSearch = async () => {
		const term = databaseTreeProvider.getFilterText().trim();
		if (term) {
			await databaseTreeProvider.applySearch(term);
			await revealSearchMatches();
		} else {
			databaseTreeProvider.refresh();
		}
		await treeSearchProvider.refreshState();
	};

	treeSearchProvider = new TreeSearchWebviewProvider(context.extensionUri, {
		getWebviewState: async () => {
			const conn = connectionManager.getActiveConnectionName();
			const schemas = conn ? await loadSchemasForConnection(conn) : [];
			return treeSearchSettings.buildWebviewState(
				databaseTreeProvider.getFilterText(),
				conn,
				schemas
			);
		},
		onFilterChange: async (term) => {
			await databaseTreeProvider.applySearch(term);
			await revealSearchMatches();
			await treeSearchProvider.refreshState();
		},
		onToggleObjectType: async (kind: TreeSearchObjectKind, enabled: boolean) => {
			await treeSearchSettings.setObjectType(kind, enabled);
		},
		onToggleSettings: async () => {
			const willOpen = !treeSearchSettings.isSettingsOpen();
			treeSearchSettings.setSettingsOpen(willOpen);
			if (willOpen) {
				const conn = connectionManager.getActiveConnectionName();
				if (conn) {
					treeSearchSettings.clearSchemaCache(conn);
				}
			}
			await treeSearchProvider.refreshState();
		},
		onToggleSchema: async (schema, enabled) => {
			const conn = connectionManager.getActiveConnectionName();
			if (!conn) {
				return;
			}
			await treeSearchSettings.setSchemaEnabled(conn, schema, enabled);
		},
		onSetAllSchemas: async (enabled) => {
			const conn = connectionManager.getActiveConnectionName();
			if (!conn) {
				return;
			}
			const schemas = await loadSchemasForConnection(conn);
			await treeSearchSettings.setAllSchemasEnabled(conn, enabled, schemas);
		},
	});

	treeSearchSettings.onDidChange(() => {
		void rerunTreeSearch();
	});

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			TreeSearchWebviewProvider.viewType,
			treeSearchProvider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);
	registerGitDdlCommands(
		context,
		connectionManager,
		gitConnectionSettings,
		gitStatusCache,
		databaseTreeView,
		onGitSettingsChanged
	);

	let lastConnectionClickName: string | null = null;
	let lastConnectionClickAt = 0;
	// Обработка клика - открытие деталей объекта
	databaseTreeView.onDidChangeSelection((e) => {
		const selection = e.selection;
		if (selection && selection.length > 0) {
			const item = selection[0];
			const contextValue = String((item as any).contextValue ?? '').replace(/\+git-.*$/, '');
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
			if (contextValue === 'table' || contextValue === 'view' || contextValue === 'function' || contextValue === 'procedure') {
				const schema = (item as any).parentSchema || 'public';
				const objectName = (item as any).parentTable || (item as any).label;
				const objectType = contextValue === 'function' ? 'function' 
					: contextValue === 'procedure' ? 'procedure' 
					: contextValue === 'view' ? 'view'
					: 'table';
				const connectionName =
					(item as any).connectionName ?? connectionManager.getActiveConnectionName();
				if (objectType === 'function' || objectType === 'procedure') {
					if (!connectionName) {
						vscode.window.showWarningMessage('Нет активного подключения для DDL.');
						return;
					}
					void openObjectDdlDocument(connectionName, schema, objectName, objectType);
				} else {
					void ObjectDetailsPanel.show(
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
			try {
				await vscode.commands.executeCommand('pgsqlTreeSearch.focus');
			} catch {
				// view may not be visible yet
			}
			treeSearchProvider.focusInput();
		}),
		vscode.commands.registerCommand('pgsql-tools.clearTreeSearch', async () => {
			await databaseTreeProvider.applySearch('');
			await treeSearchProvider.setFilterValue('');
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
			const connectionName = node.connectionName ?? connectionManager.getActiveConnectionName();
			const objectType = node.contextValue === 'function' ? 'function' 
				: node.contextValue === 'procedure' ? 'procedure' 
				: node.contextValue === 'view' ? 'view'
				: 'table';
			if (objectType === 'function' || objectType === 'procedure') {
				if (!connectionName) {
					vscode.window.showWarningMessage('Нет активного подключения для DDL.');
					return;
				}
				await openObjectDdlDocument(connectionName, schema, objectName, objectType);
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
				if (gitConnectionSettings.isCompareEnabled(name)) {
					gitStatusCache.scheduleRefresh(name);
				}
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
		const uriKey = doc.uri.toString();
		routineDdlOriginalText.delete(uriKey);
		for (const [key, uri] of openDdlDocumentsByKey) {
			if (uri === uriKey) {
				openDdlDocumentsByKey.delete(key);
				break;
			}
		}
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