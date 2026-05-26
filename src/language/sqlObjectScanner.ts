import * as vscode from 'vscode';
import { SQLParser } from './sqlParser';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import { isSqlReservedWord } from './sqlReservedWords';

/** Scan identifiers inside $$ PL/pgSQL bodies as well. */
const OBJECT_SCAN = true;

export type SqlObjectRef =
	| { kind: 'table'; schema: string; name: string; range: vscode.Range }
	| { kind: 'view'; schema: string; name: string; range: vscode.Range }
	| { kind: 'function'; schema: string; name: string; range: vscode.Range }
	| { kind: 'procedure'; schema: string; name: string; range: vscode.Range }
	| {
			kind: 'column';
			schema: string;
			table: string;
			column: string;
			range: vscode.Range;
	  };

function rangeFromOffsets(
	document: vscode.TextDocument,
	start: number,
	end: number
): vscode.Range {
	return new vscode.Range(document.positionAt(start), document.positionAt(end));
}

function parseAliasesInScope(
	registry: SqlSchemaRegistry,
	stmtText: string
): ReturnType<typeof SQLParser.parseAliases> {
	const ctes = SQLParser.parseCTEs(stmtText, OBJECT_SCAN);
	return SQLParser.parseAliases(
		stmtText,
		new Set(ctes.keys()),
		registry.getTableIndex(),
		OBJECT_SCAN
	);
}

function resolveTableFromAlias(
	registry: SqlSchemaRegistry,
	aliases: ReturnType<typeof SQLParser.parseAliases>,
	qualifier: string
): { schema: string; table: string } | undefined {
	const source = aliases[qualifier];
	if (!source || source.kind !== 'table' || !source.table) {
		return undefined;
	}
	const schema = source.schema || registry.getTableSchema(source.table) || 'public';
	return { schema, table: source.table };
}

/** Tables in scope that expose this column (for duplicate column names). */
function tablesWithColumnInScope(
	registry: SqlSchemaRegistry,
	aliases: ReturnType<typeof SQLParser.parseAliases>,
	column: string
): Array<{ schema: string; table: string; alias: string }> {
	const out: Array<{ schema: string; table: string; alias: string }> = [];
	const seen = new Set<string>();

	for (const [alias, source] of Object.entries(aliases)) {
		if (source.kind !== 'table' || !source.table) {
			continue;
		}
		const schema = source.schema || registry.getTableSchema(source.table) || 'public';
		const key = `${schema}.${source.table}`;
		if (seen.has(key)) {
			continue;
		}
		if (!registry.getColumn(schema, source.table, column)) {
			continue;
		}
		seen.add(key);
		out.push({ schema, table: source.table, alias });
	}

	return out;
}

function classifyQualified(
	registry: SqlSchemaRegistry,
	stmtText: string,
	stmtStart: number,
	parts: string[],
	identStart: number,
	identEnd: number,
	document: vscode.TextDocument
): SqlObjectRef | null {
	if (isBlockedIdentifier(...parts)) {
		return null;
	}

	const range = rangeFromOffsets(document, stmtStart + identStart, stmtStart + identEnd);
	const aliases = parseAliasesInScope(registry, stmtText);

	if (parts.length === 3) {
		const [a, b, c] = parts;
		if (registry.hasSchema(a)) {
			if (registry.hasTable(a, b) || registry.findTable(a, b)) {
				const col = registry.getColumn(a, b, c);
				if (col) {
					const colStart = identStart + parts[0].length + 1 + parts[1].length + 1;
					return {
						kind: 'column',
						schema: a,
						table: b,
						column: c,
						range: rangeFromOffsets(
							document,
							stmtStart + colStart,
							stmtStart + identEnd
						),
					};
				}
			}
			const view = registry.findView(a, b);
			if (view && c === view.name) {
				return { kind: 'view', schema: a, name: b, range };
			}
		}
		const fromAlias = resolveTableFromAlias(registry, aliases, a);
		if (fromAlias) {
			const col = registry.getColumn(fromAlias.schema, fromAlias.table, c);
			if (col) {
				const colStart = identStart + parts[0].length + 1 + parts[1].length + 1;
				return {
					kind: 'column',
					schema: fromAlias.schema,
					table: fromAlias.table,
					column: c,
					range: rangeFromOffsets(document, stmtStart + colStart, stmtStart + identEnd),
				};
			}
		}
	}

	if (parts.length === 2) {
		const [a, b] = parts;
		const fromAlias = resolveTableFromAlias(registry, aliases, a);
		if (fromAlias) {
			const col = registry.getColumn(fromAlias.schema, fromAlias.table, b);
			if (col) {
				const colStart = identStart + parts[0].length + 1;
				return {
					kind: 'column',
					schema: fromAlias.schema,
					table: fromAlias.table,
					column: b,
					range: rangeFromOffsets(document, stmtStart + colStart, stmtStart + identEnd),
				};
			}
		}
		// table.column (table name as qualifier, not alias)
		const tableSchema = registry.getTableSchema(a);
		if (tableSchema) {
			const col = registry.getColumn(tableSchema, a, b);
			if (col) {
				const colStart = identStart + parts[0].length + 1;
				return {
					kind: 'column',
					schema: tableSchema,
					table: a,
					column: b,
					range: rangeFromOffsets(document, stmtStart + colStart, stmtStart + identEnd),
				};
			}
		}
		if (registry.hasSchema(a)) {
			if (registry.hasTable(a, b) || registry.findTable(a, b)) {
				const nameStart = identStart + parts[0].length + 1;
				return {
					kind: 'table',
					schema: a,
					name: b,
					range: rangeFromOffsets(document, stmtStart + nameStart, stmtStart + identEnd),
				};
			}
			const view = registry.findView(a, b);
			if (view) {
				const nameStart = identStart + parts[0].length + 1;
				return {
					kind: 'view',
					schema: a,
					name: b,
					range: rangeFromOffsets(document, stmtStart + nameStart, stmtStart + identEnd),
				};
			}
			const routine = registry.findRoutine(a, b);
			if (routine) {
				const nameStart = identStart + parts[0].length + 1;
				return {
					kind: routine.kind,
					schema: a,
					name: b,
					range: rangeFromOffsets(document, stmtStart + nameStart, stmtStart + identEnd),
				};
			}
		}
	}

	return null;
}

