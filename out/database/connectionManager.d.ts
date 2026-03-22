import * as vscode from 'vscode';
import * as pg from 'pg';
import { SshConfig } from './sshTunnel';
export interface ConnectionConfig {
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    /** SSH-туннель (опционально) */
    ssh?: SshConfig;
}
export declare class ConnectionManager {
    private connections;
    private activeConnection;
    private context;
    constructor(context: vscode.ExtensionContext);
    addConnection(config: ConnectionConfig): Promise<boolean>;
    removeConnection(name: string): Promise<void>;
    /**
     * Восстанавливает сохранённые подключения при старте.
     */
    restoreConnections(): Promise<void>;
    getActiveConnection(): pg.Client | null;
    getConnectionByName(name: string): pg.Client | null;
    setActiveConnection(name: string): void;
    getConnections(): string[];
    getSavedConnectionNames(): string[];
    getActiveConnectionName(): string | null;
    closeAllConnections(): Promise<void>;
    private removeActiveEntry;
    private saveConnection;
    private deleteConnection;
    private getSavedList;
    private loadPassword;
    private loadSshPassword;
    private loadSshPassphrase;
}
//# sourceMappingURL=connectionManager.d.ts.map