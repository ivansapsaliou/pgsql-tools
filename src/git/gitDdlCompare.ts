import type { GitDdlObjectKind } from '../database/queryExecutor';
import { normalizeRoutineDollarQuotes } from './gitRoutineDdl';

export function normalizeForCompare(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeDdlText(text: string, kind?: GitDdlObjectKind): string {
	let n = normalizeForCompare(text);
	if (kind === 'function' || kind === 'procedure') {
		n = normalizeRoutineDollarQuotes(n);
	}
	return n;
}

export function ddlTextsEqual(fileText: string, dbDdl: string, kind?: GitDdlObjectKind): boolean {
	return normalizeDdlText(fileText, kind) === normalizeDdlText(dbDdl, kind);
}
