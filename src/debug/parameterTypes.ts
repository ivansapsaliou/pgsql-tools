import type { RoutineParameterInfo } from '../database/queryExecutor';

export type ParameterWidgetKind =
	| 'number'
	| 'boolean'
	| 'date'
	| 'datetime'
	| 'time'
	| 'uuid'
	| 'json'
	| 'array'
	| 'text'
	| 'sql';

export interface ClassifiedParameter {
	kind: ParameterWidgetKind;
	hint: string;
	maxLength?: number;
	udtName: string;
	/** Тип элемента массива (bigint, text, …). */
	elementType?: string;
	/** Полное имя типа массива для ::cast (bigint[], text[], …). */
	pgArrayType?: string;
}

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Распознаёт PostgreSQL-массив: `bigint[]`, `_int8`, `ARRAY` + udt `_text`. */
export function getArrayTypeInfo(param: RoutineParameterInfo): {
	elementType: string;
	pgArrayType: string;
} | null {
	const udt = (param.udtName || '').trim().toLowerCase();
	const dt = (param.dataType || '').trim().toLowerCase();

	if (udt.endsWith('[]')) {
		const elementType = udt.slice(0, -2);
		return { elementType, pgArrayType: udt };
	}
	if (udt.startsWith('_') && udt.length > 1) {
		const elementType = udt.slice(1);
		return { elementType, pgArrayType: `${elementType}[]` };
	}
	if (dt === 'array' && udt.startsWith('_')) {
		const elementType = udt.slice(1);
		return { elementType, pgArrayType: `${elementType}[]` };
	}
	if (dt.endsWith('[]')) {
		const elementType = dt.slice(0, -2);
		return { elementType, pgArrayType: dt };
	}
	return null;
}

function isNumericElementType(elementType: string): boolean {
	const e = elementType.toLowerCase().split('(')[0].trim();
	return /^(int2|int4|int8|integer|smallint|bigint|numeric|decimal|float4|float8|real|double|oid|serial|bigserial|smallserial)$/.test(
		e
	);
}

function isBooleanElementType(elementType: string): boolean {
	return elementType.toLowerCase() === 'bool' || elementType.toLowerCase() === 'boolean';
}

function splitCommaSeparatedValues(input: string): string[] {
	const out: string[] = [];
	let cur = '';
	let inQuote = false;
	let quoteChar = '';
	for (let i = 0; i < input.length; i++) {
		const c = input[i]!;
		if ((c === '"' || c === "'") && !inQuote) {
			inQuote = true;
			quoteChar = c;
			continue;
		}
		if (inQuote && c === quoteChar) {
			inQuote = false;
			quoteChar = '';
			continue;
		}
		if (c === ',' && !inQuote) {
			const t = cur.trim();
			if (t.length > 0) {
				out.push(t);
			}
			cur = '';
			continue;
		}
		cur += c;
	}
	const tail = cur.trim();
	if (tail.length > 0) {
		out.push(tail);
	}
	return out;
}

/** Разбирает ввод массива: JSON, `{a,b}`, `ARRAY[…]`, через запятую. */
export function parseArrayElements(input: string): string[] {
	const trimmed = input.trim();
	if (!trimmed) {
		return [];
	}
	if (/^ARRAY\s*\[/i.test(trimmed)) {
		const inner = trimmed.replace(/^ARRAY\s*\[/i, '').replace(/\]\s*(::[\s\S]*)?$/, '');
		return splitCommaSeparatedValues(inner);
	}
	if (trimmed.startsWith('[')) {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!Array.isArray(parsed)) {
			throw new Error('Ожидается JSON-массив');
		}
		return parsed.map((v) => (v === null ? 'NULL' : String(v)));
	}
	if (trimmed.startsWith('{')) {
		const inner = trimmed.replace(/^\{/, '').replace(/\}(\s*::[\s\S]*)?$/, '');
		return splitCommaSeparatedValues(inner);
	}
	return splitCommaSeparatedValues(trimmed);
}

