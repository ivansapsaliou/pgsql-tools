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
exports.ShowERDCommand = void 0;
const vscode = __importStar(require("vscode"));
const erdPanel_1 = require("../views/erdPanel");
class ShowERDCommand {
    static register(queryExecutor, connectionManager, context) {
        const disposables = [];
        // ── Полная схема / выбор режима ──────────────────────────
        disposables.push(vscode.commands.registerCommand('pgsql-tools.showERD', async (node) => {
            const connName = node?.connectionName ?? connectionManager.getActiveConnectionName() ?? undefined;
            await erdPanel_1.ERDPanel.show(context, queryExecutor, connectionManager, connName);
        }));
        // ── От конкретной таблицы (из контекстного меню дерева) ──
        disposables.push(vscode.commands.registerCommand('pgsql-tools.showERDFromTable', async (node) => {
            const connName = node?.connectionName ?? connectionManager.getActiveConnectionName() ?? undefined;
            const schema = node?.parentSchema ?? 'public';
            const tableName = node?.parentTable ?? node?.label ?? '';
            if (!tableName) {
                vscode.window.showErrorMessage('No table selected.');
                return;
            }
            await erdPanel_1.ERDPanel.showFromTable(context, queryExecutor, connectionManager, schema, tableName, connName);
        }));
        return disposables;
    }
}
exports.ShowERDCommand = ShowERDCommand;
//# sourceMappingURL=showERD.js.map