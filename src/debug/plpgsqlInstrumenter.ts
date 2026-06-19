import { formatPauseNoticeSql, formatTraceNoticeSql } from './debugProtocol';
import { bodyOffsetToEditorLine } from './lineMap';
import type { ParsedRoutine } from './plpgsqlParse';
import { advancePast, getRegionAt, readWordAt } from './plpgsqlLexer';
import { canCaptureFunctionReturn, sanitizeTypeForDeclare } from './routineReturn';
import { isInputParameterMode } from './routineParameters';

export type InstrumentMode = 'trace' | 'breakpoints_only';

export interface InstrumentPoint {
	sourceLine: number;
	offset: number;
}

export interface InstrumentResult {
	code: string;
	points: InstrumentPoint[];
}

export interface InstrumentOptions {
	mode: InstrumentMode;
	/** Номера строк в документе редактора (1-based). */
	breakpointLines: Set<number>;
	parsed: ParsedRoutine;
	sessionKey?: number;
	varNames: string[];
}

/**
 * Вставляет RAISE NOTICE / advisory lock после `;`.
 * Важно: не все `END ...` закрывают внешний `BEGIN ... END` (например `END IF`),
 * поэтому счётчик блоков ведём только для `BEGIN`/`END` "процедурных" блоков.
 */
export function instrumentPlpgsqlBody(body: string, options: InstrumentOptions): InstrumentResult {
	const insertions: { offset: number; sql: string; sourceLine: number }[] = [];
	let blockDepth = 0;
	/** Между FOR … IN и LOOP (заголовок курсора) — не вставляем хуки. */
	let forQueryDepth = 0;
	let i = 0;
	let inExecuteLine = false;

	// Вставляем стартовую нотификацию, чтобы гарантировать появление событий в трейсах.
	// Это помогает диагностировать случаи, когда из-за сложной вложенности хуки после `;`
	// не срабатывают.
	if (options.mode === 'trace') {
		const initLine = options.parsed.bodyStartLine ?? bodyOffsetToEditorLine(options.parsed, 0);
		const hook = buildHook(initLine, options, false);
		if (hook) {
			insertions.push({ offset: 0, sql: hook + '\n', sourceLine: initLine });
		}
	}

	while (i < body.length) {
		const region = getRegionAt(body, i);
		if (region !== 'code') {
			if (region === 'line-comment' || region === 'string' || region === 'dollar') {
				if (inExecuteLine && body[i] === '\n') {
					inExecuteLine = false;
				}
			}
			i = advancePast(body, i);
			continue;
		}

		const word = readWordAt(body, i);
		if (word) {
			if (/^BEGIN$/i.test(word)) {
				blockDepth++;
				i += word.length;
				continue;
			}
			if (/^END$/i.test(word)) {
				const afterEnd = skipSpaces(body, i + word.length);
				const endSuffix = readWordAt(body, afterEnd);
				// END IF / END LOOP / END CASE не закрывают BEGIN..END-блок.
				if (endSuffix && /^(IF|LOOP|CASE)$/i.test(endSuffix)) {
					i = afterEnd + endSuffix.length;
					continue;
				} else {
					blockDepth = Math.max(0, blockDepth - 1);
					i += word.length;
					continue;
				}
			} else if (blockDepth === 0 && /^FOR$/i.test(word)) {
				forQueryDepth++;
				i += word.length;
				continue;
			} else if (/^LOOP$/i.test(word) && forQueryDepth > 0) {
				forQueryDepth--;
				i += word.length;
				continue;
			} else if (blockDepth === 0 && /^EXECUTE$/i.test(word)) {
				inExecuteLine = true;
				i += word.length;
				continue;
			}
		}

		if (body[i] === '\n') {
			inExecuteLine = false;
		}

		// Вставляем хуки после "оператор;" (кроме заголовка FOR … IN … LOOP и EXECUTE).
		if (blockDepth <= 1 && forQueryDepth === 0 && !inExecuteLine && body[i] === ';') {
			const stmtStart = findStatementStart(body, i);
			// Номер строки должен соответствовать месту вставки NOTICE — т.е. строке,
			// где стоит `;` (а не началу предыдущего оператора).
			const editorLine = bodyOffsetToEditorLine(options.parsed, i);
			const isBreakpoint = options.breakpointLines.has(editorLine);
			const shouldInstrument =
				!isEmptyStatement(body, stmtStart, i) &&
				(options.mode === 'trace' || isBreakpoint);

			if (shouldInstrument) {
				const hook = buildHook(editorLine, options, isBreakpoint);
				if (hook) {
					insertions.push({ offset: i + 1, sql: '\n' + hook, sourceLine: editorLine });
				}
			}
		}

		i++;
	}

	return applyInsertions(body, insertions);
}

