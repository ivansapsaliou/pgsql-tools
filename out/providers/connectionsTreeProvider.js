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
exports.ConnectionNode = exports.ConnectionsTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
class ConnectionsTreeProvider {
    constructor(connectionManager) {
        this.connectionManager = connectionManager;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    refresh() {
        this._onDidChangeTreeData.fire(null);
    }
    getTreeItem(element) {
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
    getChildren(element) {
        if (!element) {
            // Root level - show all connections
            const connections = this.connectionManager.getConnections();
            if (connections.length === 0) {
                return [new ConnectionNode('No connections', 'Click + to add a connection', 'noConnections', 'database', undefined)];
            }
            return connections.map(name => new ConnectionNode(name, 'PostgreSQL Connection', 'connection', 'database', {
                command: 'pgsql-tools.selectConnection',
                title: 'Select Connection',
                arguments: [{ label: name }]
            }));
        }
        return [];
    }
}
exports.ConnectionsTreeProvider = ConnectionsTreeProvider;
class ConnectionNode {
    constructor(label, description, contextValue, icon, command) {
        this.label = label;
        this.description = description;
        this.contextValue = contextValue;
        this.icon = icon;
        this.command = command;
    }
}
exports.ConnectionNode = ConnectionNode;
//# sourceMappingURL=connectionsTreeProvider.js.map