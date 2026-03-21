import * as vscode from 'vscode';
import * as pg from 'pg';
export interface ConnectionConfig {
    name: string;
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
}
export declare class ConnectionManager {
    private connections;
    private activeConnection;
    private context;
    constructor(context: vscode.ExtensionContext);
    addConnection(config: ConnectionConfig): Promise<boolean>;
    removeConnection(name: string): Promise<void>;
    /**
     * Restore persisted connections on startup.
     * Attempts to reconnect each saved connection using the stored password.
     * Silently skips connections that fail (e.g. server not reachable).
     */
    restoreConnections(): Promise<void>;
    getActiveConnection(): pg.Client | null;
    /**
     * Get a specific pg.Client by connection name without changing the active connection.
     */
    getConnectionByName(name: string): pg.Client | null;
    setActiveConnection(name: string): void;
    getConnections(): string[];
    /** Returns all saved connection names (including ones not yet connected). */
    getSavedConnectionNames(): string[];
    getActiveConnectionName(): string | null;
    closeAllConnections(): Promise<void>;
    private saveConnection;
    private deleteConnection;
    private getSavedList;
    private loadPassword;
}
//# sourceMappingURL=connectionManager.d.ts.map