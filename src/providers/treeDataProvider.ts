import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor } from '../database/queryExecutor';

export type NodeKind =
	| 'connection'
	| 'connection_disconnected'
	| 'connection_active'
	| 'connection_group'
	| 'schema'
	| 'group_tables'
	| 'group_views'
	| 'group_functions'
	| 'group_procedures'
	| 'group_sequences'
	| 'group_types'
	| 'group_indexes'
	| 'group_triggers'
	| 'table'
	| 'view'
	| 'function'
	| 'procedure'
	| 'sequence'
	| 'type'
	| 'index'
	| 'trigger'
	| 'column'
	| 'noConnection'
	| 'noConnections';

export class TreeNode {
	constructor(
		public label: string,
		public collapsibleState: vscode.TreeItemCollapsibleState,
		public contextValue?: NodeKind,
		public parentSchema?: string,
		public parentTable?: string,
		public connectionName?: string,
		public command?: vscode.Command,
		public meta?: Record<string, any>,
		public clickCount: number = 0,
	) {}
}

export class PostgreSQLTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	// Событие двойного клика - будет использоваться в extension.ts
	private _onDidDoubleClick = new vscode.EventEmitter<TreeNode>();
	readonly onDidDoubleClick = this._onDidDoubleClick.event;
	private queryExecutor: QueryExecutor;

	constructor(private connectionManager: ConnectionManager) {
		this.queryExecutor = new QueryExecutor(connectionManager);
	}

	// Метод для вызова события двойного клика
	handleDoubleClick(node: TreeNode): void {
		this._onDidDoubleClick.fire(node);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(null);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, element.collapsibleState);
		item.contextValue = element.contextValue;

		const iconMap: Record<NodeKind, string> = {
			connection: 'database',
			connection_disconnected: 'circle-outline',
			connection_active: 'database',
			connection_group: 'server-environment',
			schema: 'folder',
			group_tables: 'table',
			group_views: 'eye',
			group_functions: 'symbol-function',
			group_procedures: 'symbol-method',
			group_sequences: 'symbol-numeric',
			group_types: 'symbol-class',
			group_indexes: 'list-tree',
			group_triggers: 'zap',
			table: 'table',
			view: 'file-code',
			function: 'symbol-function',
			procedure: 'symbol-method',
			sequence: 'symbol-numeric',
			type: 'symbol-class',
			index: 'list-tree',
			trigger: 'zap',
			column: 'symbol-variable',
			noConnection: 'warning',
			noConnections: 'plug',
		};

		if (element.contextValue) {
			item.iconPath = new vscode.ThemeIcon(iconMap[element.contextValue] ?? 'circle-outline');
		}
		if (element.contextValue === 'connection_disconnected') {
			item.description = '(disconnected)';
		}

		// Active connection bullet
		if (element.contextValue === 'connection' && element.label === this.connectionManager.getActiveConnectionName()) {
			item.label = `● ${element.label}`;
			item.description = '(active)';
			item.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('terminal.ansiGreen'));
		}

		// Double-click to open table/view/function/procedure details
		// Команда НЕ устанавливается в item.command - она вызывается вручную в extension.ts
		// через обработчик onDidChangeSelection при обнаружении двойного клика.
		// Это позволяет открывать детали только по двойному клику, а не по одинарному.

		return item;
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		// ── Root: list all connections ────────────────────────────────────────
		if (!element) {
			const connections = this.connectionManager.getSavedConnectionNames();
			if (connections.length === 0) {
				return [
					new TreeNode(
						'No connections — click + to add',
						vscode.TreeItemCollapsibleState.None,
						'noConnections'
					),
				];
			}
			return connections.map((name) => {
				const isConnected = this.connectionManager.isConnected(name);
				return new TreeNode(
					name,
					isConnected
						? vscode.TreeItemCollapsibleState.Collapsed
						: vscode.TreeItemCollapsibleState.None,
					isConnected ? 'connection' : 'connection_disconnected',
					undefined,
					undefined,
					name
				);
			});
		}

		// ── Connection: list schemas ──────────────────────────────────────────
		if (element.contextValue === 'connection' || element.contextValue === 'connection_disconnected') {
			const connName = element.connectionName ?? element.label.replace(/^● /, '');
			const client = this.connectionManager.getConnectionByName(connName);
			if (!client) {
				return [new TreeNode('Not connected', vscode.TreeItemCollapsibleState.None, 'noConnection')];
			}
			// Temporarily switch executor to use this client
			try {
				const res = await this.queryExecutor.executeQueryOnClient(
					client,
					`SELECT schema_name FROM information_schema.schemata
					 WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
					 ORDER BY schema_name`
				);
				return res.rows.map(
					(r) =>
						new TreeNode(
							r.schema_name,
							vscode.TreeItemCollapsibleState.Collapsed,
							'schema',
							r.schema_name,
							undefined,
							connName
						)
				);
			} catch {
				return [new TreeNode('Error loading schemas', vscode.TreeItemCollapsibleState.None)];
			}
		}

		// ── Schema: group nodes ───────────────────────────────────────────────
		if (element.contextValue === 'schema') {
			const schema = element.parentSchema!;
			const connName = element.connectionName!;
			return [
				this.groupNode('Tables', 'group_tables', schema, connName),
				this.groupNode('Views', 'group_views', schema, connName),
				this.groupNode('Functions', 'group_functions', schema, connName),
				this.groupNode('Procedures', 'group_procedures', schema, connName),
				this.groupNode('Sequences', 'group_sequences', schema, connName),
				this.groupNode('Types', 'group_types', schema, connName),
				this.groupNode('Indexes', 'group_indexes', schema, connName),
				this.groupNode('Triggers', 'group_triggers', schema, connName),
			];
		}

		// ── Groups ────────────────────────────────────────────────────────────
		const { contextValue, parentSchema: schema, connectionName: connName } = element;
		if (!schema || !connName) return [];
		const client = this.connectionManager.getConnectionByName(connName);
		if (!client) return [];
		const eq = (q: string) => this.queryExecutor.executeQueryOnClient(client, q);
		const esc = (s: string) => s.replace(/'/g, "''");

		try {
			switch (contextValue) {
				case 'group_tables': {
					const res = await eq(
						`SELECT table_name FROM information_schema.tables
						 WHERE table_schema = '${esc(schema)}' AND table_type = 'BASE TABLE'
						 ORDER BY table_name`
					);
					return res.rows.map((r) => {
						return new TreeNode(
							r.table_name,
							vscode.TreeItemCollapsibleState.Collapsed,
							'table',
							schema,
							r.table_name,
							connName
						);
					});
				}

				case 'group_views': {
					const res = await eq(
						`SELECT table_name FROM information_schema.views
						 WHERE table_schema = '${esc(schema)}' ORDER BY table_name`
					);
					return res.rows.map((r) => {
						return new TreeNode(
							r.table_name,
							vscode.TreeItemCollapsibleState.Collapsed,
							'view',
							schema,
							r.table_name,
							connName
						);
					});
				}

				case 'group_functions': {
					const res = await eq(
						`SELECT routine_name, routine_type,
						        data_type AS return_type,
						        specific_name
						 FROM information_schema.routines
						 WHERE routine_schema = '${esc(schema)}'
						   AND routine_type = 'FUNCTION'
						 ORDER BY routine_name`
					);
					return res.rows.map((r) => {
						return new TreeNode(
							r.routine_name,
							vscode.TreeItemCollapsibleState.None,
							'function',
							schema,
							r.routine_name,
							connName,
							undefined,
							{ returnType: r.return_type, specificName: r.specific_name }
						);
					});
				}

				case 'group_procedures': {
					const res = await eq(
						`SELECT routine_name, routine_type,
						        data_type AS return_type,
						        specific_name
						 FROM information_schema.routines
						 WHERE routine_schema = '${esc(schema)}'
						   AND routine_type = 'PROCEDURE'
						 ORDER BY routine_name`
					);
					return res.rows.map((r) => {
						return new TreeNode(
							r.routine_name,
							vscode.TreeItemCollapsibleState.None,
							'procedure',
							schema,
							r.routine_name,
							connName,
							undefined,
							{ returnType: r.return_type, specificName: r.specific_name }
						);
					});
				}

				case 'group_sequences': {
					const res = await eq(
						`SELECT sequence_name FROM information_schema.sequences
						 WHERE sequence_schema = '${esc(schema)}' ORDER BY sequence_name`
					);
					return res.rows.map(
						(r) =>
							new TreeNode(
								r.sequence_name,
								vscode.TreeItemCollapsibleState.None,
								'sequence',
								schema,
								undefined,
								connName
							)
					);
				}

				case 'group_types': {
					const res = await eq(
						`SELECT t.typname,
						        CASE t.typtype
						            WHEN 'e' THEN 'enum'
						            WHEN 'c' THEN 'composite'
						            WHEN 'd' THEN 'domain'
						            ELSE 'other'
						        END AS type_kind
						 FROM pg_type t
						 JOIN pg_namespace n ON n.oid = t.typnamespace
						 WHERE n.nspname = '${esc(schema)}'
						   AND t.typtype IN ('e','c','d')
						   AND t.typname NOT LIKE '\\_%'
						 ORDER BY t.typname`
					);
					return res.rows.map(
						(r) =>
							new TreeNode(
								`${r.typname} (${r.type_kind})`,
								vscode.TreeItemCollapsibleState.None,
								'type',
								schema,
								undefined,
								connName
							)
					);
				}

				case 'group_indexes': {
					const res = await eq(
						`SELECT i.relname AS index_name,
						        t.relname AS table_name,
						        ix.indisunique AS is_unique,
						        ix.indisprimary AS is_primary
						 FROM pg_index ix
						 JOIN pg_class t ON t.oid = ix.indrelid
						 JOIN pg_class i ON i.oid = ix.indexrelid
						 JOIN pg_namespace n ON n.oid = t.relnamespace
						 WHERE n.nspname = '${esc(schema)}'
						 ORDER BY t.relname, i.relname`
					);
					return res.rows.map((r) => {
						const badge = r.is_primary ? ' [PK]' : r.is_unique ? ' [UQ]' : '';
						return new TreeNode(
							`${r.index_name}${badge}`,
							vscode.TreeItemCollapsibleState.None,
							'index',
							schema,
							r.table_name,
							connName
						);
					});
				}

				case 'group_triggers': {
					const res = await eq(
						`SELECT trigger_name, event_object_table, event_manipulation
						 FROM information_schema.triggers
						 WHERE trigger_schema = '${esc(schema)}'
						 ORDER BY trigger_name`
					);
					// Deduplicate (same trigger fires on multiple events)
					const seen = new Set<string>();
					const rows = res.rows.filter((r) => {
						const key = `${r.trigger_name}:${r.event_object_table}`;
						if (seen.has(key)) return false;
						seen.add(key);
						return true;
					});
					return rows.map(
						(r) =>
							new TreeNode(
								`${r.trigger_name} on ${r.event_object_table}`,
								vscode.TreeItemCollapsibleState.None,
								'trigger',
								schema,
								r.event_object_table,
								connName
							)
					);
				}

				// ── Table / View columns ──────────────────────────────────────
				case 'table':
				case 'view': {
					const objName = element.parentTable!;
					const res = await eq(
						`SELECT c.column_name, c.data_type, c.is_nullable,
						        (SELECT kcu.column_name
						         FROM information_schema.key_column_usage kcu
						         JOIN information_schema.table_constraints tc
						           ON tc.constraint_name = kcu.constraint_name
						           AND tc.table_schema = kcu.table_schema
						         WHERE tc.constraint_type = 'PRIMARY KEY'
						           AND tc.table_schema = '${esc(schema)}'
						           AND tc.table_name = '${esc(objName)}'
						           AND kcu.column_name = c.column_name
						         LIMIT 1) AS pk_col
						 FROM information_schema.columns c
						 WHERE c.table_schema = '${esc(schema)}' AND c.table_name = '${esc(objName)}'
						 ORDER BY c.ordinal_position`
					);
					return res.rows.map((r) => {
						const isPk = !!r.pk_col;
						const label = `${isPk ? '🔑 ' : ''}${r.column_name}: ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}`;
						return new TreeNode(
							label,
							vscode.TreeItemCollapsibleState.None,
							'column',
							schema,
							objName,
							connName
						);
					});
				}
			}
		} catch (err) {
			return [new TreeNode(`Error: ${err}`, vscode.TreeItemCollapsibleState.None)];
		}

		return [];
	}

	private groupNode(
		label: string,
		kind: NodeKind,
		schema: string,
		connName: string
	): TreeNode {
		return new TreeNode(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
			kind,
			schema,
			undefined,
			connName
		);
	}
}