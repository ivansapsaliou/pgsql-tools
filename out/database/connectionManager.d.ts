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
    private config;
    private context;
    constructor(context: vscode.ExtensionContext);
    addConnection(config: ConnectionConfig): Promise<boolean>;
    removeConnection(name: string): Promise<void>;
    getActiveConnection(): pg.Client | null;
    setActiveConnection(name: string): void;
    getConnections(): string[];
    getActiveConnectionName(): string | null;
    closeAllConnections(): Promise<void>;
    private saveConnection;
    private deleteConnectionConfig;
    private loadConnections;
}
//# sourceMappingURL=connectionManager.d.ts.map