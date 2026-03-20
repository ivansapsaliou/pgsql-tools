import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
export declare class QueryEditorPanel {
    private static panel;
    private static currentQuery;
    static show(context: vscode.ExtensionContext, queryExecutor: QueryExecutor, connectionManager: ConnectionManager): void;
    private static getHtml;
}
//# sourceMappingURL=queryEditorPanel.d.ts.map