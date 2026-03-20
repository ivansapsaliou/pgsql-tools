import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
export declare class ObjectDetailsPanel {
    private static currentPanel;
    static show(context: vscode.ExtensionContext, schema: string, objectName: string, objectType: string, queryExecutor: QueryExecutor, connectionManager: ConnectionManager): Promise<void>;
    private static getHtml;
    private static escapeHtml;
}
//# sourceMappingURL=objectDetailsPanel.d.ts.map