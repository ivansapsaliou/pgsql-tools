import { advancePast, getRegionAt, readWordAt } from './plpgsqlLexer';

export interface RoutineParam {
	name: string;
	type: string;
	mode: 'IN' | 'OUT' | 'INOUT' | 'VARIADIC';
}

export interface RoutineVariable {
	name: string;
	type: string;
}

export interface ParsedRoutine {
	language: string;
	dollarTag: string;
	parameters: RoutineParam[];
	declareVars: RoutineVariable[];
	/** Тело между внешним BEGIN и соответствующим END (без BEGIN/END). */
	body: string;
	/** Полный текст DDL (для привязки к редактору). */
	ddlText: string;
	/** Смещение начала dollar-блока в ddlText. */
	innerStartOffset: number;
	/** Смещение начала исполняемого тела в ddlText (сразу после BEGIN). */
	bodyStartOffset: number;
	/** @deprecated Используйте bodyStartOffset + editorLineAt */
	bodyStartLine: number;
	hasReturn: boolean;
	returnType?: string;
	kind: 'function' | 'procedure';
	schema?: string;
	name?: string;
}

export class PlpgsqlParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PlpgsqlParseError';
	}
}

export function parseRoutineDdl(ddl: string): ParsedRoutine {
	const langMatch = ddl.match(/\bLANGUAGE\s+(\w+)\s*/i);
	const language = langMatch ? langMatch[1].toLowerCase() : '';
	if (language !== 'plpgsql') {
		throw new PlpgsqlParseError(`Поддерживается только LANGUAGE plpgsql, получено: ${language || '(нет)'}`);
	}

	const asMatch = ddl.match(/\bAS\s+(\$[^$]*\$)/i);
	if (!asMatch) {
		throw new PlpgsqlParseError('Не найден блок AS $tag$ ... $tag$');
	}
	const dollarTag = asMatch[1];
	const tagStart = ddl.indexOf(dollarTag, asMatch.index);
	const innerStart = tagStart + dollarTag.length;
	const innerEnd = ddl.indexOf(dollarTag, innerStart);
	if (innerEnd < 0) {
		throw new PlpgsqlParseError('Не закрыт dollar-quoted блок тела функции');
	}
	const inner = ddl.slice(innerStart, innerEnd);

	const headerMatch = ddl.match(
		/CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:(\w+)\.)?(\w+)\s*\(/i
	);
	const schema = headerMatch?.[1];
	const name = headerMatch?.[2];
	const kind = /\bPROCEDURE\b/i.test(ddl.slice(0, 80)) ? 'procedure' : 'function';
	const paramList = headerMatch ? extractRoutineParamList(ddl, headerMatch.index!) : '';
	const parameters = paramList ? parseParamList(paramList) : [];

	const returnMatch = ddl.match(/\bRETURNS?\s+([\s\S]+?)\s+(?:AS|LANGUAGE)\b/i);
	const hasReturn = kind === 'function';
	const returnType = returnMatch?.[1]?.trim();

	const bodyStartLine = lineNumberAt(ddl, innerStart);
	const { declareVars, body, bodyStartOffsetInDdl } = extractDeclareAndBody(
		inner,
		innerStart
	);

	return {
		language,
		dollarTag,
		parameters,
		declareVars,
		body,
		ddlText: ddl,
		innerStartOffset: innerStart,
		bodyStartOffset: bodyStartOffsetInDdl,
		bodyStartLine: lineNumberAt(ddl, bodyStartOffsetInDdl),
		hasReturn,
		returnType,
		kind,
		schema,
		name,
	};
}

/** Список аргументов между первой `(` после имени routine и парной `)`. */
export function extractRoutineParamList(ddl: string, createMatchIndex: number): string {
	const openIdx = ddl.indexOf('(', createMatchIndex);
	if (openIdx < 0) {
		return '';
	}
	const closeIdx = findMatchingCloseParen(ddl, openIdx);
	if (closeIdx < 0) {
		return '';
	}
	return ddl.slice(openIdx + 1, closeIdx);
}

function findMatchingCloseParen(text: string, openIdx: number): number {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		const c = text[i];
		if (c === '(') {
			depth++;
		} else if (c === ')') {
			depth--;
			if (depth === 0) {
				return i;
			}
		}
	}
	return -1;
}

function parseParamList(list: string): RoutineParam[] {
	const params: RoutineParam[] = [];
	const parts = splitParamList(list);
	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed) {
			continue;
		}
		let mode: RoutineParam['mode'] = 'IN';
		let rest = trimmed;
		const modeMatch = rest.match(/^(INOUT|IN|OUT|VARIADIC)\s+/i);
		if (modeMatch) {
			mode = modeMatch[1].toUpperCase() as RoutineParam['mode'];
			rest = rest.slice(modeMatch[0].length);
		}
		const nameType = rest.match(/^(?:"([^"]+)"|(\w+))\s+([\s\S]+)$/);
		if (nameType) {
			const paramName = nameType[1] ?? nameType[2];
			params.push({
				name: paramName,
				type: nameType[3].trim().replace(/\s+DEFAULT\s+[\s\S]+$/i, ''),
				mode,
			});
		}
	}
	return params;
}

