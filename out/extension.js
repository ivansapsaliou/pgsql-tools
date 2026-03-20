"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const treeDataProvider_1 = require("./providers/treeDataProvider");
const connectionsTreeProvider_1 = require("./providers/connectionsTreeProvider");
const connectionManager_1 = require("./database/connectionManager");
const queryExecutor_1 = require("./database/queryExecutor");
const connectionWebview_1 = require("./views/connectionWebview");
const queryEditorPanel_1 = require("./views/queryEditorPanel");
const objectDetailsPanel_1 = require("./views/objectDetailsPanel");
const resultsPanel_1 = require("./views/resultsPanel");
const themeManager_1 = require("./theme/themeManager");
const sqlCompletionProvider_1 = require("./language/sqlCompletionProvider");
const sqlHoverProvider_1 = require("./language/sqlHoverProvider");
const executeSqlFile_1 = require("./commands/executeSqlFile");
let connectionManager;
let databaseTreeProvider;
let connectionsTreeProvider;
let queryExecutor;
let themeManager;
let sqlCompletionProvider;
let resultsViewProvider;
function activate(context) {
    console.log('pgsql-tools extension is now active!');
    // Initialize managers
    connectionManager = new connectionManager_1.ConnectionManager(context);
    databaseTreeProvider = new treeDataProvider_1.PostgreSQLTreeDataProvider(connectionManager);
    connectionsTreeProvider = new connectionsTreeProvider_1.ConnectionsTreeProvider(connectionManager);
    queryExecutor = new queryExecutor_1.QueryExecutor(connectionManager);
    themeManager = new themeManager_1.ThemeManager();
    sqlCompletionProvider = new sqlCompletionProvider_1.SQLCompletionProvider(queryExecutor, connectionManager);
    resultsViewProvider = new resultsPanel_1.ResultsViewProvider(context.extensionUri);
    // Set context flag
    vscode.commands.executeCommand('setContext', 'pgsqlToolsActive', true);
    // Register WebviewViewProvider for Results Panel
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(resultsPanel_1.ResultsViewProvider.viewType, resultsViewProvider, { webviewOptions: { retainContextWhenHidden: true } }));
    // Register language providers
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider('sql', sqlCompletionProvider, '.', ' '));
    context.subscriptions.push(vscode.languages.registerHoverProvider('sql', new sqlHoverProvider_1.SQLHoverProvider()));
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
            connectionWebview_1.ConnectionWebview.show(context, connectionManager, databaseTreeProvider, connectionsTreeProvider, themeManager);
        }),
        vscode.commands.registerCommand('pgsql-tools.executeQuery', () => {
            queryEditorPanel_1.QueryEditorPanel.show(context, queryExecutor, connectionManager, themeManager);
        }),
        vscode.commands.registerCommand('pgsql-tools.openQueryFile', async () => {
            // Create a new untitled SQL file
            const document = await vscode.workspace.openTextDocument({
                language: 'sql',
                content: '-- PostgreSQL Query\n-- Connection: ' + (connectionManager.getActiveConnectionName() || 'Not selected') + '\n\nSELECT * FROM information_schema.tables LIMIT 10;\n'
            });
            await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
        }),
        vscode.commands.registerCommand('pgsql-tools.viewTableDetails', async (node) => {
            const schema = node.parentSchema || 'public';
            const tableName = node.label;
            await objectDetailsPanel_1.ObjectDetailsPanel.show(context, schema, tableName, 'table', queryExecutor, connectionManager, themeManager);
        }),
        vscode.commands.registerCommand('pgsql-tools.refreshDatabases', () => {
            databaseTreeProvider.refresh();
            sqlCompletionProvider.refresh();
        }),
        vscode.commands.registerCommand('pgsql-tools.deleteConnection', async (node) => {
            if (node && node.label) {
                const confirm = await vscode.window.showWarningMessage(`Delete connection "${node.label}"?`, 'Delete', 'Cancel');
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
        executeSqlFile_1.ExecuteSqlFileCommand.register(queryExecutor, connectionManager, resultsViewProvider)
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
    context.subscriptions.push(...commands, themeChangeListener, databaseViewVisibilityListener, connectionsViewVisibilityListener);
}
exports.activate = activate;
function deactivate() {
    connectionManager?.closeAllConnections();
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map