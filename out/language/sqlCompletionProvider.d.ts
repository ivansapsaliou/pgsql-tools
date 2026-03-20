import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
export declare class SQLCompletionProvider implements vscode.CompletionItemProvider {
    private queryExecutor;
    private connectionManager;
    private schemas;
    private tables;
    private columns;
    constructor(queryExecutor: QueryExecutor, connectionManager: ConnectionManager);
    private loadSchemaInfo;
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): Promise<vscode.CompletionItem[]>;
    resolveCompletionItem?(item: vscode.CompletionItem): vscode.CompletionItem;
    private getWordAt;
    refresh(): Promise<void>;
}
//# sourceMappingURL=sqlCompletionProvider.d.ts.map