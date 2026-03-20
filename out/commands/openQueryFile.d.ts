import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
export declare class OpenQueryFileCommand {
    static register(queryExecutor: QueryExecutor, connectionManager: ConnectionManager): vscode.Disposable;
}
//# sourceMappingURL=openQueryFile.d.ts.map