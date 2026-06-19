import type { ParsedRoutine } from './plpgsqlParse';

/** Номер строки в полном DDL (1-based) по символьному смещению. */
export function editorLineAt(ddl: string, offset: number): number {
	let line = 1;
	const end = Math.min(Math.max(0, offset), ddl.length);
	for (let i = 0; i < end; i++) {
		if (ddl[i] === '\n') {
			line++;
		}
	}
	return line;
}

/** Смещение в `parsed.body` → номер строки в документе редактора. */
export function bodyOffsetToEditorLine(parsed: ParsedRoutine, offsetInBody: number): number {
	return editorLineAt(parsed.ddlText, parsed.bodyStartOffset + offsetInBody);
}
