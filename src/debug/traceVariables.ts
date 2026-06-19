import type { ParsedRoutine } from './plpgsqlParse';

/** Типы, которые нельзя безопасно сериализовать в NOTICE (ломают трассировку). */
export function isUntraceableVarType(type: string): boolean {
	const t = type.trim().toLowerCase();
	if (t === 'record' || t === 'void') {
		return true;
	}
	if (t.endsWith('%rowtype') || t.endsWith('%type')) {
		return true;
	}
	if (/\bcursor\b/.test(t)) {
		return true;
	}
	return false;
}

/** Имена переменных для json_build_object в RAISE NOTICE. */
export function collectTraceableVariableNames(parsed: ParsedRoutine): string[] {
	const names: string[] = [];
	for (const p of parsed.parameters) {
		if (p.mode === 'OUT' || isUntraceableVarType(p.type)) {
			continue;
		}
		names.push(p.name);
	}
	for (const v of parsed.declareVars) {
		if (!isUntraceableVarType(v.type)) {
			names.push(v.name);
		}
	}
	return names;
}

export interface ParamValueChange {
	line: number;
	time: string;
	previous: string | null;
	value: string;
}

export interface ParamTraceEntry {
	name: string;
	current: string | null;
	changes: ParamValueChange[];
}

/** Состояние трассировки: одна строка на параметр, только факты изменения. */
export class TraceVariableTracker {
	private readonly order: string[] = [];
	private readonly entries = new Map<string, ParamTraceEntry>();

	constructor(variableNames?: string[]) {
		if (variableNames) {
			for (const name of variableNames) {
				this.ensure(name);
			}
		}
	}

	reset(variableNames?: string[]): void {
		this.order.length = 0;
		this.entries.clear();
		if (variableNames) {
			for (const name of variableNames) {
				this.ensure(name);
			}
		}
	}

	getOrderedEntries(): ParamTraceEntry[] {
		return this.order.map((name) => this.entries.get(name)!);
	}

	applyVars(line: number, time: string, vars?: Record<string, string>): number {
		if (!vars) {
			return 0;
		}
		let changed = 0;
		for (const [name, raw] of Object.entries(vars)) {
			const value = normalizeTraceValue(raw);
			const entry = this.ensure(name);
			const prev = entry.current;
			if (prev === null) {
				entry.current = value;
				continue;
			}
			if (prev !== value) {
				entry.changes.push({ line, time, previous: prev, value });
				entry.current = value;
				changed++;
			}
		}
		return changed;
	}

	private ensure(name: string): ParamTraceEntry {
		let entry = this.entries.get(name);
		if (!entry) {
			entry = { name, current: null, changes: [] };
			this.entries.set(name, entry);
			this.order.push(name);
		}
		return entry;
	}
}

function normalizeTraceValue(raw: string | null | undefined): string {
	if (raw === null || raw === undefined || raw === '') {
		return 'NULL';
	}
	return raw;
}
