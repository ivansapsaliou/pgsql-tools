import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
export type NodeKind = 'connection' | 'connection_active' | 'connection_group' | 'schema' | 'group_tables' | 'group_views' | 'group_functions' | 'group_sequences' | 'group_types' | 'group_indexes' | 'group_triggers' | 'table' | 'view' | 'function' | 'sequence' | 'type' | 'index' | 'trigger' | 'column' | 'noConnection' | 'noConnections';
export declare class TreeNode {
    label: string;
    collapsibleState: vscode.TreeItemCollapsibleState;
    contextValue?: NodeKind | undefined;
    parentSchema?: string | undefined;
    parentTable?: string | undefined;
    connectionName?: string | undefined;
    command?: vscode.Command | undefined;
    meta?: Record<string, any> | undefined;
    constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, contextValue?: NodeKind | undefined, parentSchema?: string | undefined, parentTable?: string | undefined, connectionName?: string | undefined, command?: vscode.Command | undefined, meta?: Record<string, any> | undefined);
}
export declare class PostgreSQLTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private connectionManager;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<void | TreeNode | null | undefined>;
    private queryExecutor;
    constructor(connectionManager: ConnectionManager);
    refresh(): void;
    getTreeItem(element: TreeNode): vscode.TreeItem;
    getChildren(element?: TreeNode): Promise<TreeNode[]>;
    private groupNode;
}
//# sourceMappingURL=treeDataProvider.d.ts.map