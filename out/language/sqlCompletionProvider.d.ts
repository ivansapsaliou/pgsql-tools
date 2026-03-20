import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
export declare class SQLCompletionProvider implements vscode.CompletionItemProvider {
    private queryExecutor;
    private connectionManager;
    private cache;
    private debounceTimer;
    constructor(queryExecutor: QueryExecutor, connectionManager: ConnectionManager);
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, _token: vscode.CancellationToken, _context: vscode.CompletionContext): Promise<vscode.CompletionItem[]>;
    private getQualifiedCompletions;
    private getContextColumnCompletions;
    private extractSelectColumns;
    /** Split comma-separated list respecting parens */
    private splitTopLevel;
    private columnItems;
    private getTableCompletions;
    private getSchemaCompletions;
    private getKeywordCompletions;
    private getFunctionCompletions;
    refresh(): Promise<void>;
}
//# sourceMappingURL=sqlCompletionProvider.d.ts.map