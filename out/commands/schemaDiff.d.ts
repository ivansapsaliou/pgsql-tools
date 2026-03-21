import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ResultsViewProvider } from '../views/resultsPanel';
export declare class SchemaDiffCommand {
    static register(queryExecutor: QueryExecutor, connectionManager: ConnectionManager, resultsViewProvider: ResultsViewProvider): vscode.Disposable;
}
//# sourceMappingURL=schemaDiff.d.ts.map