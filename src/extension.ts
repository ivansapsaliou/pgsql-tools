import * as vscode from 'vscode';
import { PostgreSQLTreeDataProvider } from './providers/treeDataProvider';
import { ConnectionManager } from './database/connectionManager';
import { QueryExecutor } from './database/queryExecutor';
import { ConnectionWebview } from './views/connectionWebview';
import { QueryEditorPanel } from './views/queryEditorPanel';
import { ObjectDetailsPanel } from './views/objectDetailsPanel';
import { ResultsViewProvider } from './views/resultsPanel';
import { SQLCompletionProvider } from './language/sqlCompletionProvider';
import { SqlSchemaRegistry } from './language/sqlSchemaRegistry';
import { registerSqlObjectLanguageFeatures } from './language/registerSqlObjectLanguageFeatures';
import { ObjectDdlEditor } from './services/objectDdlEditor';
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
import { PlpgsqlDebugViewProvider } from './views/plpgsqlDebugPanel';
import { PlpgsqlDebugSidebarProvider } from './views/plpgsqlDebugSidebar';
import { PlpgsqlDebugCommands } from './commands/plpgsqlDebug';
import { DebugBreakpointStore } from './debug/debugBreakpoints';
import { ddlDocumentKey } from './services/objectDdlEditor';

let connectionManager: ConnectionManager;
let databaseTreeProvider: PostgreSQLTreeDataProvider;
let queryExecutor: QueryExecutor;
let sqlCompletionProvider: SQLCompletionProvider;
let sqlSchemaRegistry: SqlSchemaRegistry;
let objectDdlEditor: ObjectDdlEditor;
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
let refreshConnectionUiRef: () => void = () => {};
let treeSearchProviderRef: TreeSearchWebviewProvider | undefined;
let databaseTreeViewRef: vscode.TreeView<TreeNode> | undefined;
let objectDdlEditorRef: ObjectDdlEditor | undefined;
let onGitSettingsChangedRef: () => void = () => {};
let updateConnectionStatusBarRef: () => void = () => {};
let refreshSqlConnectionCodeLensRef: () => void = () => {};
let plpgsqlDebugCommandsRef: PlpgsqlDebugCommands | undefined;
let openObjectDdlDocumentRef: (
	connectionName: string,
	schema: string,
	objectName: string,
	objectType: GitDdlObjectKind,
	specificName?: string
) => Promise<void> = async () => {};

