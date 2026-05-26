import * as vscode from 'vscode';

export type TreeSearchObjectKind =
	| 'table'
	| 'view'
	| 'function'
	| 'procedure'
	| 'sequence'
	| 'type'
	| 'index'
	| 'trigger';

/** Codicon id — как в PostgreSQLTreeDataProvider.iconMap. */
export const TREE_SEARCH_KIND_ICONS: Record<TreeSearchObjectKind, string> = {
	table: 'table',
	view: 'file-code',
	function: 'symbol-function',
	procedure: 'symbol-method',
	sequence: 'symbol-numeric',
	type: 'symbol-class',
	index: 'list-tree',
	trigger: 'zap',
};

export const TREE_SEARCH_OBJECT_KINDS: ReadonlyArray<{
	kind: TreeSearchObjectKind;
	title: string;
}> = [
	{ kind: 'table', title: 'Таблицы' },
	{ kind: 'view', title: 'Представления' },
	{ kind: 'function', title: 'Функции' },
	{ kind: 'procedure', title: 'Процедуры' },
	{ kind: 'sequence', title: 'Последовательности' },
	{ kind: 'type', title: 'Типы' },
	{ kind: 'index', title: 'Индексы' },
	{ kind: 'trigger', title: 'Триггеры' },
];

const STORAGE_KEY = 'pgsqlTreeSearchSettings';

export interface TreeSearchSettingsState {
	objectTypes: Record<TreeSearchObjectKind, boolean>;
	disabledSchemasByConnection: Record<string, string[]>;
}

function defaultObjectTypes(): Record<TreeSearchObjectKind, boolean> {
	const o = {} as Record<TreeSearchObjectKind, boolean>;
	for (const { kind } of TREE_SEARCH_OBJECT_KINDS) {
		o[kind] = true;
	}
	return o;
}

function defaultState(): TreeSearchSettingsState {
	return { objectTypes: defaultObjectTypes(), disabledSchemasByConnection: {} };
}

export interface TreeSearchWebviewState {
	filterText: string;
	objectTypes: Record<TreeSearchObjectKind, boolean>;
	schemas: Array<{ name: string; enabled: boolean }>;
	settingsOpen: boolean;
	connectionName: string | null;
}

export class TreeSearchSettings {
	private readonly onChangeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.onChangeEmitter.event;
	private settingsOpen = false;
	private schemaCache = new Map<string, string[]>();

	constructor(private context: vscode.ExtensionContext) {}

	private load(): TreeSearchSettingsState {
		const stored = this.context.globalState.get<TreeSearchSettingsState>(STORAGE_KEY);
		if (!stored) {
			return defaultState();
		}
		const objectTypes = { ...defaultObjectTypes(), ...stored.objectTypes };
		return {
			objectTypes,
			disabledSchemasByConnection: { ...stored.disabledSchemasByConnection },
		};
	}

	private async save(state: TreeSearchSettingsState): Promise<void> {
		await this.context.globalState.update(STORAGE_KEY, state);
		this.onChangeEmitter.fire();
	}

	isSettingsOpen(): boolean {
		return this.settingsOpen;
	}

	setSettingsOpen(open: boolean): void {
		this.settingsOpen = open;
	}

	isObjectTypeEnabled(kind: TreeSearchObjectKind): boolean {
		return this.load().objectTypes[kind] !== false;
	}

	getEnabledObjectKinds(): Set<TreeSearchObjectKind> {
		const state = this.load();
		const enabled = new Set<TreeSearchObjectKind>();
		for (const { kind } of TREE_SEARCH_OBJECT_KINDS) {
			if (state.objectTypes[kind] !== false) {
				enabled.add(kind);
			}
		}
		return enabled;
	}

	isSchemaEnabled(connectionName: string, schema: string): boolean {
		const disabled = this.load().disabledSchemasByConnection[connectionName] ?? [];
		return !disabled.includes(schema);
	}

	getDisabledSchemas(connectionName: string): Set<string> {
		return new Set(this.load().disabledSchemasByConnection[connectionName] ?? []);
	}

	async setObjectType(kind: TreeSearchObjectKind, enabled: boolean): Promise<void> {
		const state = this.load();
		state.objectTypes[kind] = enabled;
		await this.save(state);
	}

	async setSchemaEnabled(connectionName: string, schema: string, enabled: boolean): Promise<void> {
		const state = this.load();
		const list = new Set(state.disabledSchemasByConnection[connectionName] ?? []);
		if (enabled) {
			list.delete(schema);
		} else {
			list.add(schema);
		}
		state.disabledSchemasByConnection[connectionName] = [...list].sort();
		await this.save(state);
	}

	async setAllSchemasEnabled(connectionName: string, enabled: boolean, schemaNames: string[]): Promise<void> {
		const state = this.load();
		if (enabled) {
			delete state.disabledSchemasByConnection[connectionName];
		} else {
			state.disabledSchemasByConnection[connectionName] = [...schemaNames].sort();
		}
		await this.save(state);
	}

	setSchemaList(connectionName: string, schemas: string[]): void {
		this.schemaCache.set(connectionName, schemas);
	}

	getCachedSchemas(connectionName: string): string[] {
		return this.schemaCache.get(connectionName) ?? [];
	}

	clearSchemaCache(connectionName?: string): void {
		if (connectionName) {
			this.schemaCache.delete(connectionName);
		} else {
			this.schemaCache.clear();
		}
	}

	buildWebviewState(filterText: string, connectionName: string | null, schemas: string[]): TreeSearchWebviewState {
		const state = this.load();
		return {
			filterText,
			objectTypes: { ...state.objectTypes },
			schemas: schemas.map((name) => ({
				name,
				enabled: connectionName ? this.isSchemaEnabled(connectionName, name) : true,
			})),
			settingsOpen: this.settingsOpen,
			connectionName,
		};
	}
}
