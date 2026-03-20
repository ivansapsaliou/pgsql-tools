import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor } from '../database/queryExecutor';

export class PostgreSQLTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
	private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> = new vscode.EventEmitter<TreeNode | undefined | null | void>();
	readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> = this._onDidChangeTreeData.event;

	private queryExecutor: QueryExecutor;

	constructor(private connectionManager: ConnectionManager) {
		this.queryExecutor = new QueryExecutor(connectionManager);
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(null);
	}

	getTreeItem(element: TreeNode): vscode.TreeItem {
		const treeItem = new vscode.TreeItem(element.label, element.collapsibleState);
		treeItem.contextValue = element.contextValue;
		
		// Add icons based on type
		const iconMap: { [key: string]: string } = {
			'schema': 'folder',
			'table': 'table',
			'column': 'symbol-variable',
			'view': 'file-code',
			'index': 'lightbulb'
		};

		if (element.contextValue && iconMap[element.contextValue]) {
			treeItem.iconPath = new vscode.ThemeIcon(iconMap[element.contextValue]);
		}

		// Add command for double-click
		if (element.contextValue === 'table') {
			treeItem.command = {
				command: 'pgsql-tools.viewTableDetails',
				title: 'View Table Details',
				arguments: [element]
			};
		}

		return treeItem;
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		const activeConnection = this.connectionManager.getActiveConnectionName();
		
		if (!activeConnection) {
			return [new TreeNode(
				'Select a connection',
				vscode.TreeItemCollapsibleState.None,
				'noConnection'
			)];
		}

		if (!element) {
			// Root level - show schemas
			try {
				const schemas = await this.queryExecutor.getSchemata();
				return schemas.map(schema => 
					new TreeNode(schema, vscode.TreeItemCollapsibleState.Collapsed, 'schema')
				);
			} catch (error) {
				return [new TreeNode(`Error: ${error}`, vscode.TreeItemCollapsibleState.None)];
			}
		}

		if (element.contextValue === 'schema') {
			// Get tables in schema
			try {
				const tables = await this.queryExecutor.getTables(element.label);
				return tables.map(table => 
					new TreeNode(
						table,
						vscode.TreeItemCollapsibleState.Collapsed,
						'table',
						element.label
					)
				);
			} catch (error) {
				return [new TreeNode(`Error: ${error}`, vscode.TreeItemCollapsibleState.None)];
			}
		}

		if (element.contextValue === 'table') {
			// Get columns in table
			try {
				const columns = await this.queryExecutor.getColumns(element.parentSchema || 'public', element.label);
				return columns.map(col => {
					const isPrimaryKey = col.constraint_type === 'PRIMARY KEY';
					const label = isPrimaryKey ? `🔑 ${col.column_name}` : col.column_name;
					return new TreeNode(
						`${label}: ${col.data_type}`,
						vscode.TreeItemCollapsibleState.None,
						'column',
						element.parentSchema || 'public'
					);
				});
			} catch (error) {
				return [new TreeNode(`Error: ${error}`, vscode.TreeItemCollapsibleState.None)];
			}
		}

		return [];
	}
}

export class TreeNode {
	constructor(
		public label: string,
		public collapsibleState: vscode.TreeItemCollapsibleState,
		public contextValue?: string,
		public parentSchema?: string,
		public command?: vscode.Command
	) {}
}