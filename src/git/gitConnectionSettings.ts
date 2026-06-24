import * as vscode from 'vscode';
import type { GitDdlObjectKind } from '../database/queryExecutor';
import {
	DEFAULT_COMPARE_KINDS,
	GitCompareKinds,
	normalizeCompareKinds,
} from './gitCompareKinds';

export interface GitConnectionConfig {
	/** Локальный каталог DDL для этого подключения */
	repositoryPath: string;
	/** Сравнивать объекты БД с Git (иначе лишние запросы к БД не выполняются) */
	compareEnabled: boolean;
	/** Какие типы объектов участвуют в сравнении и синхронизации */
	compareKinds: GitCompareKinds;
}

const STORAGE_KEY = 'pgsqlGitByConnection';

function defaultConfig(): GitConnectionConfig {
	return {
		repositoryPath: '',
		compareEnabled: false,
		compareKinds: { ...DEFAULT_COMPARE_KINDS },
	};
}

function normalizeConfig(raw: Partial<GitConnectionConfig> | undefined): GitConnectionConfig {
	if (!raw) {
		return defaultConfig();
	}
	return {
		repositoryPath: String(raw.repositoryPath ?? '').trim(),
		compareEnabled: !!raw.compareEnabled,
		compareKinds: normalizeCompareKinds(raw.compareKinds),
	};
}

export class GitConnectionSettings {
	constructor(private context: vscode.ExtensionContext) {}

	getAll(): Record<string, GitConnectionConfig> {
		const stored = this.context.globalState.get<Record<string, Partial<GitConnectionConfig>>>(STORAGE_KEY) ?? {};
		const normalized: Record<string, GitConnectionConfig> = {};
		for (const [name, cfg] of Object.entries(stored)) {
			normalized[name] = normalizeConfig(cfg);
		}
		return normalized;
	}

	get(connectionName: string): GitConnectionConfig {
		const stored = this.getAll()[connectionName];
		if (stored) {
			return { ...stored, compareKinds: { ...stored.compareKinds } };
		}
		const legacy = String(
			vscode.workspace.getConfiguration('pgsql-tools').get<string>('gitRepositoryPath') ?? ''
		).trim();
		if (legacy) {
			return { repositoryPath: legacy, compareEnabled: true, compareKinds: { ...DEFAULT_COMPARE_KINDS } };
		}
		return defaultConfig();
	}

	async set(connectionName: string, config: GitConnectionConfig): Promise<void> {
		const all = this.getAll();
		all[connectionName] = normalizeConfig(config);
		await this.context.globalState.update(STORAGE_KEY, all);
	}

	async setAll(configs: Record<string, GitConnectionConfig>): Promise<void> {
		const normalized: Record<string, GitConnectionConfig> = {};
		for (const [name, cfg] of Object.entries(configs)) {
			normalized[name] = normalizeConfig(cfg);
		}
		await this.context.globalState.update(STORAGE_KEY, normalized);
	}

	isCompareEnabled(connectionName: string): boolean {
		const cfg = this.get(connectionName);
		return cfg.compareEnabled && !!cfg.repositoryPath;
	}

	isKindCompareEnabled(connectionName: string, kind: GitDdlObjectKind): boolean {
		if (!this.isCompareEnabled(connectionName)) {
			return false;
		}
		return this.get(connectionName).compareKinds[kind];
	}

	getCompareKinds(connectionName: string): GitCompareKinds {
		return { ...this.get(connectionName).compareKinds };
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
