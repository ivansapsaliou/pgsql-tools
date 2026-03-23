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

export class QueryExecutor {
	constructor(private connectionManager: ConnectionManager) {}

	async executeQuery(query: string): Promise<QueryResult> {
		const client = this.connectionManager.getActiveConnection();
		if (!client) {
			throw new Error('No active database connection');
		}
		return this.executeQueryOnClient(client, query);
	}

	/**
	 * Execute a query on a specific pg.Client (without changing the active connection).
	 */
	async executeQueryOnClient(client: pg.Client, query: string): Promise<QueryResult> {
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

	/**
	 * Builds a complete DDL using PostgreSQL system functions:
	 * - Columns: pg_catalog + format_type for accurate types + defaults
	 * - Constraints: pg_get_constraintdef (PK, UNIQUE, CHECK, FK)
	 * - Indexes: pg_get_indexdef (non-constraint indexes only)
	 * - Table comment: obj_description
	 */
	async getTableDDL(schema: string, tableName: string): Promise<string> {
		const e = (s: string) => s.replace(/'/g, "''");

		// ── 1. Columns ────────────────────────────────────────────────────────
		const colsRes = await this.executeQuery(`
			SELECT
				a.attname                                                   AS col,
				pg_catalog.format_type(a.atttypid, a.atttypmod)            AS col_type,
				a.attnotnull                                                AS notnull,
				pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)               AS col_default,
				col_description(c.oid, a.attnum)                           AS col_comment
			FROM   pg_catalog.pg_attribute  a
			JOIN   pg_catalog.pg_class      c  ON c.oid = a.attrelid
			JOIN   pg_catalog.pg_namespace  n  ON n.oid = c.relnamespace
			LEFT   JOIN pg_catalog.pg_attrdef ad
				   ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
			WHERE  n.nspname = '${e(schema)}'
			  AND  c.relname = '${e(tableName)}'
			  AND  a.attnum > 0
			  AND  NOT a.attisdropped
			ORDER  BY a.attnum
		`);

		const columnLines = colsRes.rows.map(row => {
			let line = `    "${row.col}" ${row.col_type}`;
			if (row.col_default !== null && row.col_default !== undefined) {
				line += ` DEFAULT ${row.col_default}`;
			}
			if (row.notnull) line += ' NOT NULL';
			return line;
		});

		// ── 2. Constraints (PK, UNIQUE, CHECK, FK) ───────────────────────────
		const conRes = await this.executeQuery(`
			SELECT
				con.conname                                              AS name,
				con.contype                                              AS type,
				pg_catalog.pg_get_constraintdef(con.oid, true)          AS def
			FROM   pg_catalog.pg_constraint con
			JOIN   pg_catalog.pg_class       c   ON c.oid = con.conrelid
			JOIN   pg_catalog.pg_namespace   n   ON n.oid = c.relnamespace
			WHERE  n.nspname = '${e(schema)}'
			  AND  c.relname = '${e(tableName)}'
			ORDER  BY
				CASE con.contype
					WHEN 'p' THEN 1   -- PRIMARY KEY first
					WHEN 'u' THEN 2   -- UNIQUE
					WHEN 'c' THEN 3   -- CHECK
					WHEN 'f' THEN 4   -- FOREIGN KEY last
					ELSE 5
				END,
				con.conname
		`);

		const constraintLines = conRes.rows.map(row =>
			`    CONSTRAINT "${row.name}" ${row.def}`
		);

		// ── 3. Assemble CREATE TABLE ──────────────────────────────────────────
		const tableLines = [...columnLines, ...constraintLines];
		let ddl = `CREATE TABLE "${schema}"."${tableName}" (\n`;
		ddl += tableLines.join(',\n');
		ddl += '\n);\n';

		// ── 4. Non-constraint indexes (CREATE INDEX) ──────────────────────────
		const idxRes = await this.executeQuery(`
			SELECT
				pg_catalog.pg_get_indexdef(ix.indexrelid, 0, true)   AS indexdef,
				i.relname                                              AS index_name
			FROM   pg_catalog.pg_index      ix
			JOIN   pg_catalog.pg_class      t   ON t.oid = ix.indrelid
			JOIN   pg_catalog.pg_class      i   ON i.oid = ix.indexrelid
			JOIN   pg_catalog.pg_namespace  n   ON n.oid = t.relnamespace
			LEFT   JOIN pg_catalog.pg_constraint con
				   ON con.conindid = ix.indexrelid
			WHERE  n.nspname = '${e(schema)}'
			  AND  t.relname = '${e(tableName)}'
			  AND  NOT ix.indisprimary
			  AND  con.conname IS NULL
			ORDER  BY i.relname
		`);

		if (idxRes.rows.length > 0) {
			ddl += '\n';
			ddl += idxRes.rows.map(row => row.indexdef + ';').join('\n');
			ddl += '\n';
		}

		// ── 5. Table comment ──────────────────────────────────────────────────
		const commentRes = await this.executeQuery(`
			SELECT obj_description(c.oid, 'pg_class') AS tbl_comment
			FROM   pg_catalog.pg_class     c
			JOIN   pg_catalog.pg_namespace n ON n.oid = c.relnamespace
			WHERE  n.nspname = '${e(schema)}'
			  AND  c.relname = '${e(tableName)}'
		`);

		const tblComment = commentRes.rows[0]?.tbl_comment;
		if (tblComment) {
			ddl += `\nCOMMENT ON TABLE "${schema}"."${tableName}" IS '${tblComment.replace(/'/g, "''")}';`;
		}

		// ── 6. Column comments ────────────────────────────────────────────────
		const colComments = colsRes.rows.filter(r => r.col_comment);
		if (colComments.length > 0) {
			ddl += '\n';
			ddl += colComments.map(r =>
				`COMMENT ON COLUMN "${schema}"."${tableName}"."${r.col}" IS '${String(r.col_comment).replace(/'/g, "''")}';`
			).join('\n');
		}

		return ddl;
	}

	async getTableData(schema: string, tableName: string, limit: number = 100, offset: number = 0): Promise<QueryResult> {
		return this.executeQuery(`SELECT * FROM "${schema}"."${tableName}" LIMIT ${limit} OFFSET ${offset}`);
	}

	async getTableRowCount(schema: string, tableName: string): Promise<number> {
		const result = await this.executeQuery(
			`SELECT COUNT(*) AS count FROM "${schema}"."${tableName}"`
		);
		return parseInt(result.rows[0]?.count ?? '0', 10);
	}

	async getIndexes(schema: string, tableName: string): Promise<IndexInfo[]> {
		const result = await this.executeQuery(`
			SELECT
				i.relname                                               AS index_name,
				ix.indisunique                                          AS is_unique,
				ix.indisprimary                                         AS is_primary,
				am.amname                                               AS index_type,
				array_agg(a.attname ORDER BY x.n)                      AS columns
			FROM   pg_catalog.pg_class      t
			JOIN   pg_catalog.pg_index      ix  ON t.oid = ix.indrelid
			JOIN   pg_catalog.pg_class      i   ON i.oid = ix.indexrelid
			JOIN   pg_catalog.pg_am         am  ON i.relam = am.oid
			JOIN   pg_catalog.pg_namespace  ns  ON t.relnamespace = ns.oid
			JOIN   LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n) ON TRUE
			JOIN   pg_catalog.pg_attribute  a
				   ON a.attrelid = t.oid AND a.attnum = x.attnum
			WHERE  ns.nspname = '${schema}'
			  AND  t.relname  = '${tableName}'
			GROUP  BY i.relname, ix.indisunique, ix.indisprimary, am.amname
			ORDER  BY ix.indisprimary DESC, i.relname
		`);

		return result.rows.map(row => ({
			name: row.index_name,
			columns: this.parseArray(row.columns),
			unique: row.is_unique,
			primary: row.is_primary,
			type: row.index_type.toUpperCase()
		}));
	}

	async getForeignKeys(schema: string, tableName: string): Promise<ForeignKeyInfo[]> {
		const outgoing = await this.executeQuery(`
			SELECT
				tc.constraint_name,
				array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns,
				ccu.table_schema  AS foreign_schema,
				ccu.table_name    AS foreign_table,
				array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS foreign_columns
			FROM information_schema.table_constraints        tc
			JOIN information_schema.key_column_usage         kcu
				 ON tc.constraint_name = kcu.constraint_name
				AND tc.table_schema    = kcu.table_schema
			JOIN information_schema.constraint_column_usage  ccu
				 ON ccu.constraint_name = tc.constraint_name
			WHERE tc.constraint_type = 'FOREIGN KEY'
			  AND tc.table_schema    = '${schema}'
			  AND tc.table_name      = '${tableName}'
			GROUP BY tc.constraint_name, ccu.table_schema, ccu.table_name
		`);

		const incoming = await this.executeQuery(`
			SELECT
				tc.constraint_name,
				tc.table_schema   AS foreign_schema,
				tc.table_name     AS foreign_table,
				array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS foreign_columns,
				array_agg(ccu.column_name ORDER BY kcu.ordinal_position) AS columns
			FROM information_schema.table_constraints        tc
			JOIN information_schema.key_column_usage         kcu
				 ON tc.constraint_name = kcu.constraint_name
				AND tc.table_schema    = kcu.table_schema
			JOIN information_schema.constraint_column_usage  ccu
				 ON ccu.constraint_name = tc.constraint_name
			WHERE tc.constraint_type = 'FOREIGN KEY'
			  AND ccu.table_schema   = '${schema}'
			  AND ccu.table_name     = '${tableName}'
			GROUP BY tc.constraint_name, tc.table_schema, tc.table_name
		`);

		return [
			...outgoing.rows.map(row => ({
				constraintName: row.constraint_name,
				columns: this.parseArray(row.columns),
				foreignSchema: row.foreign_schema,
				foreignTable: row.foreign_table,
				foreignColumns: this.parseArray(row.foreign_columns),
				direction: 'outgoing' as const
			})),
			...incoming.rows.map(row => ({
				constraintName: row.constraint_name,
				columns: this.parseArray(row.columns),
				foreignSchema: row.foreign_schema,
				foreignTable: row.foreign_table,
				foreignColumns: this.parseArray(row.foreign_columns),
				direction: 'incoming' as const
			}))
		];
	}

	async getConstraints(schema: string, tableName: string): Promise<ConstraintInfo[]> {
		const result = await this.executeQuery(`
			SELECT
				tc.constraint_name,
				tc.constraint_type,
				array_agg(kcu.column_name ORDER BY kcu.ordinal_position)
					FILTER (WHERE kcu.column_name IS NOT NULL)              AS columns,
				cc.check_clause
			FROM information_schema.table_constraints   tc
			LEFT JOIN information_schema.key_column_usage kcu
				 ON tc.constraint_name = kcu.constraint_name
				AND tc.table_schema    = kcu.table_schema
				AND tc.table_name      = kcu.table_name
			LEFT JOIN information_schema.check_constraints cc
				 ON cc.constraint_name  = tc.constraint_name
				AND cc.constraint_schema = tc.table_schema
			WHERE tc.table_schema = '${schema}'
			  AND tc.table_name   = '${tableName}'
			  AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'CHECK')
			GROUP BY tc.constraint_name, tc.constraint_type, cc.check_clause
			ORDER BY tc.constraint_type, tc.constraint_name
		`);

		return result.rows.map(row => ({
			name: row.constraint_name,
			type: row.constraint_type as ConstraintInfo['type'],
			columns: this.parseArray(row.columns),
			definition: row.check_clause
		}));
	}

	private parseArray(value: any): string[] {
		if (Array.isArray(value)) return value.filter(Boolean);
		if (typeof value === 'string') {
			return value.replace(/^\{|\}$/g, '').split(',').map(s => s.trim()).filter(Boolean);
		}
		return [];
	}
}