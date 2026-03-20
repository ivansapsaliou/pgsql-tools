import { ConnectionManager } from './connectionManager';
export interface QueryResult {
    rows: any[];
    rowCount: number;
    fields: any[];
}
export declare class QueryExecutor {
    private connectionManager;
    constructor(connectionManager: ConnectionManager);
    executeQuery(query: string): Promise<QueryResult>;
    getSchemata(): Promise<string[]>;
    getTables(schema: string): Promise<string[]>;
    getColumns(schema: string, table: string): Promise<any[]>;
    getTableDDL(schema: string, tableName: string): Promise<string>;
    getTableData(schema: string, tableName: string, limit?: number): Promise<QueryResult>;
}
//# sourceMappingURL=queryExecutor.d.ts.map