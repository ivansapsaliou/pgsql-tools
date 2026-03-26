import * as vscode from 'vscode';
import * as pg from 'pg';
import { openSshTunnel, SshConfig, TunnelInfo } from './sshTunnel';

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

export interface ConnectionDisplayInfo {
	name: string;
	host: string;
	port: number;
	database: string;
}

// Хранится без паролей — пароли в SecretStorage
interface SavedConnection {
	name: string;
	host: string;
	port: number;
	database: string;
	user: string;
	ssh?: Omit<SshConfig, 'password' | 'passphrase'>;
}

const CONNECTIONS_KEY = 'pgsqlConnections';

interface ActiveConnection {
	client: pg.Client;
	tunnel?: TunnelInfo;
}

export class ConnectionManager {
	private connections: Map<string, ActiveConnection> = new Map();
	private activeConnection: string | null = null;
	private context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	// ── Public API ────────────────────────────────────────────────────────────

	async addConnection(config: ConnectionConfig): Promise<boolean> {
		try {
			let host = config.host;
			let port = config.port;
			let tunnel: TunnelInfo | undefined;

			// Если задан SSH — открываем туннель
			if (config.ssh) {
				tunnel = await openSshTunnel(config.ssh, config.host, config.port);
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
		} catch (error) {
			vscode.window.showErrorMessage(`Connection failed: ${error}`);
			return false;
		}
	}

	async removeConnection(name: string): Promise<void> {
		await this.removeActiveEntry(name);
		await this.deleteConnection(name);
	}

	/**
	 * Восстанавливает сохранённые подключения при старте.
	 */
	async restoreConnections(): Promise<void> {
		const saved = this.getSavedList();
		for (const conn of saved) {
			const password = await this.loadPassword(conn.name);
			if (password === undefined) continue;

			const sshPassword = conn.ssh
				? await this.loadSshPassword(conn.name)
				: undefined;
			const sshPassphrase = conn.ssh
				? await this.loadSshPassphrase(conn.name)
				: undefined;

			try {
				let host = conn.host;
				let port = conn.port;
				let tunnel: TunnelInfo | undefined;

				if (conn.ssh) {
					const sshCfg: SshConfig = {
						...conn.ssh,
						password: sshPassword,
						passphrase: sshPassphrase,
					};
					tunnel = await openSshTunnel(sshCfg, conn.host, conn.port);
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
				// Важно: при старте расширения не выбираем активное подключение автоматически.
			} catch (err) {
				console.warn(`Could not restore connection "${conn.name}":`, err);
			}
		}
	}

	getActiveConnection(): pg.Client | null {
		if (this.activeConnection) {
			return this.connections.get(this.activeConnection)?.client ?? null;
		}
		return null;
	}

	getConnectionByName(name: string): pg.Client | null {
		return this.connections.get(name)?.client ?? null;
	}

	isConnected(name: string): boolean {
		return this.connections.has(name);
	}

	setActiveConnection(name: string): void {
		if (this.connections.has(name)) {
			this.activeConnection = name;
		}
	}

	getConnections(): string[] {
		return Array.from(this.connections.keys());
	}

	getSavedConnectionNames(): string[] {
		return this.getSavedList().map((c) => c.name);
	}

	async connectSavedConnection(name: string): Promise<boolean> {
		if (this.connections.has(name)) {
			this.activeConnection = name;
			return true;
		}

		const saved = this.getSavedList().find((c) => c.name === name);
		if (!saved) {
			vscode.window.showErrorMessage(`Connection "${name}" not found`);
			return false;
		}

		const password = await this.loadPassword(name);
		if (password === undefined) {
			vscode.window.showErrorMessage(`Password for "${name}" not found in secure storage`);
			return false;
		}

		const sshPassword = saved.ssh ? await this.loadSshPassword(name) : undefined;
		const sshPassphrase = saved.ssh ? await this.loadSshPassphrase(name) : undefined;

		try {
			let host = saved.host;
			let port = saved.port;
			let tunnel: TunnelInfo | undefined;

			if (saved.ssh) {
				const sshCfg: SshConfig = {
					...saved.ssh,
					password: sshPassword,
					passphrase: sshPassphrase,
				};
				tunnel = await openSshTunnel(sshCfg, saved.host, saved.port);
				host = '127.0.0.1';
				port = tunnel.localPort;
			}

			const client = new pg.Client({
				host,
				port,
				database: saved.database,
				user: saved.user,
				password,
			});

			await client.connect();

			client.on('error', (err) => {
				console.error(`Connection "${saved.name}" error:`, err.message);
				this.removeActiveEntry(saved.name);
			});

			this.connections.set(saved.name, { client, tunnel });
			this.activeConnection = saved.name;
			return true;
		} catch (error) {
			vscode.window.showErrorMessage(`Connection failed: ${error}`);
			return false;
		}
	}

	async disconnect(name: string): Promise<void> {
		await this.removeActiveEntry(name);
	}

	getActiveConnectionName(): string | null {
		return this.activeConnection;
	}

	getActiveConnectionDisplayInfo(): ConnectionDisplayInfo | null {
		if (!this.activeConnection) return null;
		const saved = this.getSavedList().find((c) => c.name === this.activeConnection);
		if (!saved) return null;
		return {
			name: saved.name,
			host: saved.host,
			port: saved.port,
			database: saved.database,
		};
	}

	async closeAllConnections(): Promise<void> {
		for (const [, entry] of this.connections) {
			try { await entry.client.end(); } catch { /* ignore */ }
			try { entry.tunnel?.close(); } catch { /* ignore */ }
		}
		this.connections.clear();
		this.activeConnection = null;
	}

	// ── Helpers ───────────────────────────────────────────────────────────────

	private async removeActiveEntry(name: string): Promise<void> {
		const entry = this.connections.get(name);
		if (entry) {
			try { await entry.client.end(); } catch { /* ignore */ }
			try { entry.tunnel?.close(); } catch { /* ignore */ }
			this.connections.delete(name);
		}
		if (this.activeConnection === name) {
			// Не переключаемся автоматически на “следующее” подключение.
			this.activeConnection = null;
		}
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private async saveConnection(config: ConnectionConfig): Promise<void> {
		const list = this.getSavedList();
		const idx = list.findIndex((c) => c.name === config.name);
		const meta: SavedConnection = {
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

		if (idx >= 0) { list[idx] = meta; } else { list.push(meta); }
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

	private async deleteConnection(name: string): Promise<void> {
		const list = this.getSavedList().filter((c) => c.name !== name);
		await this.context.globalState.update(CONNECTIONS_KEY, list);
		try { await this.context.secrets.delete(`pgsql.password.${name}`); } catch { /* ignore */ }
		try { await this.context.secrets.delete(`pgsql.ssh.password.${name}`); } catch { /* ignore */ }
		try { await this.context.secrets.delete(`pgsql.ssh.passphrase.${name}`); } catch { /* ignore */ }
	}

	private getSavedList(): SavedConnection[] {
		return this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY) ?? [];
	}

	private async loadPassword(name: string): Promise<string | undefined> {
		return this.context.secrets.get(`pgsql.password.${name}`);
	}

	private async loadSshPassword(name: string): Promise<string | undefined> {
		return this.context.secrets.get(`pgsql.ssh.password.${name}`);
	}

	private async loadSshPassphrase(name: string): Promise<string | undefined> {
		return this.context.secrets.get(`pgsql.ssh.passphrase.${name}`);
	}
}