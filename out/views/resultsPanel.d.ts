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
export interface RichContent {
    type: 'html' | 'json' | 'erd';
    title: string;
    content: string;
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
    /**
     * Show rich content (html/json/erd) in the Results Panel.
     * Does not affect the existing table results — calling show() afterwards
     * will restore the interactive table view.
     */
    showRichContent(payload: RichContent): Promise<void>;
    private updateUI;
    private generateUpdateQueries;
    private exportToCSV;
    private exportToJSON;
    private saveToFile;
    private getHtml;
    private getRichHtml;
    private escapeHtml;
}
//# sourceMappingURL=resultsPanel.d.ts.map