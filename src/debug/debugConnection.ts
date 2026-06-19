import * as pg from 'pg';
import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';

/** Второе подключение к той же БД для advisory_unlock / cancel без блокировки основного клиента. */
export class DebugControlConnection {
	private client: pg.Client | null = null;
	private connectionName: string | null = null;
	private tunnelClose: (() => void) | null = null;

	constructor(private readonly connectionManager: ConnectionManager) {}

	async acquire(connectionName: string): Promise<pg.Client> {
		if (this.client && this.connectionName === connectionName) {
			return this.client;
		}
		await this.release();
		const { client, tunnel } = await this.connectionManager.createStandaloneClient(connectionName);
		this.client = client;
		this.connectionName = connectionName;
		if (tunnel) {
			this.tunnelClose = () => {
				try {
					tunnel.close();
				} catch {
					/* ignore */
				}
			};
		}
		return this.client;
	}

	async release(): Promise<void> {
		if (this.client) {
			try {
				await this.client.end();
			} catch {
				/* ignore */
			}
			this.client = null;
			this.connectionName = null;
		}
		if (this.tunnelClose) {
			this.tunnelClose();
			this.tunnelClose = null;
		}
	}

	async unlockAdvisory(sessionKey: number, line: number): Promise<void> {
		if (!this.client) {
			return;
		}
		await this.client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [sessionKey, line]);
	}

	async cancelBackend(pid: number): Promise<void> {
		if (!this.client) {
			return;
		}
		await this.client.query('SELECT pg_cancel_backend($1::int)', [pid]);
	}

	async getBackendPid(runClient: pg.Client): Promise<number | null> {
		const res = await runClient.query('SELECT pg_backend_pid() AS pid');
		return res.rows[0]?.pid ?? null;
	}
}
