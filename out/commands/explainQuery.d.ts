import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ResultsViewProvider } from '../views/resultsPanel';
export declare class ExplainQueryCommand {
    static register(queryExecutor: QueryExecutor, connectionManager: ConnectionManager, resultsViewProvider: ResultsViewProvider): vscode.Disposable;
}
//# sourceMappingURL=explainQuery.d.ts.map