function validateArrayElements(elements: string[], elementType: string): ValidationResult {
	if (elements.length === 0) {
		return { valid: true };
	}
	const elemKind = classifyScalarElement(elementType);
	for (const el of elements) {
		if (el.toUpperCase() === 'NULL') {
			continue;
		}
		const r = validateParameterValue(el, elemKind, false);
		if (!r.valid) {
			return { valid: false, error: `Элемент «${el}»: ${r.error}` };
		}
	}
	return { valid: true };
}

function classifyScalarElement(elementType: string): ClassifiedParameter {
	const fake: RoutineParameterInfo = {
		name: '_elem',
		dataType: elementType,
		udtName: elementType,
		mode: 'IN',
		ordinalPosition: 1,
	};
	return classifyParameterType(fake);
}

function formatPgArrayLiteral(elements: string[], elementType: string): string {
	if (elements.length === 0) {
		return 'ARRAY[]';
	}
	if (isNumericElementType(elementType)) {
		return `ARRAY[${elements.map((e) => (e.toUpperCase() === 'NULL' ? 'NULL' : e)).join(', ')}]`;
	}
	if (isBooleanElementType(elementType)) {
		return `ARRAY[${elements
			.map((e) => {
				const v = e.toLowerCase();
				if (v === 't' || v === '1') {
					return 'true';
				}
				if (v === 'f' || v === '0') {
					return 'false';
				}
				return v;
			})
			.join(', ')}]`;
	}
	return `ARRAY[${elements
		.map((e) => (e.toUpperCase() === 'NULL' ? 'NULL' : escapeSqlString(e)))
		.join(', ')}]`;
}

function normalizePgArrayTypeName(elementType: string): string {
	const e = elementType.toLowerCase();
	if (e === 'bool') {
		return 'boolean[]';
	}
	if (e === 'int4') {
		return 'integer[]';
	}
	if (e === 'int8') {
		return 'bigint[]';
	}
	if (e === 'int2') {
		return 'smallint[]';
	}
	if (e === 'float8') {
		return 'double precision[]';
	}
	if (e === 'float4') {
		return 'real[]';
	}
	if (e === 'bpchar' || e === 'varchar') {
		return 'text[]';
	}
	return `${e}[]`;
}

/** Подпись типа в UI: «bigint», а не «USER-DEFINED» / «text». */
export function formatParameterTypeLabel(param: RoutineParameterInfo): string {
	const dt = (param.dataType || '').toUpperCase();
	if (dt === 'USER-DEFINED' || dt === 'ARRAY') {
		return param.udtName || param.dataType || 'unknown';
	}
	const udt = param.udtName || '';
	if (udt && udt !== param.dataType && !param.dataType.includes(udt)) {
		return param.dataType;
	}
	return param.udtName || param.dataType || 'unknown';
}

