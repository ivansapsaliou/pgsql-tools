import * as vscode from 'vscode';
import * as path from 'path';

export interface CommandLogConfig {
	enabled: boolean;
	directory: string;
	/** When false, SQL starting with SELECT / WITH … SELECT is not logged. */
	logSelectQueries: boolean;
}

const STORAGE_KEY = 'pgsqlCommandLogConfig';

function defaultDirectory(): string {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!folder) {
		return '';
	}
	return path.join(folder, '.pgsql-tools', 'command-logs');
}

function defaultConfig(): CommandLogConfig {
	return {
		enabled: false,
		directory: defaultDirectory(),
		logSelectQueries: false,
	};
}

export class CommandLogSettings {
	constructor(private context: vscode.ExtensionContext) {}

	get(): CommandLogConfig {
		const stored = this.context.globalState.get<Partial<CommandLogConfig>>(STORAGE_KEY);
		if (!stored) {
			return defaultConfig();
		}
		return {
			enabled: !!stored.enabled,
			directory: String(stored.directory ?? defaultDirectory()).trim(),
			logSelectQueries: stored.logSelectQueries === true,
		};
	}

	async set(config: CommandLogConfig): Promise<void> {
		await this.context.globalState.update(STORAGE_KEY, {
			enabled: !!config.enabled,
			directory: String(config.directory ?? '').trim(),
			logSelectQueries: !!config.logSelectQueries,
		});
	}

	isEnabled(): boolean {
		const cfg = this.get();
		return cfg.enabled && !!cfg.directory;
	}

	getDirectory(): string {
		return this.get().directory;
	}

	shouldLogSelectQueries(): boolean {
		return this.get().logSelectQueries;
	}
}