function splitParamList(list: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (let i = 0; i < list.length; i++) {
		const c = list[i];
		if (c === '(') {
			depth++;
		}
		if (c === ')') {
			depth--;
		}
		if (c === ',' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += c;
	}
	if (current.trim()) {
		parts.push(current);
	}
	return parts;
}

function extractDeclareAndBody(
	inner: string,
	innerStartOffsetInDdl: number
): { declareVars: RoutineVariable[]; body: string; bodyStartOffsetInDdl: number } {
	const declareMatch = inner.match(/^\s*DECLARE\s+/i);
	let offset = 0;
	let declareVars: RoutineVariable[] = [];

	if (declareMatch) {
		offset = declareMatch[0].length;
		const beginIdx = findTopLevelKeyword(inner, 'BEGIN', offset);
		if (beginIdx < 0) {
			throw new PlpgsqlParseError('DECLARE без BEGIN');
		}
		const declareSection = inner.slice(offset, beginIdx);
		declareVars = parseDeclareSection(declareSection);
		offset = beginIdx + 'BEGIN'.length;
	} else {
		const beginIdx = findTopLevelKeyword(inner, 'BEGIN', 0);
		if (beginIdx < 0) {
			throw new PlpgsqlParseError('Не найден BEGIN в теле функции');
		}
		offset = beginIdx + 'BEGIN'.length;
	}

	const endIdx = findMatchingEnd(inner, offset);
	if (endIdx < 0) {
		throw new PlpgsqlParseError('Не найден завершающий END для внешнего BEGIN');
	}

	const rawSlice = inner.slice(offset, endIdx);
	const body = rawSlice.trim();
	const trimmedStart = rawSlice.indexOf(body);
	const bodyStartOffsetInDdl =
		trimmedStart >= 0 ? innerStartOffsetInDdl + offset + trimmedStart : innerStartOffsetInDdl + offset;
	return { declareVars, body, bodyStartOffsetInDdl };
}

function parseDeclareSection(section: string): RoutineVariable[] {
	const vars: RoutineVariable[] = [];
	const lines = section.split(';');
	for (const line of lines) {
		const t = line.trim();
		if (!t) {
			continue;
		}
		const m = t.match(/^(\w+)\s+(.+)$/s);
		if (m) {
			vars.push({
				name: m[1],
				type: m[2].trim().replace(/\s+:=\s+[\s\S]+$/i, '').replace(/\s+DEFAULT\s+[\s\S]+$/i, ''),
			});
		}
	}
	return vars;
}

function findTopLevelKeyword(text: string, keyword: string, from: number): number {
	const upper = keyword.toUpperCase();
	let depth = 0;
	let i = from;
	while (i < text.length) {
		if (getRegionAt(text, i) !== 'code') {
			i = advancePast(text, i);
			continue;
		}
		const word = readWordAt(text, i);
		if (word) {
			if (depth === 0 && word.toUpperCase() === upper) {
				return i;
			}
			if (/^BEGIN$/i.test(word)) {
				depth++;
			} else if (/^END$/i.test(word) && !isEndOfInnerBlock(text, i)) {
				depth--;
			}
			i += word.length;
			continue;
		}
		i++;
	}
	return -1;
}

function findMatchingEnd(text: string, afterBegin: number): number {
	let depth = 1;
	let caseDepth = 0;
	let i = afterBegin;
	while (i < text.length) {
		if (getRegionAt(text, i) !== 'code') {
			i = advancePast(text, i);
			continue;
		}
		const word = readWordAt(text, i);
		if (word) {
			if (/^CASE$/i.test(word)) {
				// END может встречаться и в выражениях CASE ... END,
				// это не закрывает BEGIN ... END блока.
				caseDepth++;
				i += word.length;
				continue;
			}
			if (/^BEGIN$/i.test(word)) {
				depth++;
				i += word.length;
				continue;
			}
			if (/^END$/i.test(word)) {
				if (caseDepth > 0) {
					caseDepth--;
					i += word.length;
					continue;
				}
				if (isEndOfInnerBlock(text, i)) {
					i += word.length;
					continue;
				}
				depth--;
				if (depth === 0) {
					return i;
				}
			}
			i += word.length;
			continue;
		}
		i++;
	}
	return -1;
}

function skipSpaces(text: string, i: number): number {
	while (i < text.length) {
		const c = text[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		// Line comment: --
		if (c === '-' && text[i + 1] === '-') {
			i += 2;
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
			continue;
		}
		// Block comment: /* ... */
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 2;
			continue;
		}
		break;
	}
	return i;
}

/** END IF / END LOOP / END CASE — не закрывают внешний BEGIN…END. */
function isEndOfInnerBlock(text: string, endOffset: number): boolean {
	const afterEnd = skipSpaces(text, endOffset + 3);
	const suffix = readWordAt(text, afterEnd);
	return suffix !== null && /^(IF|LOOP|CASE)$/i.test(suffix);
}

function lineNumberAt(text: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === '\n') {
			line++;
		}
	}
	return line;
}

/** Все имена переменных для трассировки (параметры IN/INOUT + DECLARE). */
export function collectTraceVariableNames(parsed: ParsedRoutine): string[] {
	const names = new Set<string>();
	for (const p of parsed.parameters) {
		if (p.mode === 'OUT') {
			continue;
		}
		names.add(p.name);
	}
	for (const v of parsed.declareVars) {
		names.add(v.name);
	}
	return [...names];
}
