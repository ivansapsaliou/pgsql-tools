import * as vscode from 'vscode';
import {
	QueryExecutor,
	type RoutineParameterInfo,
} from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';

export interface ColumnInfo {
	name: string;
	type: string;
	nullable: boolean;
	comment: string | null;
}

export interface RelationInfo {
	schema: string;
	name: string;
	kind: 'table' | 'view';
	columns: ColumnInfo[];
}

/** @deprecated Use RelationInfo */
export interface TableInfo {
	schema: string;
	table: string;
	columns: ColumnInfo[];
}

/** @deprecated Use RelationInfo */
export interface ViewInfo {
	schema: string;
	name: string;
}

export interface RoutineInfo {
	schema: string;
	name: string;
	kind: 'function' | 'procedure';
	oid: number;
	identityArgs: string;
	specificName: string;
}

const DEFAULT_REFRESH_MS = 60_000;

function relationKey(schema: string, name: string): string {
	return `${schema}.${name}`;
}

export class SqlSchemaRegistry {
	private relations = new Map<string, RelationInfo>();
	private relationIndex = new Map<string, string>();
	private routines = new Map<string, RoutineInfo>();
	private routinesByName = new Map<string, RoutineInfo[]>();
	private routineParamCache = new Map<number, RoutineParameterInfo[]>();
	private lastRefresh = 0;
	private refreshInterval = DEFAULT_REFRESH_MS;
	private refreshing = false;
	private refreshWaiters: Array<() => void> = [];
	private readonly onDidRefreshEmitter = new vscode.EventEmitter<void>();
	readonly onDidRefresh = this.onDidRefreshEmitter.event;

