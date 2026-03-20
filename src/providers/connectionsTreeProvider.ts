import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<ConnectionNode> {
	private _onDidChangeTreeData: vscode.EventEmitter<ConnectionNode | undefined | null | void> = new vscode.EventEmitter<ConnectionNode | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<ConnectionNode | undefined | null | void> = this._onDidChangeTreeData.event;

	constructor(private connectionManager: ConnectionManager) {}

	refresh(): void {
		this._onDidChangeTreeData.fire(null);
	}

	getTreeItem(element: ConnectionNode): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
		treeItem.contextValue = element.contextValue;
		treeItem.description = element.description;
		treeItem.iconPath = new vscode.ThemeIcon(element.icon);
		treeItem.command = element.command;
		
		if (this.connectionManager.getActiveConnectionName() === element.label) {
			treeItem.label = `● ${element.label}`;
			treeItem.description = '(Active)';
		}
		
		return treeItem;
	}

	getChildren(element?: ConnectionNode): ConnectionNode[] {
		if (!element) {
			// Root level - show all connections
			const connections = this.connectionManager.getConnections();
			if (connections.length === 0) {
				return [new ConnectionNode(
					'No connections',
					'Click + to add a connection',
					'noConnections',
					'database',
					undefined
				)];
			}
			return connections.map(name => 
				new ConnectionNode(
					name,
					'PostgreSQL Connection',
					'connection',
					'database',
					{
						command: 'pgsql-tools.selectConnection',
						title: 'Select Connection',
						arguments: [{ label: name }]
					}
				)
			);
		}
		return [];
	}
}

export class ConnectionNode {
	constructor(
		public label: string,
		public description: string | undefined,
		public contextValue: string,
		public icon: string,
		public command?: vscode.Command
	) {}
}