"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgreSQLTreeDataProvider = exports.TreeNode = void 0;
const vscode = __importStar(require("vscode"));
const queryExecutor_1 = require("../database/queryExecutor");
class TreeNode {
    constructor(label, collapsibleState, contextValue, parentSchema, parentTable, connectionName, command, meta) {
        this.label = label;
        this.collapsibleState = collapsibleState;
        this.contextValue = contextValue;
        this.parentSchema = parentSchema;
        this.parentTable = parentTable;
        this.connectionName = connectionName;
        this.command = command;
        this.meta = meta;
    }
}
exports.TreeNode = TreeNode;
class PostgreSQLTreeDataProvider {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this.queryExecutor = new queryExecutor_1.QueryExecutor(connectionManager);
    }
    refresh() {
        this._onDidChangeTreeData.fire(null);
    }
    getTreeItem(element) {
        const item = new vscode.TreeItem(element.label, element.collapsibleState);
        item.contextValue = element.contextValue;
        const iconMap = {
            connection: 'database',
            connection_active: 'database',
            connection_group: 'server-environment',
            schema: 'folder',
            group_tables: 'table',
            group_views: 'eye',
            group_functions: 'symbol-function',
            group_sequences: 'symbol-numeric',
            group_types: 'symbol-class',
            group_indexes: 'list-tree',
            group_triggers: 'zap',
            table: 'table',
            view: 'file-code',
            function: 'symbol-function',
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
        // Active connection bullet
        if (element.contextValue === 'connection' &&
            element.label === this.connectionManager.getActiveConnectionName()) {
            item.label = `● ${element.label}`;
            item.description = '(active)';
            item.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('terminal.ansiGreen'));
        }
        // Double-click to open table/view details
        if (element.contextValue === 'table' || element.contextValue === 'view') {
            item.command = element.command ?? {
                command: 'pgsql-tools.viewTableDetails',
                title: 'View Details',
                arguments: [element],
            };
        }
        return item;
    }
    async getChildren(element) {
        // ── Root: list all connections ────────────────────────────────────────
        if (!element) {
            const connections = this.connectionManager.getConnections();
            if (connections.length === 0) {
                return [
                    new TreeNode('No connections — click + to add', vscode.TreeItemCollapsibleState.None, 'noConnections'),
                ];
            }
            return connections.map((name) => new TreeNode(name, vscode.TreeItemCollapsibleState.Collapsed, 'connection', undefined, undefined, name));
        }
        // ── Connection: list schemas ──────────────────────────────────────────
        if (element.contextValue === 'connection') {
            const connName = element.connectionName ?? element.label.replace(/^● /, '');
            const client = this.connectionManager.getConnectionByName(connName);
            if (!client) {
                return [new TreeNode('Not connected', vscode.TreeItemCollapsibleState.None, 'noConnection')];
            }
            // Temporarily switch executor to use this client
            try {
                const res = await this.queryExecutor.executeQueryOnClient(client, `SELECT schema_name FROM information_schema.schemata
					 WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
					 ORDER BY schema_name`);
                return res.rows.map((r) => new TreeNode(r.schema_name, vscode.TreeItemCollapsibleState.Collapsed, 'schema', r.schema_name, undefined, connName));
            }
            catch {
                return [new TreeNode('Error loading schemas', vscode.TreeItemCollapsibleState.None)];
            }
        }
        // ── Schema: group nodes ───────────────────────────────────────────────
        if (element.contextValue === 'schema') {
            const schema = element.parentSchema;
            const connName = element.connectionName;
            return [
                this.groupNode('Tables', 'group_tables', schema, connName),
                this.groupNode('Views', 'group_views', schema, connName),
                this.groupNode('Functions', 'group_functions', schema, connName),
                this.groupNode('Sequences', 'group_sequences', schema, connName),
                this.groupNode('Types', 'group_types', schema, connName),
                this.groupNode('Indexes', 'group_indexes', schema, connName),
                this.groupNode('Triggers', 'group_triggers', schema, connName),
            ];
        }
        // ── Groups ────────────────────────────────────────────────────────────
        const { contextValue, parentSchema: schema, connectionName: connName } = element;
        if (!schema || !connName)
            return [];
        const client = this.connectionManager.getConnectionByName(connName);
        if (!client)
            return [];
        const eq = (q) => this.queryExecutor.executeQueryOnClient(client, q);
        const esc = (s) => s.replace(/'/g, "''");
        try {
            switch (contextValue) {
                case 'group_tables': {
                    const res = await eq(`SELECT table_name FROM information_schema.tables
						 WHERE table_schema = '${esc(schema)}' AND table_type = 'BASE TABLE'
						 ORDER BY table_name`);
                    return res.rows.map((r) => {
                        const n = new TreeNode(r.table_name, vscode.TreeItemCollapsibleState.Collapsed, 'table', schema, r.table_name, connName);
                        n.command = {
                            command: 'pgsql-tools.viewTableDetails',
                            title: 'View Table Details',
                            arguments: [n],
                        };
                        return n;
                    });
                }
                case 'group_views': {
                    const res = await eq(`SELECT table_name FROM information_schema.views
						 WHERE table_schema = '${esc(schema)}' ORDER BY table_name`);
                    return res.rows.map((r) => {
                        const n = new TreeNode(r.table_name, vscode.TreeItemCollapsibleState.Collapsed, 'view', schema, r.table_name, connName);
                        return n;
                    });
                }
                case 'group_functions': {
                    const res = await eq(`SELECT routine_name, routine_type,
						        data_type AS return_type,
						        specific_name
						 FROM information_schema.routines
						 WHERE routine_schema = '${esc(schema)}'
						   AND routine_type IN ('FUNCTION', 'PROCEDURE')
						 ORDER BY routine_name`);
                    return res.rows.map((r) => new TreeNode(r.routine_name, vscode.TreeItemCollapsibleState.None, 'function', schema, undefined, connName, undefined, { returnType: r.return_type, specificName: r.specific_name }));
                }
                case 'group_sequences': {
                    const res = await eq(`SELECT sequence_name FROM information_schema.sequences
						 WHERE sequence_schema = '${esc(schema)}' ORDER BY sequence_name`);
                    return res.rows.map((r) => new TreeNode(r.sequence_name, vscode.TreeItemCollapsibleState.None, 'sequence', schema, undefined, connName));
                }
                case 'group_types': {
                    const res = await eq(`SELECT t.typname,
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
						 ORDER BY t.typname`);
                    return res.rows.map((r) => new TreeNode(`${r.typname} (${r.type_kind})`, vscode.TreeItemCollapsibleState.None, 'type', schema, undefined, connName));
                }
                case 'group_indexes': {
                    const res = await eq(`SELECT i.relname AS index_name,
						        t.relname AS table_name,
						        ix.indisunique AS is_unique,
						        ix.indisprimary AS is_primary
						 FROM pg_index ix
						 JOIN pg_class t ON t.oid = ix.indrelid
						 JOIN pg_class i ON i.oid = ix.indexrelid
						 JOIN pg_namespace n ON n.oid = t.relnamespace
						 WHERE n.nspname = '${esc(schema)}'
						 ORDER BY t.relname, i.relname`);
                    return res.rows.map((r) => {
                        const badge = r.is_primary ? ' [PK]' : r.is_unique ? ' [UQ]' : '';
                        return new TreeNode(`${r.index_name}${badge}`, vscode.TreeItemCollapsibleState.None, 'index', schema, r.table_name, connName);
                    });
                }
                case 'group_triggers': {
                    const res = await eq(`SELECT trigger_name, event_object_table, event_manipulation
						 FROM information_schema.triggers
						 WHERE trigger_schema = '${esc(schema)}'
						 ORDER BY trigger_name`);
                    // Deduplicate (same trigger fires on multiple events)
                    const seen = new Set();
                    const rows = res.rows.filter((r) => {
                        const key = `${r.trigger_name}:${r.event_object_table}`;
                        if (seen.has(key))
                            return false;
                        seen.add(key);
                        return true;
                    });
                    return rows.map((r) => new TreeNode(`${r.trigger_name} on ${r.event_object_table}`, vscode.TreeItemCollapsibleState.None, 'trigger', schema, r.event_object_table, connName));
                }
                // ── Table / View columns ──────────────────────────────────────
                case 'table':
                case 'view': {
                    const objName = element.parentTable;
                    const res = await eq(`SELECT c.column_name, c.data_type, c.is_nullable,
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
						 ORDER BY c.ordinal_position`);
                    return res.rows.map((r) => {
                        const isPk = !!r.pk_col;
                        const label = `${isPk ? '🔑 ' : ''}${r.column_name}: ${r.data_type}${r.is_nullable === 'NO' ? ' NOT NULL' : ''}`;
                        return new TreeNode(label, vscode.TreeItemCollapsibleState.None, 'column', schema, objName, connName);
                    });
                }
            }
        }
        catch (err) {
            return [new TreeNode(`Error: ${err}`, vscode.TreeItemCollapsibleState.None)];
        }
        return [];
    }
    groupNode(label, kind, schema, connName) {
        return new TreeNode(label, vscode.TreeItemCollapsibleState.Collapsed, kind, schema, undefined, connName);
    }
}
exports.PostgreSQLTreeDataProvider = PostgreSQLTreeDataProvider;
//# sourceMappingURL=treeDataProvider.js.map