	constructor(
		private queryExecutor: QueryExecutor,
		private connectionManager: ConnectionManager
	) {
		vscode.window.onDidChangeActiveTextEditor(() => {
			this.ensureFresh().catch(() => {});
		});
		this.applySettings();
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('pgsql-tools.intelliSense.refreshIntervalMs')) {
				this.applySettings();
			}
		});
	}

	private applySettings(): void {
		const ms = vscode.workspace
			.getConfiguration('pgsql-tools.intelliSense')
			.get<number>('refreshIntervalMs', DEFAULT_REFRESH_MS);
		this.refreshInterval = Math.max(5_000, ms);
	}

	isConnected(): boolean {
		return !!this.connectionManager.getActiveConnectionName();
	}

	isLoaded(): boolean {
		return this.relations.size > 0;
	}

	async ensureFresh(): Promise<boolean> {
		if (!this.isConnected()) {
			this.clear();
			return false;
		}
		if (this.refreshing) {
			await new Promise<void>((resolve) => this.refreshWaiters.push(resolve));
			return this.isLoaded();
		}
		if (Date.now() - this.lastRefresh < this.refreshInterval && this.isLoaded()) {
			return true;
		}
		await this.refresh();
		return this.isLoaded();
	}

	async refresh(): Promise<void> {
		if (this.refreshing) {
			await new Promise<void>((resolve) => this.refreshWaiters.push(resolve));
			return;
		}
		if (!this.isConnected()) {
			this.clear();
			return;
		}
		this.refreshing = true;
		try {
			const colsRes = await this.queryExecutor.executeQuery(`
				SELECT
					n.nspname                                                       AS table_schema,
					c.relname                                                       AS rel_name,
					c.relkind                                                       AS rel_kind,
					a.attname                                                       AS column_name,
					pg_catalog.format_type(a.atttypid, a.atttypmod)                AS col_type,
					NOT a.attnotnull                                                  AS nullable,
					col_description(c.oid, a.attnum)                               AS col_comment
				FROM pg_catalog.pg_attribute a
				JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
				JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind IN ('r', 'v', 'm')
				  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND a.attnum > 0 AND NOT a.attisdropped
				ORDER BY n.nspname, c.relname, a.attnum
			`);

			this.relations.clear();
			this.relationIndex.clear();

			for (const row of colsRes.rows) {
				const schema = String(row.table_schema);
				const name = String(row.rel_name);
				const kind: 'table' | 'view' =
					row.rel_kind === 'r' ? 'table' : 'view';
				const key = relationKey(schema, name);
				if (!this.relations.has(key)) {
					this.relations.set(key, { schema, name, kind, columns: [] });
					this.relationIndex.set(name.toLowerCase(), schema);
				}
				this.relations.get(key)!.columns.push({
					name: String(row.column_name),
					type: String(row.col_type),
					nullable: !!row.nullable,
					comment: row.col_comment != null ? String(row.col_comment) : null,
				});
			}

			const routinesRes = await this.queryExecutor.executeQuery(`
				SELECT
					n.nspname AS schema_name,
					p.proname AS name,
					p.prokind AS kind,
					p.oid,
					pg_get_function_identity_arguments(p.oid) AS identity_args,
					COALESCE(
						r.specific_name,
						p.proname || '_' || p.oid::text
					) AS specific_name
				FROM pg_proc p
				JOIN pg_namespace n ON n.oid = p.pronamespace
				LEFT JOIN information_schema.routines r
					ON r.specific_schema = n.nspname
					AND r.routine_name = p.proname
					AND r.specific_name = p.proname || '_' || p.oid::text
				WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
				  AND p.prokind IN ('f', 'p')
				ORDER BY n.nspname, p.proname, p.oid
			`);

			this.routines.clear();
			this.routinesByName.clear();
			this.routineParamCache.clear();

			for (const row of routinesRes.rows) {
				const schema = String(row.schema_name);
				const name = String(row.name);
				const kind: 'function' | 'procedure' =
					row.kind === 'p' ? 'procedure' : 'function';
				const info: RoutineInfo = {
					schema,
					name,
					kind,
					oid: Number(row.oid),
					identityArgs: String(row.identity_args ?? ''),
					specificName: String(row.specific_name),
				};
				const key = relationKey(schema, name) + ':' + info.oid;
				this.routines.set(key, info);
				const list = this.routinesByName.get(name.toLowerCase()) ?? [];
				list.push(info);
				this.routinesByName.set(name.toLowerCase(), list);
			}

			this.lastRefresh = Date.now();
			this.onDidRefreshEmitter.fire();
		} catch {
			this.clear();
		} finally {
			this.refreshing = false;
			const waiters = this.refreshWaiters;
			this.refreshWaiters = [];
			for (const w of waiters) {
				w();
			}
		}
	}

	clear(): void {
		this.relations.clear();
		this.relationIndex.clear();
		this.routines.clear();
		this.routinesByName.clear();
		this.routineParamCache.clear();
		this.lastRefresh = 0;
	}

	getColumns(schema: string, table: string): ColumnInfo[] {
		return this.getRelationColumns(schema, table);
	}

	getRelationColumns(schema: string, name: string): ColumnInfo[] {
		return this.relations.get(relationKey(schema, name))?.columns ?? [];
	}

	getColumn(schema: string, table: string, column: string): ColumnInfo | undefined {
		return this.getRelationColumns(schema, table).find(
			(c) => c.name.toLowerCase() === column.toLowerCase()
		);
	}

	getTableSchema(table: string): string | undefined {
		return this.relationIndex.get(table.toLowerCase());
	}

	getViewSchema(view: string): string | undefined {
		const schema = this.relationIndex.get(view.toLowerCase());
		if (!schema) {
			return undefined;
		}
		const rel = this.relations.get(relationKey(schema, view));
		return rel?.kind === 'view' ? schema : undefined;
	}

	getAllTables(): TableInfo[] {
		return this.getAllRelations()
			.filter((r) => r.kind === 'table')
			.map((r) => ({ schema: r.schema, table: r.name, columns: r.columns }));
	}

	getAllRelations(): RelationInfo[] {
		return Array.from(this.relations.values());
	}

	getAllRoutines(): RoutineInfo[] {
		return Array.from(this.routines.values());
	}

	findRoutinesByName(name: string, schema?: string): RoutineInfo[] {
		if (schema) {
			return Array.from(this.routines.values()).filter(
				(r) =>
					r.name.toLowerCase() === name.toLowerCase() &&
					r.schema.toLowerCase() === schema.toLowerCase()
			);
		}
		return this.routinesByName.get(name.toLowerCase()) ?? [];
	}

	getSchemas(): string[] {
		const set = new Set<string>();
		for (const r of this.relations.values()) {
			set.add(r.schema);
		}
		for (const r of this.routines.values()) {
			set.add(r.schema);
		}
		return [...set].sort();
	}

	findRelationsByPrefix(prefix: string): RelationInfo[] {
		const lower = prefix.toLowerCase();
		return this.getAllRelations().filter((r) =>
			r.name.toLowerCase().startsWith(lower)
		);
	}

	getTableIndex(): Map<string, string> {
		return this.relationIndex;
	}

	hasTable(schema: string, name: string): boolean {
		const rel = this.relations.get(relationKey(schema, name));
		return rel?.kind === 'table';
	}

	hasView(schema: string, name: string): boolean {
		const rel = this.relations.get(relationKey(schema, name));
		return rel?.kind === 'view';
	}

	findTable(schema: string | undefined, name: string): TableInfo | undefined {
		const rel = this.findRelation(schema, name);
		if (!rel || rel.kind !== 'table') {
			return undefined;
		}
		return { schema: rel.schema, table: rel.name, columns: rel.columns };
	}

	findView(schema: string | undefined, name: string): ViewInfo | undefined {
		const rel = this.findRelation(schema, name);
		if (!rel || rel.kind !== 'view') {
			return undefined;
		}
		return { schema: rel.schema, name: rel.name };
	}

	findRelation(schema: string | undefined, name: string): RelationInfo | undefined {
		if (schema) {
			return this.relations.get(relationKey(schema, name));
		}
		const s = this.relationIndex.get(name.toLowerCase());
		return s ? this.relations.get(relationKey(s, name)) : undefined;
	}

	findRoutine(schema: string | undefined, name: string): RoutineInfo | undefined {
		const list = this.findRoutinesByName(name, schema);
		return list[0];
	}

	async getRoutineParameters(oid: number, schema: string, specificName: string): Promise<RoutineParameterInfo[]> {
		const cached = this.routineParamCache.get(oid);
		if (cached) {
			return cached;
		}
		const client = this.connectionManager.getActiveConnection();
		if (!client) {
			return [];
		}
		const params = await this.queryExecutor.getRoutineParametersOnClient(
			client,
			schema,
			specificName,
			oid
		);
		this.routineParamCache.set(oid, params);
		return params;
	}

	hasSchema(name: string): boolean {
		const lower = name.toLowerCase();
		return this.getSchemas().some((s) => s.toLowerCase() === lower);
	}
}
