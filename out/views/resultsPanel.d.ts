import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
export interface QueryResultData {
    rows: any[];
    columns: string[];
    rowCount: number;
    originalRows: any[];
    schema?: string;
    tableName?: string;
}
export declare class ResultsViewProvider implements vscode.WebviewViewProvider {
    private readonly _extensionUri;
    static readonly viewType = "pgsqlResults";
    private _view?;
    private currentResults?;
    private queryExecutor?;
    private connectionManager?;
    constructor(_extensionUri: vscode.Uri);
    resolveWebviewView(webviewView: vscode.WebviewView, _context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken): void;
    show(results: QueryResultData, queryExecutor?: QueryExecutor, connectionManager?: ConnectionManager): Promise<void>;
    private updateUI;
    private generateUpdateQueries;
    private exportToCSV;
    private exportToJSON;
    private saveToFile;
    private getHtml;
    private escapeHtml;
}
//# sourceMappingURL=resultsPanel.d.ts.map