import * as pg from 'pg';
import { ConnectionManager } from './connectionManager';

export interface QueryResult {
	rows: any[];
	rowCount: number;
	fields: any[];
}

export class QueryExecutor {
	constructor(private connectionManager: ConnectionManager) {}

	async executeQuery(query: string): Promise<QueryResult> {
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
		} catch (error) {
			throw new Error(`Query execution failed: ${error}`);
		}
	}

	async getSchemata(): Promise<string[]> {
		const result = await this.executeQuery(
			"SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name != 'information_schema' ORDER BY schema_name"
		);
		return result.rows.map(row => row.schema_name);
	}

	async getTables(schema: string): Promise<string[]> {
		const result = await this.executeQuery(
			`SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_type = 'BASE TABLE' ORDER BY table_name`
		);
		return result.rows.map(row => row.table_name);
	}

	async getColumns(schema: string, table: string): Promise<any[]> {
		const result = await this.executeQuery(
			`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY ordinal_position`
		);
		return result.rows;
	}

	async getTableDDL(schema: string, tableName: string): Promise<string> {
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
		} catch (error) {
			throw new Error(`Failed to get table DDL: ${error}`);
		}
	}

	async getTableData(schema: string, tableName: string, limit: number = 100): Promise<QueryResult> {
		return this.executeQuery(`SELECT * FROM "${schema}"."${tableName}" LIMIT ${limit}`);
	}
}