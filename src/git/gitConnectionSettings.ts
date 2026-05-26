import * as vscode from 'vscode';

export interface GitConnectionConfig {
	/** Локальный каталог DDL для этого подключения */
	repositoryPath: string;
	/** Сравнивать объекты БД с Git (иначе лишние запросы к БД не выполняются) */
	compareEnabled: boolean;
}

const STORAGE_KEY = 'pgsqlGitByConnection';

function defaultConfig(): GitConnectionConfig {
	return { repositoryPath: '', compareEnabled: false };
}

export class GitConnectionSettings {
	constructor(private context: vscode.ExtensionContext) {}

	getAll(): Record<string, GitConnectionConfig> {
		return this.context.globalState.get<Record<string, GitConnectionConfig>>(STORAGE_KEY) ?? {};
	}

	get(connectionName: string): GitConnectionConfig {
		const stored = this.getAll()[connectionName];
		if (stored) {
			return { ...stored };
		}
		const legacy = String(
			vscode.workspace.getConfiguration('pgsql-tools').get<string>('gitRepositoryPath') ?? ''
		).trim();
		if (legacy) {
			return { repositoryPath: legacy, compareEnabled: true };
		}
		return defaultConfig();
	}

	async set(connectionName: string, config: GitConnectionConfig): Promise<void> {
		const all = this.getAll();
		all[connectionName] = {
			repositoryPath: String(config.repositoryPath ?? '').trim(),
			compareEnabled: !!config.compareEnabled,
		};
		await this.context.globalState.update(STORAGE_KEY, all);
	}

	async setAll(configs: Record<string, GitConnectionConfig>): Promise<void> {
		const normalized: Record<string, GitConnectionConfig> = {};
		for (const [name, cfg] of Object.entries(configs)) {
			normalized[name] = {
				repositoryPath: String(cfg.repositoryPath ?? '').trim(),
				compareEnabled: !!cfg.compareEnabled,
			};
		}
		await this.context.globalState.update(STORAGE_KEY, normalized);
	}

	isCompareEnabled(connectionName: string): boolean {
		const cfg = this.get(connectionName);
		return cfg.compareEnabled && !!cfg.repositoryPath;
	}

	getRepositoryPath(connectionName: string): string {
		return this.get(connectionName).repositoryPath;
	}

	getConnectionsWithCompareEnabled(connectionNames: string[]): string[] {
		return connectionNames.filter((n) => this.isCompareEnabled(n));
	}

	/** Уникальные пути Git среди включённых подключений */
	getActiveRepositoryPaths(connectionNames: string[]): string[] {
		const paths = new Set<string>();
		for (const name of connectionNames) {
			if (!this.isCompareEnabled(name)) {
				continue;
			}
			const p = this.getRepositoryPath(name);
			if (p) {
				paths.add(p);
			}
		}
		return [...paths];
	}
}
