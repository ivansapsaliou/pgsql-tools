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

// Stored without password — passwords live in SecretStorage
interface SavedConnection {
	name: string;
	host: string;
	port: number;
	database: string;
	user: string;
}

const CONNECTIONS_KEY = 'pgsqlConnections';

export class ConnectionManager {
	private connections: Map<string, pg.Client> = new Map();
	private activeConnection: string | null = null;
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	// ── Public API ────────────────────────────────────────────────────────────

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
		} catch (error) {
			vscode.window.showErrorMessage(`Connection failed: ${error}`);
			return false;
		}
	}

	async removeConnection(name: string): Promise<void> {
		const client = this.connections.get(name);
		if (client) {
			try { await client.end(); } catch { /* ignore */ }
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
	async restoreConnections(): Promise<void> {
		const saved = this.getSavedList();
		for (const conn of saved) {
			const password = await this.loadPassword(conn.name);
			if (password === undefined) continue; // no password stored — skip

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
			} catch (err) {
				// Server unreachable or password changed — leave it in the saved list
				// but don't add to active connections
				console.warn(`Could not restore connection "${conn.name}":`, err);
			}
		}
	}

	getActiveConnection(): pg.Client | null {
		if (this.activeConnection) {
			return this.connections.get(this.activeConnection) ?? null;
		}
		return null;
	}

	/**
	 * Get a specific pg.Client by connection name without changing the active connection.
	 */
	getConnectionByName(name: string): pg.Client | null {
		return this.connections.get(name) ?? null;
	}

	setActiveConnection(name: string): void {
		if (this.connections.has(name)) {
			this.activeConnection = name;
		}
	}

	getConnections(): string[] {
		return Array.from(this.connections.keys());
	}

	/** Returns all saved connection names (including ones not yet connected). */
	getSavedConnectionNames(): string[] {
		return this.getSavedList().map(c => c.name);
	}

	getActiveConnectionName(): string | null {
		return this.activeConnection;
	}

	async closeAllConnections(): Promise<void> {
		for (const client of this.connections.values()) {
			try { await client.end(); } catch { /* ignore */ }
		}
		this.connections.clear();
		this.activeConnection = null;
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private async saveConnection(config: ConnectionConfig): Promise<void> {
		// Save metadata (no password) in globalState
		const list = this.getSavedList();
		const idx = list.findIndex(c => c.name === config.name);
		const meta: SavedConnection = {
			name: config.name,
			host: config.host,
			port: config.port,
			database: config.database,
			user: config.user
		};

		if (idx >= 0) {
			list[idx] = meta;
		} else {
			list.push(meta);
		}

		await this.context.globalState.update(CONNECTIONS_KEY, list);

		// Save password in SecretStorage
		await this.context.secrets.store(
			`pgsql.password.${config.name}`,
			config.password
		);
	}

	private async deleteConnection(name: string): Promise<void> {
		const list = this.getSavedList().filter(c => c.name !== name);
		await this.context.globalState.update(CONNECTIONS_KEY, list);
		try {
			await this.context.secrets.delete(`pgsql.password.${name}`);
		} catch { /* ignore */ }
	}

	private getSavedList(): SavedConnection[] {
		return this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY) ?? [];
	}

	private async loadPassword(name: string): Promise<string | undefined> {
		return this.context.secrets.get(`pgsql.password.${name}`);
	}
}