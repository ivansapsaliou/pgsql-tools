import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { PostgreSQLTreeDataProvider } from '../providers/treeDataProvider';
import { ConnectionsTreeProvider } from '../providers/connectionsTreeProvider';
import { ThemeManager } from '../theme/themeManager';
export declare class ConnectionWebview {
    private static panel;
    static show(context: vscode.ExtensionContext, connectionManager: ConnectionManager, databaseTreeProvider: PostgreSQLTreeDataProvider, connectionsTreeProvider: ConnectionsTreeProvider, themeManager: ThemeManager): void;
    private static getHtml;
}
//# sourceMappingURL=connectionWebview.d.ts.map