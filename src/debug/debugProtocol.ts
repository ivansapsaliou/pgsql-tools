/** Префикс в RAISE NOTICE для машинного протокола отладки. */
export const DEBUG_NOTICE_PREFIX = '[PGSQL_TOOLS]';

export type DebugEventType = 'trace' | 'pause' | 'return' | 'error';

export interface DebugTraceEvent {
	type: DebugEventType;
	line: number;
	stmt?: string;
	vars?: Record<string, string>;
	message?: string;
}

export function formatTraceNoticeSql(
	line: number,
	varNames: string[],
	stmtLabel: string
): string {
	const varsJson =
		varNames.length === 0
			? 'NULL'
			: `json_build_object(${varNames
					.map((n) => `'${escapeSqlString(n)}', ${quoteIdent(n)}::text`)
					.join(', ')})`;
	return `RAISE NOTICE '${DEBUG_NOTICE_PREFIX}%', json_build_object('type', 'trace', 'line', ${line}, 'stmt', '${escapeSqlString(
		stmtLabel
	)}', 'vars', ${varsJson});`;
}

export function formatPauseNoticeSql(line: number, sessionKey: number): string {
	return `PERFORM pg_advisory_lock(${sessionKey}, ${line}); RAISE NOTICE '${DEBUG_NOTICE_PREFIX}%', json_build_object('type', 'pause', 'line', ${line});`;
}

export function formatReturnNoticeSql(varName: string): string {
	return `RAISE NOTICE '${DEBUG_NOTICE_PREFIX}%', json_build_object('type', 'return', 'line', 0, 'vars', json_build_object('result', ${quoteIdent(
		varName
	)}::text));`;
}

export function parseDebugNotice(message: string): DebugTraceEvent | null {
	const idx = message.indexOf(DEBUG_NOTICE_PREFIX);
	if (idx < 0) {
		return null;
	}
	let payload = message.slice(idx + DEBUG_NOTICE_PREFIX.length).trim();
	if (payload.startsWith('%')) {
		payload = payload.slice(1).trim();
	}
	// pg may prefix with "NOTICE:  "
	const jsonStart = payload.indexOf('{');
	if (jsonStart < 0) {
		return null;
	}
	try {
		const obj = JSON.parse(payload.slice(jsonStart)) as Record<string, unknown>;
		return {
			type: (obj.type as DebugEventType) || 'trace',
			line: Number(obj.line) || 0,
			stmt: obj.stmt as string | undefined,
			vars: (obj.vars as Record<string, string>) || undefined,
			message: obj.message as string | undefined,
		};
	} catch {
		return null;
	}
}

function escapeSqlString(s: string): string {
	return s.replace(/'/g, "''");
}

function quoteIdent(name: string): string {
	if (/^[a-z_][a-z0-9_$]*$/i.test(name)) {
		return name;
	}
	return `"${name.replace(/"/g, '""')}"`;
}

export function escapePgLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}
