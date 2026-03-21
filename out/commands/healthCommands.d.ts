import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ResultsViewProvider } from '../views/resultsPanel';
export declare class HealthCommands {
    static registerAll(queryExecutor: QueryExecutor, connectionManager: ConnectionManager, resultsViewProvider: ResultsViewProvider): vscode.Disposable[];
    private static registerSlowQueries;
    private static registerLocks;
    private static registerSizes;
    private static registerVacuum;
}
//# sourceMappingURL=healthCommands.d.ts.map