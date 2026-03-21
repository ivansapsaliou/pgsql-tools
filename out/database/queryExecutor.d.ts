import * as pg from 'pg';
import { ConnectionManager } from './connectionManager';
export interface QueryResult {
    rows: any[];
    rowCount: number;
    fields: any[];
}
export interface IndexInfo {
    name: string;
    columns: string[];
    unique: boolean;
    type: string;
    primary: boolean;
}
export interface ForeignKeyInfo {
    constraintName: string;
    columns: string[];
    foreignSchema: string;
    foreignTable: string;
    foreignColumns: string[];
    direction: 'outgoing' | 'incoming';
}
export interface ConstraintInfo {
    name: string;
    type: 'PRIMARY KEY' | 'UNIQUE' | 'CHECK' | 'FOREIGN KEY';
    columns: string[];
    definition?: string;
}
export declare class QueryExecutor {
    private connectionManager;
    constructor(connectionManager: ConnectionManager);
    executeQuery(query: string): Promise<QueryResult>;
    /**
     * Execute a query on a specific pg.Client (without changing the active connection).
     */
    executeQueryOnClient(client: pg.Client, query: string): Promise<QueryResult>;
    getSchemata(): Promise<string[]>;
    getTables(schema: string): Promise<string[]>;
    getColumns(schema: string, table: string): Promise<any[]>;
    /**
     * Builds a complete DDL using PostgreSQL system functions:
     * - Columns: pg_catalog + format_type for accurate types + defaults
     * - Constraints: pg_get_constraintdef (PK, UNIQUE, CHECK, FK)
     * - Indexes: pg_get_indexdef (non-constraint indexes only)
     * - Table comment: obj_description
     */
    getTableDDL(schema: string, tableName: string): Promise<string>;
    getTableData(schema: string, tableName: string, limit?: number, offset?: number): Promise<QueryResult>;
    getTableRowCount(schema: string, tableName: string): Promise<number>;
    getIndexes(schema: string, tableName: string): Promise<IndexInfo[]>;
    getForeignKeys(schema: string, tableName: string): Promise<ForeignKeyInfo[]>;
    getConstraints(schema: string, tableName: string): Promise<ConstraintInfo[]>;
    private parseArray;
}
//# sourceMappingURL=queryExecutor.d.ts.map