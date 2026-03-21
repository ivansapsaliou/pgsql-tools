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
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecuteSqlFileCommand = void 0;
const vscode = __importStar(require("vscode"));
class ExecuteSqlFileCommand {
    static register(queryExecutor, connectionManager, resultsViewProvider) {
        return vscode.commands.registerCommand('pgsql-tools.executeSqlFile', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showErrorMessage('No SQL file is open');
                return;
            }
            if (editor.document.languageId !== 'sql') {
                vscode.window.showErrorMessage('Current file is not a SQL file');
                return;
            }
            const activeConnection = connectionManager.getActiveConnectionName();
            if (!activeConnection) {
                vscode.window.showErrorMessage('No active database connection. Please select a connection first.');
                return;
            }
            // Get selected text or entire document
            let query = '';
            if (editor.selection.isEmpty) {
                query = editor.document.getText();
            }
            else {
                query = editor.document.getText(editor.selection);
            }
            query = query.trim();
            if (!query) {
                vscode.window.showErrorMessage('Query is empty');
                return;
            }
            try {
                const result = await queryExecutor.executeQuery(query);
                // Extract schema and table name if it's a simple SELECT
                let schema = 'public';
                let tableName = '';
                const tableMatch = query.match(/FROM\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i);
                if (tableMatch) {
                    schema = tableMatch[1] || 'public';
                    tableName = tableMatch[2];
                }
                // Show results in ResultsViewProvider (bottom panel)
                resultsViewProvider.show({
                    rows: result.rows,
                    columns: result.fields?.map(f => f.name) || [],
                    rowCount: result.rowCount || 0,
                    originalRows: JSON.parse(JSON.stringify(result.rows)),
                    schema: schema,
                    tableName: tableName
                }, queryExecutor, connectionManager);
                vscode.window.showInformationMessage(`✓ Query executed! ${result.rowCount} rows returned.`);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Query execution failed: ${errorMessage}`);
            }
        });
    }
}
exports.ExecuteSqlFileCommand = ExecuteSqlFileCommand;
//# sourceMappingURL=executeSqlFile.js.map