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
const sshTunnel_1 = require("./sshTunnel");
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
            let host = config.host;
            let port = config.port;
            let tunnel;
            // Если задан SSH — открываем туннель
            if (config.ssh) {
                tunnel = await (0, sshTunnel_1.openSshTunnel)(config.ssh, config.host, config.port);
                host = '127.0.0.1';
                port = tunnel.localPort;
            }
            const client = new pg.Client({
                host,
                port,
                database: config.database,
                user: config.user,
                password: config.password,
            });
            await client.connect();
            client.on('error', (err) => {
                console.error(`Connection "${config.name}" error:`, err.message);
                this.removeActiveEntry(config.name);
            });
            this.connections.set(config.name, { client, tunnel });
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
        await this.removeActiveEntry(name);
        await this.deleteConnection(name);
    }
    /**
     * Восстанавливает сохранённые подключения при старте.
     */
    async restoreConnections() {
        const saved = this.getSavedList();
        for (const conn of saved) {
            const password = await this.loadPassword(conn.name);
            if (password === undefined)
                continue;
            const sshPassword = conn.ssh
                ? await this.loadSshPassword(conn.name)
                : undefined;
            const sshPassphrase = conn.ssh
                ? await this.loadSshPassphrase(conn.name)
                : undefined;
            try {
                let host = conn.host;
                let port = conn.port;
                let tunnel;
                if (conn.ssh) {
                    const sshCfg = {
                        ...conn.ssh,
                        password: sshPassword,
                        passphrase: sshPassphrase,
                    };
                    tunnel = await (0, sshTunnel_1.openSshTunnel)(sshCfg, conn.host, conn.port);
                    host = '127.0.0.1';
                    port = tunnel.localPort;
                }
                const client = new pg.Client({ host, port, database: conn.database, user: conn.user, password });
                await client.connect();
                client.on('error', (err) => {
                    console.error(`Connection "${conn.name}" error:`, err.message);
                    this.removeActiveEntry(conn.name);
                });
                this.connections.set(conn.name, { client, tunnel });
                if (!this.activeConnection) {
                    this.activeConnection = conn.name;
                }
            }
            catch (err) {
                console.warn(`Could not restore connection "${conn.name}":`, err);
            }
        }
    }
    getActiveConnection() {
        if (this.activeConnection) {
            return this.connections.get(this.activeConnection)?.client ?? null;
        }
        return null;
    }
    getConnectionByName(name) {
        return this.connections.get(name)?.client ?? null;
    }
    setActiveConnection(name) {
        if (this.connections.has(name)) {
            this.activeConnection = name;
        }
    }
    getConnections() {
        return Array.from(this.connections.keys());
    }
    getSavedConnectionNames() {
        return this.getSavedList().map((c) => c.name);
    }
    getActiveConnectionName() {
        return this.activeConnection;
    }
    async closeAllConnections() {
        for (const [, entry] of this.connections) {
            try {
                await entry.client.end();
            }
            catch { /* ignore */ }
            try {
                entry.tunnel?.close();
            }
            catch { /* ignore */ }
        }
        this.connections.clear();
        this.activeConnection = null;
    }
    // ── Helpers ───────────────────────────────────────────────────────────────
    async removeActiveEntry(name) {
        const entry = this.connections.get(name);
        if (entry) {
            try {
                await entry.client.end();
            }
            catch { /* ignore */ }
            try {
                entry.tunnel?.close();
            }
            catch { /* ignore */ }
            this.connections.delete(name);
        }
        if (this.activeConnection === name) {
            this.activeConnection = this.connections.keys().next().value ?? null;
        }
    }
    // ── Persistence ───────────────────────────────────────────────────────────
    async saveConnection(config) {
        const list = this.getSavedList();
        const idx = list.findIndex((c) => c.name === config.name);
        const meta = {
            name: config.name,
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
        };
        if (config.ssh) {
            meta.ssh = {
                host: config.ssh.host,
                port: config.ssh.port,
                username: config.ssh.username,
                privateKey: config.ssh.privateKey,
            };
        }
        if (idx >= 0) {
            list[idx] = meta;
        }
        else {
            list.push(meta);
        }
        await this.context.globalState.update(CONNECTIONS_KEY, list);
        // Пароли в SecretStorage
        await this.context.secrets.store(`pgsql.password.${config.name}`, config.password);
        if (config.ssh?.password) {
            await this.context.secrets.store(`pgsql.ssh.password.${config.name}`, config.ssh.password);
        }
        if (config.ssh?.passphrase) {
            await this.context.secrets.store(`pgsql.ssh.passphrase.${config.name}`, config.ssh.passphrase);
        }
    }
    async deleteConnection(name) {
        const list = this.getSavedList().filter((c) => c.name !== name);
        await this.context.globalState.update(CONNECTIONS_KEY, list);
        try {
            await this.context.secrets.delete(`pgsql.password.${name}`);
        }
        catch { /* ignore */ }
        try {
            await this.context.secrets.delete(`pgsql.ssh.password.${name}`);
        }
        catch { /* ignore */ }
        try {
            await this.context.secrets.delete(`pgsql.ssh.passphrase.${name}`);
        }
        catch { /* ignore */ }
    }
    getSavedList() {
        return this.context.globalState.get(CONNECTIONS_KEY) ?? [];
    }
    async loadPassword(name) {
        return this.context.secrets.get(`pgsql.password.${name}`);
    }
    async loadSshPassword(name) {
        return this.context.secrets.get(`pgsql.ssh.password.${name}`);
    }
    async loadSshPassphrase(name) {
        return this.context.secrets.get(`pgsql.ssh.passphrase.${name}`);
    }
}
exports.ConnectionManager = ConnectionManager;
//# sourceMappingURL=connectionManager.js.map