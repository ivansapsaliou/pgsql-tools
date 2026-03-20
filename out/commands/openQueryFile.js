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
exports.OpenQueryFileCommand = void 0;
const vscode = __importStar(require("vscode"));
class OpenQueryFileCommand {
    static register(queryExecutor, connectionManager) {
        return vscode.commands.registerCommand('pgsql-tools.openQueryFile', async () => {
            // Create a new untitled SQL file
            const document = await vscode.workspace.openTextDocument({
                language: 'sql',
                content: '-- PostgreSQL Query\n-- Connection: ' + (connectionManager.getActiveConnectionName() || 'Not selected') + '\n\nSELECT * FROM information_schema.tables LIMIT 10;\n'
            });
            await vscode.window.showTextDocument(document);
        });
    }
}
exports.OpenQueryFileCommand = OpenQueryFileCommand;
//# sourceMappingURL=openQueryFile.js.map