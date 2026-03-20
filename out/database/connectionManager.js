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
exports.ConnectionManager = void 0;
const vscode = __importStar(require("vscode"));
const pg = __importStar(require("pg"));
class ConnectionManager {
    constructor(context) {
        this.connections = new Map();
        this.activeConnection = null;
        this.context = context;
        this.config = vscode.workspace.getConfiguration('pgsqlTools');
        this.loadConnections();
    }
    async addConnection(config) {
        try {
            const client = new pg.Client({
                host: config.host,
                port: config.port,
                database: config.database,
                user: config.user,
                password: config.password
            });
            await client.connect();
            this.connections.set(config.name, client);
            this.activeConnection = config.name;
            this.saveConnection(config);
            return true;
        }
        catch (error) {
            vscode.window.showErrorMessage(`Connection failed: ${error}`);
            return false;
        }
    }
    async removeConnection(name) {
        const client = this.connections.get(name);
        if (client) {
            await client.end();
            this.connections.delete(name);
        }
        if (this.activeConnection === name) {
            this.activeConnection = this.connections.keys().next().value || null;
        }
        this.deleteConnectionConfig(name);
    }
    getActiveConnection() {
        if (this.activeConnection) {
            return this.connections.get(this.activeConnection) || null;
        }
        return null;
    }
    setActiveConnection(name) {
        if (this.connections.has(name)) {
            this.activeConnection = name;
        }
    }
    getConnections() {
        return Array.from(this.connections.keys());
    }
    getActiveConnectionName() {
        return this.activeConnection;
    }
    async closeAllConnections() {
        for (const client of this.connections.values()) {
            await client.end();
        }
        this.connections.clear();
    }
    saveConnection(config) {
        const connections = this.context.globalState.get('pgsqlConnections') || [];
        const index = connections.findIndex(c => c.name === config.name);
        if (index >= 0) {
            connections[index] = config;
        }
        else {
            connections.push(config);
        }
        this.context.globalState.update('pgsqlConnections', connections);
    }
    deleteConnectionConfig(name) {
        const connections = this.context.globalState.get('pgsqlConnections') || [];
        const filtered = connections.filter(c => c.name !== name);
        this.context.globalState.update('pgsqlConnections', filtered);
    }
    loadConnections() {
        const saved = this.context.globalState.get('pgsqlConnections') || [];
        // Connections are loaded but not automatically connected for security reasons
    }
}
exports.ConnectionManager = ConnectionManager;
//# sourceMappingURL=connectionManager.js.map