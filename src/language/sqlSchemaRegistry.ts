import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';

export interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
	comment: string | null;
}

export interface TableInfo {
	schema: string;
	table: string;
	columns: ColumnInfo[];
}

export interface ViewInfo {
	schema: string;
	name: string;
}

export interface RoutineInfo {
	schema: string;
	name: string;
	kind: 'function' | 'procedure';
}

export class SqlSchemaRegistry {
	private tables = new Map<string, TableInfo>();
	private tableIndex = new Map<string, string>();
	private views = new Map<string, ViewInfo>();
	private viewIndex = new Map<string, string>();
	private routines = new Map<string, RoutineInfo>();
	private routineIndex = new Map<string, RoutineInfo>();
	private lastRefresh = 0;
	private refreshInterval = 60_000;
	private refreshing = false;
	private readonly onDidRefreshEmitter = new vscode.EventEmitter<void>();
	readonly onDidRefresh = this.onDidRefreshEmitter.event;

	constructor(
		private queryExecutor: QueryExecutor,
		private connectionManager: ConnectionManager
	) {
		vscode.window.onDidChangeActiveTextEditor(() => {
			this.ensureFresh().catch(() => {});
		});
	}

	async ensureFresh(): Promise<void> {
		if (this.refreshing) {
			return;
		}
		if (Date.now() - this.lastRefresh < this.refreshInterval && this.tables.size > 0) {
			return;
		}
		if (!this.connectionManager.getActiveConnectionName()) {
			return;
		}
		await this.refresh();
	}

	async refresh(): Promise<void> {
		if (this.refreshing) {
			return;
		}
		this.refreshing = true;
		try {
			const colsRes = await this.queryExecutor.executeQuery(`
				SELECT
					n.nspname                                                       AS table_schema,
					c.relname                                                       AS table_name,
					a.attname                                                       AS column_name,
					pg_catalog.format_type(a.atttypid, a.atttypmod)                AS col_type,
					NOT a.attnotnull                                                  AS nullable,
					col_description(c.oid, a.attnum)                               AS col_comment
				FROM pg_catalog.pg_attribute a
				JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
				JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind = 'r'
				  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND a.attnum > 0 AND NOT a.attisdropped
				ORDER BY n.nspname, c.relname, a.attnum
			`);

			this.tables.clear();
			this.tableIndex.clear();

			for (const row of colsRes.rows) {
				const schema = String(row.table_schema);
				const table = String(row.table_name);
				const key = `${schema}.${table}`;
				if (!this.tables.has(key)) {
					this.tables.set(key, { schema, table, columns: [] });
					this.tableIndex.set(table.toLowerCase(), schema);
				}
				this.tables.get(key)!.columns.push({
					name: String(row.column_name),
					type: String(row.col_type),
					nullable: !!row.nullable,
					comment: row.col_comment != null ? String(row.col_comment) : null,
				});
			}

			const viewsRes = await this.queryExecutor.executeQuery(`
				SELECT table_schema, table_name
				FROM information_schema.views
				WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
				ORDER BY table_schema, table_name
			`);

			this.views.clear();
			this.viewIndex.clear();
			for (const row of viewsRes.rows) {
				const schema = String(row.table_schema);
				const name = String(row.table_name);
				const key = `${schema}.${name}`;
				const info: ViewInfo = { schema, name };
				this.views.set(key, info);
				this.viewIndex.set(name.toLowerCase(), schema);
			}

			const routinesRes = await this.queryExecutor.executeQuery(`
				SELECT n.nspname AS schema_name, p.proname AS name, p.prokind AS kind
				FROM pg_proc p
				JOIN pg_namespace n ON n.oid = p.pronamespace
				WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND p.prokind IN ('f', 'p')
				ORDER BY n.nspname, p.proname
			`);

			this.routines.clear();
			this.routineIndex.clear();
			for (const row of routinesRes.rows) {
				const schema = String(row.schema_name);
				const name = String(row.name);
				const kind: 'function' | 'procedure' =
					row.kind === 'p' ? 'procedure' : 'function';
				const info: RoutineInfo = { schema, name, kind };
				const key = `${schema}.${name}`;
				this.routines.set(key, info);
				this.routineIndex.set(name.toLowerCase(), info);
			}

			this.lastRefresh = Date.now();
			this.onDidRefreshEmitter.fire();
		} catch {
			// no active connection
		} finally {
			this.refreshing = false;
		}
	}

	clear(): void {
		this.tables.clear();
		this.tableIndex.clear();
		this.views.clear();
		this.viewIndex.clear();
		this.routines.clear();
		this.routineIndex.clear();
		this.lastRefresh = 0;
	}

	getColumns(schema: string, table: string): ColumnInfo[] {
		return this.tables.get(`${schema}.${table}`)?.columns ?? [];
	}

	getColumn(schema: string, table: string, column: string): ColumnInfo | undefined {
		return this.getColumns(schema, table).find(
			(c) => c.name.toLowerCase() === column.toLowerCase()
		);
	}

	getTableSchema(table: string): string | undefined {
		return this.tableIndex.get(table.toLowerCase());
	}

	getViewSchema(view: string): string | undefined {
		return this.viewIndex.get(view.toLowerCase());
	}

	getAllTables(): TableInfo[] {
		return Array.from(this.tables.values());
	}

	getTableIndex(): Map<string, string> {
		return this.tableIndex;
	}

	hasTable(schema: string, name: string): boolean {
		return this.tables.has(`${schema}.${name}`);
	}

	hasView(schema: string, name: string): boolean {
		return this.views.has(`${schema}.${name}`);
	}

	findTable(schema: string | undefined, name: string): TableInfo | undefined {
		if (schema) {
			return this.tables.get(`${schema}.${name}`);
		}
		const s = this.tableIndex.get(name.toLowerCase());
		return s ? this.tables.get(`${s}.${name}`) : undefined;
	}

	findView(schema: string | undefined, name: string): ViewInfo | undefined {
		if (schema) {
			return this.views.get(`${schema}.${name}`);
		}
		const s = this.viewIndex.get(name.toLowerCase());
		return s ? this.views.get(`${s}.${name}`) : undefined;
	}

	findRoutine(
		schema: string | undefined,
		name: string
	): RoutineInfo | undefined {
		if (schema) {
			return this.routines.get(`${schema}.${name}`);
		}
		return this.routineIndex.get(name.toLowerCase());
	}

	hasSchema(name: string): boolean {
		const lower = name.toLowerCase();
		for (const t of this.tables.values()) {
			if (t.schema.toLowerCase() === lower) {
				return true;
			}
		}
		for (const v of this.views.values()) {
			if (v.schema.toLowerCase() === lower) {
				return true;
			}
		}
		for (const r of this.routines.values()) {
			if (r.schema.toLowerCase() === lower) {
				return true;
			}
		}
		return false;
	}
}
