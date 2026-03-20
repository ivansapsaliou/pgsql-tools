import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
export declare class PostgreSQLTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private connectionManager;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void>;
    private queryExecutor;
    constructor(connectionManager: ConnectionManager);
    refresh(): void;
    getTreeItem(element: TreeNode): vscode.TreeItem;
    getChildren(element?: TreeNode): Promise<TreeNode[]>;
}
export declare class TreeNode {
    label: string;
    collapsibleState: vscode.TreeItemCollapsibleState;
    contextValue?: string | undefined;
    parentSchema?: string | undefined;
    command?: vscode.Command | undefined;
    constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, contextValue?: string | undefined, parentSchema?: string | undefined, command?: vscode.Command | undefined);
}
//# sourceMappingURL=treeDataProvider.d.ts.map