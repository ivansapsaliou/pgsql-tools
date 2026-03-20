import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ThemeManager } from '../theme/themeManager';
export declare class ObjectDetailsPanel {
    private static currentPanel;
    static show(context: vscode.ExtensionContext, schema: string, objectName: string, objectType: string, queryExecutor: QueryExecutor, connectionManager: ConnectionManager, themeManager: ThemeManager): Promise<void>;
    private static getTableHtml;
    private static escapeHtml;
}
//# sourceMappingURL=objectDetailsPanel.d.ts.map