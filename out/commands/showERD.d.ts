import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
export declare class ShowERDCommand {
    static register(queryExecutor: QueryExecutor, connectionManager: ConnectionManager, context: vscode.ExtensionContext): vscode.Disposable;
}
//# sourceMappingURL=showERD.d.ts.map