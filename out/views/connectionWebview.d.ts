import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
export declare class ConnectionWebview {
    private static panel;
    static show(context: vscode.ExtensionContext, connectionManager: ConnectionManager, onSuccess: () => void): void;
    private static getHtml;
}
//# sourceMappingURL=connectionWebview.d.ts.map