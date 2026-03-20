import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ResultsViewProvider } from './resultsPanel';
export declare class ObjectDetailsPanel {
    private static currentPanel;
    private static currentSchema;
    private static currentTable;
    static show(context: vscode.ExtensionContext, schema: string, objectName: string, objectType: string, queryExecutor: QueryExecutor, connectionManager: ConnectionManager, resultsViewProvider?: ResultsViewProvider): Promise<void>;
    private static getHtml;
    private static escapeHtml;
}
//# sourceMappingURL=objectDetailsPanel.d.ts.map