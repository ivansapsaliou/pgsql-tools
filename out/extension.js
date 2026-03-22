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
const connectionManager_1 = require("./database/connectionManager");
const queryExecutor_1 = require("./database/queryExecutor");
const connectionWebview_1 = require("./views/connectionWebview");
const queryEditorPanel_1 = require("./views/queryEditorPanel");
const objectDetailsPanel_1 = require("./views/objectDetailsPanel");
const resultsPanel_1 = require("./views/resultsPanel");
const sqlCompletionProvider_1 = require("./language/sqlCompletionProvider");
const sqlHoverProvider_1 = require("./language/sqlHoverProvider");
const executeSqlFile_1 = require("./commands/executeSqlFile");
const schemaDiff_1 = require("./commands/schemaDiff");
const showERD_1 = require("./commands/showERD");
const healthCommands_1 = require("./commands/healthCommands");
const explainQuery_1 = require("./commands/explainQuery");
let connectionManager;
let databaseTreeProvider;
let queryExecutor;
let sqlCompletionProvider;
let resultsViewProvider;
async function activate(context) {
    console.log('pgsql-tools extension is now active!');
    connectionManager = new connectionManager_1.ConnectionManager(context);
    databaseTreeProvider = new treeDataProvider_1.PostgreSQLTreeDataProvider(connectionManager);
    queryExecutor = new queryExecutor_1.QueryExecutor(connectionManager);
    sqlCompletionProvider = new sqlCompletionProvider_1.SQLCompletionProvider(queryExecutor, connectionManager);
    resultsViewProvider = new resultsPanel_1.ResultsViewProvider(context.extensionUri);
    vscode.commands.executeCommand('setContext', 'pgsqlToolsActive', true);
    // Восстанавливаем подключения из прошлой сессии
    await connectionManager.restoreConnections();
    databaseTreeProvider.refresh();
    // Results Panel (нижняя панель)
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(resultsPanel_1.ResultsViewProvider.viewType, resultsViewProvider, { webviewOptions: { retainContextWhenHidden: true } }));
    // SQL автодополнение и hover
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider('sql', sqlCompletionProvider, '.', ' ', '\t'));
    context.subscriptions.push(vscode.languages.registerHoverProvider('sql', new sqlHoverProvider_1.SQLHoverProvider()));
    // Единое дерево
    const databaseTreeView = vscode.window.createTreeView('pgsqlDatabases', {
        treeDataProvider: databaseTreeProvider,
        showCollapseAll: true,
    });
    const commands = [
        // ── Подключение ─────────────────────────────────────────────────────
        vscode.commands.registerCommand('pgsql-tools.addConnection', () => {
            connectionWebview_1.ConnectionWebview.show(context, connectionManager, () => {
                databaseTreeProvider.refresh();
                sqlCompletionProvider.refresh();
            });
        }),
        // ── Редактор запросов ────────────────────────────────────────────────
        vscode.commands.registerCommand('pgsql-tools.openQueryEditor', () => {
            queryEditorPanel_1.QueryEditorPanel.show(context, queryExecutor, connectionManager);
        }),
        vscode.commands.registerCommand('pgsql-tools.openQueryFile', async () => {
            const doc = await vscode.workspace.openTextDocument({
                language: 'sql',
                content: `-- PostgreSQL Query\n-- Connection: ${connectionManager.getActiveConnectionName() || 'Not selected'}\n\n`,
            });
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }),
        // ── Детали таблицы ───────────────────────────────────────────────────
        vscode.commands.registerCommand('pgsql-tools.viewTableDetails', async (node) => {
            const schema = node.parentSchema || 'public';
            const tableName = node.parentTable || node.label;
            await objectDetailsPanel_1.ObjectDetailsPanel.show(context, schema, tableName, 'table', queryExecutor, connectionManager, resultsViewProvider);
        }),
        // ── Refresh ──────────────────────────────────────────────────────────
        vscode.commands.registerCommand('pgsql-tools.refreshDatabases', () => {
            databaseTreeProvider.refresh();
            sqlCompletionProvider.refresh();
        }),
        // ── Управление подключениями ─────────────────────────────────────────
        vscode.commands.registerCommand('pgsql-tools.deleteConnection', async (node) => {
            const name = node?.connectionName ?? node?.label;
            if (!name)
                return;
            const confirm = await vscode.window.showWarningMessage(`Delete connection "${name}"?`, 'Delete', 'Cancel');
            if (confirm === 'Delete') {
                await connectionManager.removeConnection(name);
                databaseTreeProvider.refresh();
                sqlCompletionProvider.refresh();
                vscode.window.showInformationMessage(`Connection "${name}" deleted`);
            }
        }),
        vscode.commands.registerCommand('pgsql-tools.selectConnection', (node) => {
            const name = node?.connectionName ?? node?.label;
            if (!name)
                return;
            connectionManager.setActiveConnection(name);
            databaseTreeProvider.refresh();
            sqlCompletionProvider.refresh();
            vscode.window.showInformationMessage(`Active connection: ${name}`);
        }),
        // ── SQL выполнение (F9 / Ctrl+Shift+E) ──────────────────────────────
        executeSqlFile_1.ExecuteSqlFileCommand.register(queryExecutor, connectionManager, resultsViewProvider),
        // ── Schema Diff ──────────────────────────────────────────────────────
        schemaDiff_1.SchemaDiffCommand.register(queryExecutor, connectionManager, resultsViewProvider),
        // ── ERD (теперь отдельная панель) ────────────────────────────────────
        ...showERD_1.ShowERDCommand.register(queryExecutor, connectionManager, context),
        // ── Health ───────────────────────────────────────────────────────────
        ...healthCommands_1.HealthCommands.registerAll(queryExecutor, connectionManager, context),
        // ── Explain ──────────────────────────────────────────────────────────
        explainQuery_1.ExplainQueryCommand.register(queryExecutor, connectionManager, resultsViewProvider),
    ];
    const visibilityListener = databaseTreeView.onDidChangeVisibility((e) => {
        if (e.visible)
            databaseTreeProvider.refresh();
    });
    context.subscriptions.push(...commands, visibilityListener);
}
exports.activate = activate;
function deactivate() {
    connectionManager?.closeAllConnections();
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map