function classifyUnqualifiedColumn(
	registry: SqlSchemaRegistry,
	stmtText: string,
	stmtStart: number,
	column: string,
	identStart: number,
	identEnd: number,
	document: vscode.TextDocument
): SqlObjectRef | null {
	const aliases = parseAliasesInScope(registry, stmtText);
	const matches = tablesWithColumnInScope(registry, aliases, column);
	if (matches.length !== 1) {
		return null;
	}
	const { schema, table } = matches[0];
	return {
		kind: 'column',
		schema,
		table,
		column,
		range: rangeFromOffsets(document, stmtStart + identStart, stmtStart + identEnd),
	};
}

function isBlockedIdentifier(...parts: string[]): boolean {
	return parts.some((p) => isSqlReservedWord(p));
}

function classifySingle(
	registry: SqlSchemaRegistry,
	stmtText: string,
	stmtStart: number,
	sql: string,
	name: string,
	identStart: number,
	identEnd: number,
	document: vscode.TextDocument
): SqlObjectRef | null {
	if (isSqlReservedWord(name)) {
		return null;
	}

	const range = rangeFromOffsets(document, stmtStart + identStart, stmtStart + identEnd);
	const absEnd = stmtStart + identEnd;

	if (SQLParser.isCallSite(sql, absEnd)) {
		const routine = registry.findRoutine(undefined, name);
		if (routine) {
			return { kind: routine.kind, schema: routine.schema, name: routine.name, range };
		}
	}

	const table = registry.findTable(undefined, name);
	if (table) {
		return { kind: 'table', schema: table.schema, name: table.table, range };
	}

	const view = registry.findView(undefined, name);
	if (view) {
		return { kind: 'view', schema: view.schema, name: view.name, range };
	}

	const aliases = parseAliasesInScope(registry, stmtText);
	if (aliases[name]) {
		const src = aliases[name];
		if (src.kind === 'table' && src.table) {
			const schema = src.schema || registry.getTableSchema(src.table) || 'public';
			if (registry.hasTable(schema, src.table) || registry.findTable(schema, src.table)) {
				return { kind: 'table', schema, name: src.table, range };
			}
		}
	}

	return classifyUnqualifiedColumn(
		registry,
		stmtText,
		stmtStart,
		name,
		identStart,
		identEnd,
		document
	);
}

export function getObjectRefAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position,
	registry: SqlSchemaRegistry
): SqlObjectRef | null {
	const sql = document.getText();
	const offset = document.offsetAt(position);
	if (SQLParser.isNoiseAt(sql, offset, OBJECT_SCAN)) {
		return null;
	}

	const { text: scopeText, start: scopeStart } = SQLParser.findQueryScopeAt(
		sql,
		offset,
		OBJECT_SCAN
	);
	const offsetInScope = offset - scopeStart;
	const ident = SQLParser.getQualifiedIdentifierAt(scopeText, offsetInScope, OBJECT_SCAN);
	if (!ident) {
		return null;
	}

	if (ident.parts.length >= 2) {
		return classifyQualified(
			registry,
			scopeText,
			scopeStart,
			ident.parts,
			ident.start,
			ident.end,
			document
		);
	}

	const name = ident.parts[0];
	return classifySingle(
		registry,
		scopeText,
		scopeStart,
		sql,
		name,
		ident.start,
		ident.end,
		document
	);
}

function refKey(ref: SqlObjectRef): string {
	if (ref.kind === 'column') {
		return `column:${ref.schema}.${ref.table}.${ref.column}@${ref.range.start.line}:${ref.range.start.character}`;
	}
	return `${ref.kind}:${ref.schema}.${ref.name}@${ref.range.start.line}:${ref.range.start.character}`;
}

export function scanObjectRefsInDocument(
	document: vscode.TextDocument,
	registry: SqlSchemaRegistry
): SqlObjectRef[] {
	const sql = document.getText();
	const refs: SqlObjectRef[] = [];
	const seen = new Set<string>();

	const re =
		/(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*))*/g;
	let m: RegExpExecArray | null;

	while ((m = re.exec(sql)) !== null) {
		const start = m.index;
		if (SQLParser.isNoiseAt(sql, start, OBJECT_SCAN)) {
			continue;
		}

		const end = start + m[0].length;
		const pos = document.positionAt(Math.max(start, end - 1));
		const ref = getObjectRefAtPosition(document, pos, registry);
		if (!ref) {
			continue;
		}

		const key = refKey(ref);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		refs.push(ref);
	}

	return refs;
}
