import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
export declare class HealthCommands {
    static registerAll(queryExecutor: QueryExecutor, connectionManager: ConnectionManager, context: vscode.ExtensionContext): vscode.Disposable[];
}
//# sourceMappingURL=healthCommands.d.ts.map