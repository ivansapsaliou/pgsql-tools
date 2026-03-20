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

export class ConnectionManager {
	private connections: Map<string, pg.Client> = new Map();
	private activeConnection: string | null = null;
	private config: vscode.WorkspaceConfiguration;
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
		this.config = vscode.workspace.getConfiguration('pgsqlTools');
		this.loadConnections();
	}

	async addConnection(config: ConnectionConfig): Promise<boolean> {
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
		} catch (error) {
			vscode.window.showErrorMessage(`Connection failed: ${error}`);
			return false;
		}
	}

	async removeConnection(name: string): Promise<void> {
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

	getActiveConnection(): pg.Client | null {
		if (this.activeConnection) {
			return this.connections.get(this.activeConnection) || null;
		}
		return null;
	}

	setActiveConnection(name: string): void {
		if (this.connections.has(name)) {
			this.activeConnection = name;
		}
	}

	getConnections(): string[] {
		return Array.from(this.connections.keys());
	}

	getActiveConnectionName(): string | null {
		return this.activeConnection;
	}

	async closeAllConnections(): Promise<void> {
		for (const client of this.connections.values()) {
			await client.end();
		}
		this.connections.clear();
	}

	private saveConnection(config: ConnectionConfig): void {
		const connections = this.context.globalState.get<ConnectionConfig[]>('pgsqlConnections') || [];
		const index = connections.findIndex(c => c.name === config.name);
		if (index >= 0) {
			connections[index] = config;
		} else {
			connections.push(config);
		}
		this.context.globalState.update('pgsqlConnections', connections);
	}

	private deleteConnectionConfig(name: string): void {
		const connections = this.context.globalState.get<ConnectionConfig[]>('pgsqlConnections') || [];
		const filtered = connections.filter(c => c.name !== name);
		this.context.globalState.update('pgsqlConnections', filtered);
	}

	private loadConnections(): void {
		const saved = this.context.globalState.get<ConnectionConfig[]>('pgsqlConnections') || [];
		// Connections are loaded but not automatically connected for security reasons
	}
}