export function classifyParameterType(param: RoutineParameterInfo): ClassifiedParameter {
	const arrayInfo = getArrayTypeInfo(param);
	if (arrayInfo) {
		const label = arrayInfo.pgArrayType;
		return {
			kind: 'array',
			hint: 'Массив: 1, 2, 3 или [1,2,3] или {1,2,3}',
			udtName: label,
			elementType: arrayInfo.elementType,
			pgArrayType: label,
		};
	}

	const typname = (param.udtName || '').toLowerCase();
	const udt = typname || (param.dataType || 'text').toLowerCase();
	const dt = (param.dataType || '').toLowerCase();

	if (udt === 'bool' || dt === 'boolean') {
		return { kind: 'boolean', hint: 'true или false', udtName: udt };
	}
	if (udt === 'date') {
		return { kind: 'date', hint: 'YYYY-MM-DD', udtName: udt };
	}
	if (udt === 'time' || udt === 'timetz') {
		return { kind: 'time', hint: 'HH:MM:SS', udtName: udt };
	}
	if (
		udt.includes('timestamp') ||
		dt.includes('timestamp') ||
		udt === 'timestamptz'
	) {
		return { kind: 'datetime', hint: 'Дата и время', udtName: udt };
	}
	if (typname === 'json' || typname === 'jsonb' || udt === 'json' || udt === 'jsonb') {
		return { kind: 'json', hint: 'JSON объект или массив', udtName: udt };
	}
	if (
		/^(int2|int4|int8|integer|smallint|bigint|numeric|decimal|float4|float8|real|double|money|serial|bigserial|smallserial|oid)/.test(
			typname
		) ||
		/^(int|int2|int4|int8|integer|smallint|bigint|numeric|decimal|real|double|float|money)/.test(
			udt
		) ||
		/^(integer|smallint|bigint|numeric|real|double precision)/.test(dt)
	) {
		return { kind: 'number', hint: 'Число', udtName: typname || udt };
	}
	if (typname === 'uuid' || udt === 'uuid') {
		return { kind: 'uuid', hint: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', udtName: 'uuid' };
	}
	if (udt === 'text' || typname === 'text' || typname === 'varchar' || typname === 'bpchar' || dt.includes('character')) {
		return {
			kind: 'text',
			hint: 'Текст',
			maxLength: param.characterMaximumLength ?? undefined,
			udtName: udt,
		};
	}
	return {
		kind: 'sql',
		hint: 'SQL-литерал или выражение (например NULL, \'текст\', ARRAY[1,2])',
		udtName: udt,
	};
}

export function validateParameterValue(
	value: string,
	classified: ClassifiedParameter,
	allowEmpty: boolean
): ValidationResult {
	const trimmed = value.trim();
	if (!trimmed) {
		if (allowEmpty) {
			return { valid: true };
		}
		return { valid: false, error: 'Укажите значение или NULL' };
	}
	if (trimmed.toUpperCase() === 'NULL') {
		return { valid: true };
	}

	switch (classified.kind) {
		case 'number':
			if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) {
				return { valid: false, error: 'Ожидается число' };
			}
			break;
		case 'boolean':
			if (!/^(true|false|t|f|1|0)$/i.test(trimmed)) {
				return { valid: false, error: 'Ожидается true/false' };
			}
			break;
		case 'date':
			if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
				return { valid: false, error: 'Формат: YYYY-MM-DD' };
			}
			break;
		case 'datetime':
			if (!/^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}(:\d{2})?/.test(trimmed)) {
				return { valid: false, error: 'Укажите дату и время' };
			}
			break;
		case 'time':
			if (!/^\d{2}:\d{2}(:\d{2})?/.test(trimmed)) {
				return { valid: false, error: 'Формат: HH:MM:SS' };
			}
			break;
		case 'uuid':
			if (!UUID_RE.test(trimmed)) {
				return { valid: false, error: 'Некорректный UUID' };
			}
			break;
		case 'json':
			try {
				JSON.parse(trimmed);
			} catch {
				return { valid: false, error: 'Некорректный JSON' };
			}
			break;
		case 'array':
			try {
				const elements = parseArrayElements(trimmed);
				return validateArrayElements(elements, classified.elementType || 'text');
			} catch (e) {
				return {
					valid: false,
					error: e instanceof Error ? e.message : 'Некорректный массив',
				};
			}
		case 'text':
			if (classified.maxLength && trimmed.length > classified.maxLength) {
				return {
					valid: false,
					error: `Максимум ${classified.maxLength} символов`,
				};
			}
			break;
		default:
			break;
	}
	return { valid: true };
}

function escapeSqlString(s: string): string {
	return `'${s.replace(/'/g, "''")}'`;
}

