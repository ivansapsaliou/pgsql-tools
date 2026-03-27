import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor } from '../database/queryExecutor';

export type NodeKind =
	| 'connection'
	| 'connection_disconnected'
	| 'connection_active'
	| 'connection_group'
	| 'search'
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
		public parent?: TreeNode,
	) {}
}

export class PostgreSQLTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	// Событие двойного клика - будет использоваться в extension.ts
	private _onDidDoubleClick = new vscode.EventEmitter<TreeNode>();
	readonly onDidDoubleClick = this._onDidDoubleClick.event;
	private queryExecutor: QueryExecutor;
	private filterText: string = '';
	private searchIndex:
		| {
				connectionName: string;
				termLower: string;
				schemas: Set<string>;
				schemaGroups: Map<string, Set<NodeKind>>;
				schemaGroupObjects: Map<string, Map<NodeKind, Set<string>>>;
		  }
		| undefined;

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

	setFilterText(filterText: string): void {
		this.filterText = String(filterText ?? '').trim();
		// Index is built by applySearch(); keep refresh for legacy callers.
		this.searchIndex = undefined;
		this.refresh();
	}

	clearFilterText(): void {
		this.filterText = '';
		this.searchIndex = undefined;
		this.refresh();
	}

	getFilterText(): string {
		return this.filterText;
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		const item = new vscode.TreeItem(element.label, element.collapsibleState);
		item.contextValue = element.contextValue;

		const iconMap: Record<NodeKind, string> = {
			connection: 'database',
			connection_disconnected: 'circle-outline',
			connection_active: 'database',
			connection_group: 'server-environment',
			search: 'search',
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

		if (element.contextValue && element.contextValue !== 'search') {
			item.iconPath = new vscode.ThemeIcon(iconMap[element.contextValue] ?? 'circle-outline');
		}
		if (element.contextValue === 'search') {
			// Highlight the search text line.
			item.label = { label: element.label, highlights: [[0, element.label.length]] };
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

	getParent?(element: TreeNode): vscode.ProviderResult<TreeNode> {
		return element.parent;
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		const filterRaw = this.filterText.trim();
		const active = this.connectionManager.getActiveConnectionName();
		const filterActive = !!filterRaw && !!active && this.searchIndex?.termLower === filterRaw.toLowerCase() && this.searchIndex?.connectionName === active;

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
			const nodes = connections.map((name) => {
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
			// Search line appears only when search is used (filterRaw is non-empty)
			if (!filterRaw) return nodes;

			const searchLabel = filterRaw;
			const searchNode = new TreeNode(
				searchLabel,
				vscode.TreeItemCollapsibleState.None,
				'search',
				undefined,
				undefined,
				active ?? undefined,
				{
					command: 'pgsql-tools.searchTree',
					title: 'Search',
					arguments: [],
				}
			);
			return [searchNode, ...nodes];
		}

		// Search node has no children (we keep normal tree structure).
		if (element.contextValue === 'search') return [];

		// ── Connection: list schemas ──────────────────────────────────────────
		if (element.contextValue === 'connection' || element.contextValue === 'connection_disconnected') {
			const connName = element.connectionName ?? element.label.replace(/^● /, '');
			const client = this.connectionManager.getConnectionByName(connName);
			if (!client) {
				return [new TreeNode('Not connected', vscode.TreeItemCollapsibleState.None, 'noConnection', undefined, undefined, connName, undefined, undefined, 0, element)];
			}
			// Temporarily switch executor to use this client
			try {
				// If search is active, filter only inside ACTIVE connection.
				if (filterActive && connName === active && this.searchIndex) {
					const schemas = [...this.searchIndex.schemas].sort().map((schemaName) => {
						return new TreeNode(
							schemaName,
							vscode.TreeItemCollapsibleState.Collapsed,
							'schema',
							schemaName,
							undefined,
							connName,
							undefined,
							undefined,
							0,
							element
						);
					});
					return schemas.length
						? schemas
						: [new TreeNode('No matches', vscode.TreeItemCollapsibleState.None, undefined, undefined, undefined, connName, undefined, undefined, 0, element)];
				}

				const res = await this.queryExecutor.executeQueryOnClient(
					client,
					`SELECT schema_name FROM information_schema.schemata
					 WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
					 ORDER BY schema_name`
				);
				const schemas = res.rows.map(
					(r) =>
						new TreeNode(
							r.schema_name,
							vscode.TreeItemCollapsibleState.Collapsed,
							'schema',
							r.schema_name,
							undefined,
							connName,
							undefined,
							undefined,
							0,
							element
						)
				);
				return schemas;
			} catch {
				return [new TreeNode('Error loading schemas', vscode.TreeItemCollapsibleState.None, undefined, undefined, undefined, connName, undefined, undefined, 0, element)];
			}
		}

		// ── Schema: group nodes ───────────────────────────────────────────────
		if (element.contextValue === 'schema') {
			const schema = element.parentSchema!;
			const connName = element.connectionName!;
			if (filterActive && connName === active && this.searchIndex) {
				const kinds = this.searchIndex.schemaGroups.get(schema);
				if (!kinds || kinds.size === 0) return [];
				const inOrder: [string, NodeKind][] = [
					['Tables', 'group_tables'],
					['Views', 'group_views'],
					['Functions', 'group_functions'],
					['Procedures', 'group_procedures'],
					['Sequences', 'group_sequences'],
					['Types', 'group_types'],
					['Indexes', 'group_indexes'],
					['Triggers', 'group_triggers'],
				];
				return inOrder
					.filter(([, k]) => kinds.has(k))
					.map(([lbl, k]) => this.groupNode(lbl, k, schema, connName, element));
			}
			return [
				this.groupNode('Tables', 'group_tables', schema, connName, element),
				this.groupNode('Views', 'group_views', schema, connName, element),
				this.groupNode('Functions', 'group_functions', schema, connName, element),
				this.groupNode('Procedures', 'group_procedures', schema, connName, element),
				this.groupNode('Sequences', 'group_sequences', schema, connName, element),
				this.groupNode('Types', 'group_types', schema, connName, element),
				this.groupNode('Indexes', 'group_indexes', schema, connName, element),
				this.groupNode('Triggers', 'group_triggers', schema, connName, element),
			];
		}

		// ── Groups ────────────────────────────────────────────────────────────
		const { contextValue, parentSchema: schema, connectionName: connName } = element;
		if (!schema || !connName) return [];
		const client = this.connectionManager.getConnectionByName(connName);
		if (!client) return [];
		const eq = (q: string) => this.queryExecutor.executeQueryOnClient(client, q);
		const esc = (s: string) => s.replace(/'/g, "''");
		const termLower = filterRaw.toLowerCase();
		const want = (kind: NodeKind, name: string) => {
			if (!filterActive || connName !== active || !this.searchIndex) return true;
			const set = this.searchIndex.schemaGroupObjects.get(schema)?.get(kind);
			return !!set && set.has(name.toLowerCase());
		};

		try {
			switch (contextValue) {
				case 'group_tables': {
					const res = await eq(
						`SELECT table_name FROM information_schema.tables
						 WHERE table_schema = '${esc(schema)}' AND table_type = 'BASE TABLE'
						 ORDER BY table_name`
					);
					return res.rows
						.map((r) => {
						return new TreeNode(
							r.table_name,
							vscode.TreeItemCollapsibleState.Collapsed,
							'table',
							schema,
							r.table_name,
							connName,
							undefined,
							undefined,
							0,
							element
						);
						})
						.filter((n) => want('group_tables', String(n.parentTable ?? n.label)));
				}

				case 'group_views': {
					const res = await eq(
						`SELECT table_name FROM information_schema.views
						 WHERE table_schema = '${esc(schema)}'
						 ORDER BY table_name`
					);
					return res.rows
						.map((r) => {
						return new TreeNode(
							r.table_name,
							vscode.TreeItemCollapsibleState.Collapsed,
							'view',
							schema,
							r.table_name,
							connName,
							undefined,
							undefined,
							0,
							element
						);
						})
						.filter((n) => want('group_views', String(n.parentTable ?? n.label)));
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
					return res.rows
						.map((r) => {
						return new TreeNode(
							r.routine_name,
							vscode.TreeItemCollapsibleState.None,
							'function',
							schema,
							r.routine_name,
							connName,
							undefined,
							{ returnType: r.return_type, specificName: r.specific_name }
							,
							0,
							element
						);
						})
						.filter((n) => want('group_functions', String(n.parentTable ?? n.label)));
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
					return res.rows
						.map((r) => {
						return new TreeNode(
							r.routine_name,
							vscode.TreeItemCollapsibleState.None,
							'procedure',
							schema,
							r.routine_name,
							connName,
							undefined,
							{ returnType: r.return_type, specificName: r.specific_name }
							,
							0,
							element
						);
						})
						.filter((n) => want('group_procedures', String(n.parentTable ?? n.label)));
				}

				case 'group_sequences': {
					const res = await eq(
						`SELECT sequence_name FROM information_schema.sequences
						 WHERE sequence_schema = '${esc(schema)}'
						 ORDER BY sequence_name`
					);
					return res.rows
						.map(
						(r) =>
							new TreeNode(
								r.sequence_name,
								vscode.TreeItemCollapsibleState.None,
								'sequence',
								schema,
								undefined,
								connName,
								undefined,
								undefined,
								0,
								element
							)
						)
						.filter((n) => want('group_sequences', String(n.label)));
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
					return res.rows
						.map(
						(r) =>
							new TreeNode(
								`${r.typname} (${r.type_kind})`,
								vscode.TreeItemCollapsibleState.None,
								'type',
								schema,
								undefined,
								connName,
								undefined,
								undefined,
								0,
								element
							)
						)
						.filter((n) => want('group_types', String(n.label).split(' (')[0]));
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
					return res.rows
						.map((r) => {
						const badge = r.is_primary ? ' [PK]' : r.is_unique ? ' [UQ]' : '';
						return new TreeNode(
							`${r.index_name}${badge}`,
							vscode.TreeItemCollapsibleState.None,
							'index',
							schema,
							r.table_name,
							connName,
							undefined,
							undefined,
							0,
							element
						);
						})
						.filter((n) => want('group_indexes', String(n.label).split(' ')[0]));
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
					return rows
						.map(
						(r) =>
							new TreeNode(
								`${r.trigger_name} on ${r.event_object_table}`,
								vscode.TreeItemCollapsibleState.None,
								'trigger',
								schema,
								r.event_object_table,
								connName,
								undefined,
								undefined,
								0,
								element
							)
						)
						.filter((n) => want('group_triggers', String(n.label).split(' on ')[0]));
				}

				// ── Table / View columns ──────────────────────────────────────
				case 'table':
				case 'view': {
					// If searching, keep columns visible only when their parent object is in results.
					if (filterActive && connName === active && this.searchIndex) {
						const parentObj = element.parentTable ?? element.label;
						const allowed =
							this.searchIndex.schemaGroupObjects.get(schema)?.get(contextValue === 'table' ? 'group_tables' : 'group_views')?.has(String(parentObj).toLowerCase()) ??
							false;
						if (!allowed) return [];
					}
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
							connName,
							undefined,
							undefined,
							0,
							element
						);
					});
				}
			}
		} catch (err) {
			return [new TreeNode(`Error: ${err}`, vscode.TreeItemCollapsibleState.None, undefined, schema, undefined, connName, undefined, undefined, 0, element)];
		}

		return [];
	}

	private groupNode(
		label: string,
		kind: NodeKind,
		schema: string,
		connName: string,
		parent: TreeNode
	): TreeNode {
		return new TreeNode(
			label,
			vscode.TreeItemCollapsibleState.Collapsed,
			kind,
			schema,
			undefined,
			connName,
			undefined,
			undefined,
			0,
			parent
		);
	}

	private async searchAllObjectsOnClient(
		client: any,
		connName: string,
		filterLower: string
	): Promise<TreeNode[]> {
		const esc = (s: string) => s.replace(/'/g, "''");
		const f = esc(filterLower);
		const res = await this.queryExecutor.executeQueryOnClient(
			client,
			`
			WITH q AS (SELECT '${f}'::text AS f)
			SELECT kind, schema_name, obj_name, extra
			FROM (
				-- tables / views / sequences / indexes
				SELECT
					CASE c.relkind
						WHEN 'r' THEN 'table'
						WHEN 'p' THEN 'table'
						WHEN 'v' THEN 'view'
						WHEN 'm' THEN 'view'
						WHEN 'S' THEN 'sequence'
						WHEN 'i' THEN 'index'
						ELSE 'other'
					END AS kind,
					n.nspname AS schema_name,
					c.relname AS obj_name,
					CASE WHEN c.relkind = 'i' THEN (t.relname) ELSE NULL END AS extra
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				LEFT JOIN pg_index ix ON ix.indexrelid = c.oid
				LEFT JOIN pg_class t ON t.oid = ix.indrelid
				WHERE n.nspname NOT LIKE 'pg_%'
				  AND n.nspname <> 'information_schema'
				  AND c.relkind IN ('r','p','v','m','S','i')
				  AND lower(c.relname) LIKE '%' || (SELECT f FROM q) || '%'

				UNION ALL
				-- functions / procedures
				SELECT
					CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END AS kind,
					n.nspname AS schema_name,
					p.proname AS obj_name,
					NULL::text AS extra
				FROM pg_proc p
				JOIN pg_namespace n ON n.oid = p.pronamespace
				WHERE n.nspname NOT LIKE 'pg_%'
				  AND n.nspname <> 'information_schema'
				  AND lower(p.proname) LIKE '%' || (SELECT f FROM q) || '%'

				UNION ALL
				-- types
				SELECT
					'type' AS kind,
					n.nspname AS schema_name,
					t.typname AS obj_name,
					NULL::text AS extra
				FROM pg_type t
				JOIN pg_namespace n ON n.oid = t.typnamespace
				WHERE n.nspname NOT LIKE 'pg_%'
				  AND n.nspname <> 'information_schema'
				  AND t.typtype IN ('e','c','d')
				  AND lower(t.typname) LIKE '%' || (SELECT f FROM q) || '%'

				UNION ALL
				-- triggers
				SELECT
					'trigger' AS kind,
					n.nspname AS schema_name,
					tg.tgname AS obj_name,
					c.relname AS extra
				FROM pg_trigger tg
				JOIN pg_class c ON c.oid = tg.tgrelid
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE NOT tg.tgisinternal
				  AND n.nspname NOT LIKE 'pg_%'
				  AND n.nspname <> 'information_schema'
				  AND lower(tg.tgname) LIKE '%' || (SELECT f FROM q) || '%'
			) x
			WHERE kind <> 'other'
			ORDER BY schema_name, kind, obj_name
			LIMIT 500
			`
		);

		const kindToNodeKind = (k: string): NodeKind => {
			switch (k) {
				case 'table': return 'table';
				case 'view': return 'view';
				case 'function': return 'function';
				case 'procedure': return 'procedure';
				case 'sequence': return 'sequence';
				case 'type': return 'type';
				case 'index': return 'index';
				case 'trigger': return 'trigger';
				default: return 'table';
			}
		};

		return res.rows.map((r: any) => {
			const schema = String(r.schema_name ?? 'public');
			const obj = String(r.obj_name ?? '');
			const kind = String(r.kind ?? '');
			const extra = r.extra ? String(r.extra) : '';
			const label = extra ? `${obj} (${kind} on ${extra})` : `${obj} (${kind})`;

			return new TreeNode(
				label,
				vscode.TreeItemCollapsibleState.None,
				kindToNodeKind(kind),
				schema,
				obj,
				connName
			);
		});
	}

	async applySearch(term: string): Promise<void> {
		const t = String(term ?? '').trim();
		this.filterText = t;
		this.searchIndex = undefined;
		if (!t) {
			this.refresh();
			return;
		}
		const active = this.connectionManager.getActiveConnectionName();
		if (!active) {
			this.refresh();
			return;
		}
		const client = this.connectionManager.getConnectionByName(active);
		if (!client) {
			this.refresh();
			return;
		}
		const termLower = t.toLowerCase();
		const rows = await this.searchAllObjectsOnClient(client, active, termLower);

		const schemas = new Set<string>();
		const schemaGroups = new Map<string, Set<NodeKind>>();
		const schemaGroupObjects = new Map<string, Map<NodeKind, Set<string>>>();

		const kindToGroup: Record<NodeKind, NodeKind | undefined> = {
			connection: undefined,
			connection_disconnected: undefined,
			connection_active: undefined,
			connection_group: undefined,
			search: undefined,
			schema: undefined,
			group_tables: undefined,
			group_views: undefined,
			group_functions: undefined,
			group_procedures: undefined,
			group_sequences: undefined,
			group_types: undefined,
			group_indexes: undefined,
			group_triggers: undefined,
			table: 'group_tables',
			view: 'group_views',
			function: 'group_functions',
			procedure: 'group_procedures',
			sequence: 'group_sequences',
			type: 'group_types',
			index: 'group_indexes',
			trigger: 'group_triggers',
			column: undefined,
			noConnection: undefined,
			noConnections: undefined,
		};

		for (const n of rows) {
			const schema = String(n.parentSchema ?? '');
			const group = kindToGroup[n.contextValue ?? 'table'];
			if (!schema || !group) continue;

			schemas.add(schema);
			if (!schemaGroups.has(schema)) schemaGroups.set(schema, new Set());
			schemaGroups.get(schema)!.add(group);

			if (!schemaGroupObjects.has(schema)) schemaGroupObjects.set(schema, new Map());
			const gm = schemaGroupObjects.get(schema)!;
			if (!gm.has(group)) gm.set(group, new Set());

			let objName = '';
			if (n.contextValue === 'table' || n.contextValue === 'view' || n.contextValue === 'function' || n.contextValue === 'procedure') {
				objName = String(n.parentTable ?? '').trim();
			} else if (n.contextValue === 'sequence' || n.contextValue === 'index' || n.contextValue === 'trigger') {
				objName = String(n.label).split(' ')[0].trim();
				objName = objName.split(' on ')[0].trim();
			} else if (n.contextValue === 'type') {
				objName = String(n.label).split(' (')[0].trim();
			}
			if (objName) gm.get(group)!.add(objName.toLowerCase());
		}

		this.searchIndex = { connectionName: active, termLower, schemas, schemaGroups, schemaGroupObjects };
		this.refresh();
	}
}