function buildHook(sourceLine: number, options: InstrumentOptions, isBreakpoint: boolean): string {
	if (isBreakpoint && options.sessionKey !== undefined) {
		return formatPauseNoticeSql(sourceLine, options.sessionKey);
	}
	if (options.mode === 'trace') {
		return formatTraceNoticeSql(sourceLine, options.varNames, 'stmt');
	}
	return '';
}

function findStatementStart(body: string, semicolonOffset: number): number {
	for (let i = semicolonOffset - 1; i >= 0; i--) {
		if (getRegionAt(body, i) === 'code' && body[i] === ';') {
			return i + 1;
		}
	}
	return 0;
}

function skipSpaces(body: string, i: number): number {
	while (i < body.length) {
		const c = body[i];
		if (c !== undefined && /\s/.test(c)) {
			i++;
			continue;
		}
		// Line comment: --
		if (c === '-' && body[i + 1] === '-') {
			i += 2;
			while (i < body.length && body[i] !== '\n') {
				i++;
			}
			continue;
		}
		// Block comment: /* ... */
		if (c === '/' && body[i + 1] === '*') {
			const end = body.indexOf('*/', i + 2);
			i = end === -1 ? body.length : end + 2;
			continue;
		}
		break;
	}
	return i;
}

function isEmptyStatement(body: string, start: number, end: number): boolean {
	const slice = body
		.slice(start, end)
		.replace(/--[^\n]*/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.trim();
	return slice.length === 0;
}

function applyInsertions(
	body: string,
	insertions: { offset: number; sql: string; sourceLine: number }[]
): InstrumentResult {
	const sorted = [...insertions].sort((a, b) => b.offset - a.offset);
	let code = body;
	const points: InstrumentPoint[] = [];
	for (const ins of sorted) {
		code = code.slice(0, ins.offset) + ins.sql + code.slice(ins.offset);
		points.push({ sourceLine: ins.sourceLine, offset: ins.offset });
	}
	points.sort((a, b) => a.sourceLine - b.sourceLine);
	return { code, points };
}

export function buildDebugDoBlock(
	parsed: {
		parameters: { name: string; type: string; mode: string }[];
		declareVars: { name: string; type: string }[];
		hasReturn: boolean;
		returnType?: string;
	},
	instrumentedBody: string,
	argAssignments: string[]
): string {
	const lines: string[] = ['DO $pgsql_tools$', 'DECLARE'];
	let argIdx = 0;
	for (const p of parsed.parameters) {
		if (!isInputParameterMode(p.mode)) {
			continue;
		}
		const assign = argAssignments[argIdx++] ?? 'NULL';
		lines.push(
			`  ${quoteIdent(p.name)} ${sanitizeTypeForDeclare(p.type)} := ${assign};`
		);
	}
	for (const v of parsed.declareVars) {
		lines.push(`  ${quoteIdent(v.name)} ${sanitizeTypeForDeclare(v.type)};`);
	}
	if (canCaptureFunctionReturn(parsed)) {
		lines.push(`  _pgsql_tools_result ${sanitizeTypeForDeclare(parsed.returnType!)};`);
	}
	lines.push('BEGIN');
	lines.push(instrumentedBody);
	if (canCaptureFunctionReturn(parsed)) {
		lines.push(
			`  RAISE NOTICE '[PGSQL_TOOLS]%', json_build_object('type', 'return', 'line', 0, 'vars', json_build_object('result', _pgsql_tools_result::text));`
		);
	}
	lines.push('END;', '$pgsql_tools$;');
	return lines.join('\n');
}

function quoteIdent(name: string): string {
	if (/^[a-z_][a-z0-9_$]*$/i.test(name)) {
		return name;
	}
	return `"${name.replace(/"/g, '""')}"`;
}