/** Безопасный ::cast для литерала (только известные скалярные имена). */
function pgCastSuffix(udtName: string): string {
	const u = udtName.trim().toLowerCase();
	if (u.includes('timestamp without time zone')) {
		return '::timestamp without time zone';
	}
	if (u.includes('timestamp with time zone') || u === 'timestamptz') {
		return '::timestamptz';
	}
	if (u.includes('timestamp')) {
		return '::timestamp';
	}
	if (u.includes('time without time zone')) {
		return '::time without time zone';
	}
	if (u.includes('time with time zone') || u === 'timetz') {
		return '::timetz';
	}
	if (/^(bigint|int8|integer|int4|int2|smallint|numeric|decimal|real|double precision|float8|float4|oid)$/.test(
		u.split('(')[0].trim()
	)) {
		return `::${u.split('(')[0].trim()}`;
	}
	if (/^numeric\s*\(\s*\d+\s*,\s*\d+\s*\)$/i.test(u)) {
		return `::${u}`;
	}
	return '';
}

function normalizeDatetimeForPg(value: string): string {
	let v = value.trim().replace('T', ' ');
	if (/^\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}$/.test(v)) {
		v += ':00';
	}
	return v;
}

/** Преобразует значение из формы в SQL-фрагмент для присваивания (правая часть :=). */
export function toSqlLiteral(value: string, classified: ClassifiedParameter): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.toUpperCase() === 'NULL') {
		return 'NULL';
	}

	switch (classified.kind) {
		case 'number': {
			const suffix = pgCastSuffix(classified.udtName);
			return suffix ? `${trimmed}${suffix}` : trimmed;
		}
		case 'boolean': {
			const v = trimmed.toLowerCase();
			if (v === 't' || v === '1') {
				return 'true';
			}
			if (v === 'f' || v === '0') {
				return 'false';
			}
			return v;
		}
		case 'date':
			return `${escapeSqlString(trimmed)}::date`;
		case 'datetime': {
			const normalized = normalizeDatetimeForPg(trimmed);
			const suffix = pgCastSuffix(classified.udtName) || '::timestamp';
			return `${escapeSqlString(normalized)}${suffix}`;
		}
		case 'time':
			return `${escapeSqlString(trimmed)}::time`;
		case 'uuid':
			return `${escapeSqlString(trimmed)}::uuid`;
		case 'json': {
			const cast = classified.udtName === 'json' || classified.udtName === 'jsonb' ? classified.udtName : 'jsonb';
			return `${escapeSqlString(trimmed)}::${cast}`;
		}
		case 'array': {
			if (/^ARRAY\s*\[/i.test(trimmed)) {
				const castType = classified.pgArrayType || normalizePgArrayTypeName(classified.elementType || 'text');
				return trimmed.includes('::') ? trimmed : `${trimmed}::${castType}`;
			}
			if (/^\{/.test(trimmed)) {
				const castType = classified.pgArrayType || normalizePgArrayTypeName(classified.elementType || 'text');
				return trimmed.includes('::') ? trimmed : `${trimmed}::${castType}`;
			}
			const elements = parseArrayElements(trimmed);
			const castType = classified.pgArrayType || normalizePgArrayTypeName(classified.elementType || 'text');
			const literal = formatPgArrayLiteral(elements, classified.elementType || 'text');
			return `${literal}::${castType}`;
		}
		case 'text':
			return escapeSqlString(trimmed);
		case 'sql':
			if (
				trimmed.startsWith("'") ||
				trimmed.startsWith('(') ||
				/^[a-z_]/i.test(trimmed) ||
				/^-?\d/.test(trimmed)
			) {
				return trimmed;
			}
			return escapeSqlString(trimmed);
		default:
			return trimmed;
	}
}

export function parameterInfoToFormField(param: RoutineParameterInfo): {
	name: string;
	mode: string;
	dataType: string;
	classified: ClassifiedParameter;
	ordinalPosition: number;
} {
	return {
		name: param.name,
		mode: param.mode,
		dataType: formatParameterTypeLabel(param),
		classified: classifyParameterType(param),
		ordinalPosition: param.ordinalPosition,
	};
}