function registerExtensionCommands(context: vscode.ExtensionContext): void {
	const commands = [
		vscode.commands.registerCommand('pgsql-tools.noop', () => undefined),
		vscode.commands.registerCommand('pgsql-tools.searchTree', async () => {
			try {
				await vscode.commands.executeCommand('pgsqlTreeSearch.focus');
			} catch {
				// view may not be visible yet
			}
			treeSearchProviderRef?.focusInput();
		}),
		vscode.commands.registerCommand('pgsql-tools.clearTreeSearch', async () => {
			await databaseTreeProvider.applySearch('');
			await treeSearchProviderRef?.setFilterValue('');
		}),
		vscode.commands.registerCommand('pgsql-tools.addConnection', () => {
			ConnectionWebview.show(context, connectionManager, () => refreshConnectionUiRef());
		}),
		vscode.commands.registerCommand('pgsql-tools.openQueryEditor', () => {
			QueryEditorPanel.show(context, queryExecutor, connectionManager);
		}),
		vscode.commands.registerCommand('pgsql-tools.editDDL', async () => {
			const doc = await vscode.workspace.openTextDocument({
				language: 'sql',
				content: '',
			});
			await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		}),
		vscode.commands.registerCommand('pgsql-tools.openQueryFile', async () => {
			const doc = await vscode.workspace.openTextDocument({
				language: 'sql',
				content: '',
			});
			await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
		}),
		vscode.commands.registerCommand('pgsql-tools.viewTableDetails', async (node: TreeNode) => {
			const schema = node.parentSchema || 'public';
			const objectName = node.parentTable || String(node.label);
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
				await openObjectDdlDocumentRef(
					connectionName,
					schema,
					objectName,
					objectType,
					node.meta?.specificName as string | undefined
				);
			} else {
				await ObjectDetailsPanel.show(
					context, schema, objectName, objectType,
					queryExecutor, connectionManager, resultsViewProvider
				);
			}
		}),
		vscode.commands.registerCommand('pgsql-tools.refreshDatabases', () => {
			refreshConnectionUiRef();
		}),
		vscode.commands.registerCommand('pgsql-tools.deleteConnection', async (node: any) => {
			const name = node?.connectionName ?? node?.label;
			if (!name) return;
			const confirm = await vscode.window.showWarningMessage(
				`Delete connection "${name}"?`, 'Delete', 'Cancel'
			);
			if (confirm === 'Delete') {
				await connectionManager.removeConnection(name);
				refreshConnectionUiRef();
				vscode.window.showInformationMessage(`Connection "${name}" deleted`);
			}
		}),
		vscode.commands.registerCommand('pgsql-tools.selectConnection', (node: any) => {
			const name = node?.connectionName ?? node?.label;
			if (!name) return;
			connectionManager.setActiveConnection(name);
			refreshConnectionUiRef();
			vscode.window.showInformationMessage(`Active connection: ${name}`);
		}),
		vscode.commands.registerCommand('pgsql-tools.connectConnection', async (node: any) => {
			const name = node?.connectionName ?? node?.label;
			if (!name) return;
			const ok = await connectionManager.connectSavedConnection(name);
			if (ok) {
				refreshConnectionUiRef();
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
			refreshConnectionUiRef();
			vscode.window.showInformationMessage(`Disconnected: ${name}`);
		}),
		ExecuteSqlFileCommand.register(queryExecutor, connectionManager, resultsViewProvider),
		SchemaDiffCommand.register(queryExecutor, connectionManager, context),
		...ShowERDCommand.register(queryExecutor, connectionManager, context),
		...HealthCommands.registerAll(queryExecutor, connectionManager, context),
		ExplainQueryCommand.register(queryExecutor, connectionManager, resultsViewProvider),
	];
	context.subscriptions.push(...commands);
	registerGitDdlCommands(
		context,
		connectionManager,
		gitConnectionSettings,
		gitStatusCache,
		() => databaseTreeViewRef,
		() => onGitSettingsChangedRef()
	);
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('pgsql-tools extension is now active!');

	try {
		await activateExtension(context);
	} catch (err) {
		console.error('pgsql-tools: activation failed', err);
		void vscode.window.showErrorMessage(
			`PostgreSQL Tools: ошибка активации: ${err instanceof Error ? err.message : String(err)}`
		);
	}
}

