"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryExecutor = void 0;
class QueryExecutor {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
    }
    async executeQuery(query) {
        const client = this.connectionManager.getActiveConnection();
        if (!client) {
            throw new Error('No active database connection');
        }
        try {
            const result = await client.query(query);
            return {
                rows: result.rows,
                rowCount: result.rowCount || 0,
                fields: result.fields
            };
        }
        catch (error) {
            throw new Error(`Query execution failed: ${error}`);
        }
    }
    async getSchemata() {
        const result = await this.executeQuery("SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name != 'information_schema' ORDER BY schema_name");
        return result.rows.map(row => row.schema_name);
    }
    async getTables(schema) {
        const result = await this.executeQuery(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_type = 'BASE TABLE' ORDER BY table_name`);
        return result.rows.map(row => row.table_name);
    }
    async getColumns(schema, table) {
        const result = await this.executeQuery(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position`);
        return result.rows;
    }
    async getTableDDL(schema, tableName) {
        try {
            const result = await this.executeQuery(`
				SELECT 
					'CREATE TABLE ' || '${schema}.' || '${tableName}' || ' (' || chr(10) ||
					string_agg(
						'  ' || column_name || ' ' || data_type || 
						CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END,
						',' || chr(10)
					) || chr(10) || ');' as ddl
				FROM information_schema.columns
				WHERE table_schema = '${schema}' AND table_name = '${tableName}'
				GROUP BY table_schema, table_name
			`);
            return result.rows[0]?.ddl || '';
        }
        catch (error) {
            throw new Error(`Failed to get table DDL: ${error}`);
        }
    }
    async getTableData(schema, tableName, limit = 100) {
        return this.executeQuery(`SELECT * FROM "${schema}"."${tableName}" LIMIT ${limit}`);
    }
}
exports.QueryExecutor = QueryExecutor;
//# sourceMappingURL=queryExecutor.js.map