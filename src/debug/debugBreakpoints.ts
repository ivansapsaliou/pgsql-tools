import * as vscode from 'vscode';

const STORAGE_KEY = 'pgsqlTools.debugBreakpoints';

export interface BreakpointKey {
	connectionName: string;
	schema: string;
	specificName: string;
}

export function breakpointId(key: BreakpointKey, line: number): string {
	return `${key.connectionName}:${key.schema}:${key.specificName}:${line}`;
}

export function parseBreakpointId(id: string): { key: BreakpointKey; line: number } | null {
	const parts = id.split(':');
	if (parts.length < 4) {
		return null;
	}
	const line = parseInt(parts[parts.length - 1], 10);
	if (Number.isNaN(line)) {
		return null;
	}
	const connectionName = parts[0];
	const schema = parts[1];
	const specificName = parts.slice(2, -1).join(':');
	return {
		key: { connectionName, schema, specificName },
		line,
	};
}

export class DebugBreakpointStore {
	constructor(private readonly context: vscode.ExtensionContext) {}

	getAll(): Set<string> {
		const raw = this.context.workspaceState.get<string[]>(STORAGE_KEY) ?? [];
		return new Set(raw);
	}

	getLinesFor(key: BreakpointKey): Set<number> {
		const prefix = `${key.connectionName}:${key.schema}:${key.specificName}:`;
		const lines = new Set<number>();
		for (const id of this.getAll()) {
			if (id.startsWith(prefix)) {
				const line = parseInt(id.slice(prefix.length), 10);
				if (!Number.isNaN(line)) {
					lines.add(line);
				}
			}
		}
		return lines;
	}

	toggle(key: BreakpointKey, line: number): boolean {
		const id = breakpointId(key, line);
		const all = this.getAll();
		let enabled: boolean;
		if (all.has(id)) {
			all.delete(id);
			enabled = false;
		} else {
			all.add(id);
			enabled = true;
		}
		void this.context.workspaceState.update(STORAGE_KEY, [...all]);
		return enabled;
	}

	clearFor(key: BreakpointKey): void {
		const prefix = `${key.connectionName}:${key.schema}:${key.specificName}:`;
		const all = this.getAll();
		for (const id of [...all]) {
			if (id.startsWith(prefix)) {
				all.delete(id);
			}
		}
		void this.context.workspaceState.update(STORAGE_KEY, [...all]);
	}
}