async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
	connectionManager = new ConnectionManager(context);
	const treeSearchSettings = new TreeSearchSettings(context);
	databaseTreeProvider = new PostgreSQLTreeDataProvider(connectionManager);
	databaseTreeProvider.setTreeSearchSettings(treeSearchSettings);
	queryExecutor = new QueryExecutor(connectionManager);
	sqlSchemaRegistry = new SqlSchemaRegistry(queryExecutor, connectionManager);
	sqlCompletionProvider = new SQLCompletionProvider(sqlSchemaRegistry);
	resultsViewProvider = new ResultsViewProvider(context.extensionUri);
	const plpgsqlDebugPanel = new PlpgsqlDebugViewProvider(context.extensionUri);
	const debugBreakpointStore = new DebugBreakpointStore(context);
	const plpgsqlDebugSidebar = new PlpgsqlDebugSidebarProvider(
		context.extensionUri,
		connectionManager,
		queryExecutor,
		debugBreakpointStore
	);
	plpgsqlDebugCommandsRef = new PlpgsqlDebugCommands(
		context,
		connectionManager,
		queryExecutor,
		plpgsqlDebugPanel,
		plpgsqlDebugSidebar,
		debugBreakpointStore
	);
	context.subscriptions.push(...plpgsqlDebugCommandsRef.register());

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

	registerExtensionCommands(context);

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
	try {
		await connectionManager.restoreConnections();
		databaseTreeProvider.refresh();
		if (gitStatusCache.hasAnyCompareEnabled()) {
			gitStatusCache.scheduleRefresh();
		}
	} catch (err) {
		console.error('pgsql-tools: restoreConnections failed', err);
		void vscode.window.showErrorMessage(
			`PostgreSQL Tools: не удалось восстановить подключения: ${err instanceof Error ? err.message : String(err)}`
		);
	}

	try {
		if (vscode.workspace.workspaceFolders?.length) {
			await vscode.workspace.getConfiguration('workbench').update(
				'tree.expandMode',
				'doubleClick',
				vscode.ConfigurationTarget.Workspace
			);
		}
	} catch (err) {
		console.warn('pgsql-tools: could not set workbench.tree.expandMode', err);
	}

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
	updateConnectionStatusBarRef = updateConnectionStatusBar;
	refreshSqlConnectionCodeLensRef = refreshSqlConnectionCodeLens;
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
		void treeSearchProviderRef?.refreshState();
	};
	refreshConnectionUiRef = refreshConnectionUi;
	objectDdlEditor = new ObjectDdlEditor(
		connectionManager,
		queryExecutor,
		openDdlDocumentsByKey,
		routineDdlOriginalText,
		routineDdlDecorationType,
		() => {
			updateConnectionStatusBar();
			refreshSqlConnectionCodeLens();
		}
	);
	const openObjectDdlDocument = async (
		connectionName: string,
		schema: string,
		objectName: string,
		objectType: GitDdlObjectKind,
		specificName?: string
	) => {
		await objectDdlEditor.open(connectionName, schema, objectName, objectType);
		const docKey = ddlDocumentKey(connectionName, schema, objectType, objectName);
		const uriStr = openDdlDocumentsByKey.get(docKey);
		if (!uriStr || !plpgsqlDebugCommandsRef) {
			return;
		}
		const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr);
		if (!doc) {
			return;
		}
		let spec = specificName;
		const client = connectionManager.getConnectionByName(connectionName);
		if (client && (objectType === 'function' || objectType === 'procedure')) {
			if (!spec) {
				try {
					const resolved = await queryExecutor.resolveRoutineOnClient(
						client,
						schema,
						objectName,
						objectType
					);
					if (resolved.length === 1) {
						spec = resolved[0].specificName;
					}
				} catch {
					/* ignore */
				}
			}
			if (spec) {
				plpgsqlDebugCommandsRef.attachRoutineMetadata(doc.uri, {
					connectionName,
					schema,
					objectName,
					objectType,
					specificName: spec,
				});
				plpgsqlDebugCommandsRef.updateBreakpointDecorations();
			}
		}
	};
	objectDdlEditorRef = objectDdlEditor;
	openObjectDdlDocumentRef = openObjectDdlDocument;
	plpgsqlDebugCommandsRef.setOpenRoutineDdl(openObjectDdlDocument);

	// Results Panel (нижняя панель)
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			ResultsViewProvider.viewType,
			resultsViewProvider,
			{ webviewOptions: { retainContextWhenHidden: true } }
		),
		vscode.window.registerWebviewViewProvider(
			PlpgsqlDebugViewProvider.viewType,
			plpgsqlDebugPanel,
			{ webviewOptions: { retainContextWhenHidden: true } }
		),
		vscode.window.registerWebviewViewProvider(
			PlpgsqlDebugSidebarProvider.viewType,
			plpgsqlDebugSidebar,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);

	// SQL автодополнение, подсветка объектов, hover, Ctrl+клик
	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider('sql', sqlCompletionProvider, '.', ' ', '\t')
	);
	registerSqlObjectLanguageFeatures(context, {
		schemaRegistry: sqlSchemaRegistry,
		queryExecutor,
		connectionManager,
		navigation: {
			showTableDetails: (schema, objectName, objectType) =>
				ObjectDetailsPanel.show(
					context,
					schema,
					objectName,
					objectType,
					queryExecutor,
					connectionManager,
					resultsViewProvider
				),
			openRoutineDdl: (connectionName, schema, objectName, objectType) =>
				openObjectDdlDocumentRef(connectionName, schema, objectName, objectType),
		},
	});
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
	databaseTreeViewRef = databaseTreeView;

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

	const rerunTreeSearch = async () => {
		const term = databaseTreeProvider.getFilterText().trim();
		if (term) {
			await databaseTreeProvider.applySearch(term);
			await revealSearchMatches();
		} else {
			databaseTreeProvider.refresh();
		}
		await treeSearchProviderRef?.refreshState();
	};

	treeSearchProviderRef = new TreeSearchWebviewProvider(context.extensionUri, {
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
			await treeSearchProviderRef!.refreshState();
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
			await treeSearchProviderRef!.refreshState();
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
			treeSearchProviderRef,
			{ webviewOptions: { retainContextWhenHidden: true } }
		)
	);
	onGitSettingsChangedRef = onGitSettingsChanged;

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
					const specificName = (item as TreeNode).meta?.specificName as string | undefined;
					void openObjectDdlDocument(connectionName, schema, objectName, objectType, specificName);
				} else {
					void ObjectDetailsPanel.show(
						context, schema, objectName, objectType,
						queryExecutor, connectionManager, resultsViewProvider
					);
				}
			}
		}
	});

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
		objectDdlEditor.updateDecorationsForEditor(editor);
	});
	const visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors((editors) => {
		for (const editor of editors) {
			objectDdlEditor.updateDecorationsForEditor(editor);
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