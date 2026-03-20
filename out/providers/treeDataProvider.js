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
exports.TreeNode = exports.PostgreSQLTreeDataProvider = void 0;
const vscode = __importStar(require("vscode"));
const queryExecutor_1 = require("../database/queryExecutor");
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
        const treeItem = new vscode.TreeItem(element.label, element.collapsibleState);
        treeItem.contextValue = element.contextValue;
        // Add icons based on type
        const iconMap = {
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
    async getChildren(element) {
        const activeConnection = this.connectionManager.getActiveConnectionName();
        if (!activeConnection) {
            return [new TreeNode('Select a connection', vscode.TreeItemCollapsibleState.None, 'noConnection')];
        }
        if (!element) {
            // Root level - show schemas
            try {
                const schemas = await this.queryExecutor.getSchemata();
                return schemas.map(schema => new TreeNode(schema, vscode.TreeItemCollapsibleState.Collapsed, 'schema'));
            }
            catch (error) {
                return [new TreeNode(`Error: ${error}`, vscode.TreeItemCollapsibleState.None)];
            }
        }
        if (element.contextValue === 'schema') {
            // Get tables in schema
            try {
                const tables = await this.queryExecutor.getTables(element.label);
                return tables.map(table => new TreeNode(table, vscode.TreeItemCollapsibleState.Collapsed, 'table', element.label));
            }
            catch (error) {
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
                    return new TreeNode(`${label}: ${col.data_type}`, vscode.TreeItemCollapsibleState.None, 'column', element.parentSchema || 'public');
                });
            }
            catch (error) {
                return [new TreeNode(`Error: ${error}`, vscode.TreeItemCollapsibleState.None)];
            }
        }
        return [];
    }
}
exports.PostgreSQLTreeDataProvider = PostgreSQLTreeDataProvider;
class TreeNode {
    constructor(label, collapsibleState, contextValue, parentSchema, command) {
        this.label = label;
        this.collapsibleState = collapsibleState;
        this.contextValue = contextValue;
        this.parentSchema = parentSchema;
        this.command = command;
    }
}
exports.TreeNode = TreeNode;
//# sourceMappingURL=treeDataProvider.js.map