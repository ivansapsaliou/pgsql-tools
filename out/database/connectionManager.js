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
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionManager = void 0;
const vscode = __importStar(require("vscode"));
const pg = __importStar(require("pg"));
const CONNECTIONS_KEY = 'pgsqlConnections';
class ConnectionManager {
    constructor(context) {
        this.connections = new Map();
        this.activeConnection = null;
        this.context = context;
    }
    // ── Public API ────────────────────────────────────────────────────────────
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
            // Handle unexpected disconnects
            client.on('error', (err) => {
                console.error(`Connection "${config.name}" error:`, err.message);
                this.connections.delete(config.name);
                if (this.activeConnection === config.name) {
                    this.activeConnection = this.connections.keys().next().value ?? null;
                }
            });
            this.connections.set(config.name, client);
            this.activeConnection = config.name;
            await this.saveConnection(config);
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
            try {
                await client.end();
            }
            catch { /* ignore */ }
            this.connections.delete(name);
        }
        if (this.activeConnection === name) {
            this.activeConnection = this.connections.keys().next().value ?? null;
        }
        await this.deleteConnection(name);
    }
    /**
     * Restore persisted connections on startup.
     * Attempts to reconnect each saved connection using the stored password.
     * Silently skips connections that fail (e.g. server not reachable).
     */
    async restoreConnections() {
        const saved = this.getSavedList();
        for (const conn of saved) {
            const password = await this.loadPassword(conn.name);
            if (password === undefined)
                continue; // no password stored — skip
            try {
                const client = new pg.Client({
                    host: conn.host,
                    port: conn.port,
                    database: conn.database,
                    user: conn.user,
                    password
                });
                await client.connect();
                client.on('error', (err) => {
                    console.error(`Connection "${conn.name}" error:`, err.message);
                    this.connections.delete(conn.name);
                    if (this.activeConnection === conn.name) {
                        this.activeConnection = this.connections.keys().next().value ?? null;
                    }
                });
                this.connections.set(conn.name, client);
                // Make the first restored connection active
                if (!this.activeConnection) {
                    this.activeConnection = conn.name;
                }
            }
            catch (err) {
                // Server unreachable or password changed — leave it in the saved list
                // but don't add to active connections
                console.warn(`Could not restore connection "${conn.name}":`, err);
            }
        }
    }
    getActiveConnection() {
        if (this.activeConnection) {
            return this.connections.get(this.activeConnection) ?? null;
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
    /** Returns all saved connection names (including ones not yet connected). */
    getSavedConnectionNames() {
        return this.getSavedList().map(c => c.name);
    }
    getActiveConnectionName() {
        return this.activeConnection;
    }
    async closeAllConnections() {
        for (const client of this.connections.values()) {
            try {
                await client.end();
            }
            catch { /* ignore */ }
        }
        this.connections.clear();
        this.activeConnection = null;
    }
    // ── Persistence ───────────────────────────────────────────────────────────
    async saveConnection(config) {
        // Save metadata (no password) in globalState
        const list = this.getSavedList();
        const idx = list.findIndex(c => c.name === config.name);
        const meta = {
            name: config.name,
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user
        };
        if (idx >= 0) {
            list[idx] = meta;
        }
        else {
            list.push(meta);
        }
        await this.context.globalState.update(CONNECTIONS_KEY, list);
        // Save password in SecretStorage
        await this.context.secrets.store(`pgsql.password.${config.name}`, config.password);
    }
    async deleteConnection(name) {
        const list = this.getSavedList().filter(c => c.name !== name);
        await this.context.globalState.update(CONNECTIONS_KEY, list);
        try {
            await this.context.secrets.delete(`pgsql.password.${name}`);
        }
        catch { /* ignore */ }
    }
    getSavedList() {
        return this.context.globalState.get(CONNECTIONS_KEY) ?? [];
    }
    async loadPassword(name) {
        return this.context.secrets.get(`pgsql.password.${name}`);
    }
}
exports.ConnectionManager = ConnectionManager;
//# sourceMappingURL=connectionManager.js.map