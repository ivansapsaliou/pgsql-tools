import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
export declare class ConnectionsTreeProvider implements vscode.TreeDataProvider<ConnectionNode> {
    private connectionManager;
    private _onDidChangeTreeData;
    readonly onDidChangeTreeData: vscode.Event<ConnectionNode | undefined | null | void>;
    constructor(connectionManager: ConnectionManager);
    refresh(): void;
    getTreeItem(element: ConnectionNode): vscode.TreeItem;
    getChildren(element?: ConnectionNode): ConnectionNode[];
}
export declare class ConnectionNode {
    label: string;
    description: string | undefined;
    contextValue: string;
    icon: string;
    command?: vscode.Command | undefined;
    constructor(label: string, description: string | undefined, contextValue: string, icon: string, command?: vscode.Command | undefined);
}
//# sourceMappingURL=connectionsTreeProvider.d.ts.map