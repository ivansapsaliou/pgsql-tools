import * as vscode from 'vscode';
import { SQLParser, type AliasMap, type ColumnResolver } from './sqlParser';
import {
	SqlSchemaRegistry,
	type ColumnInfo,
	type RelationInfo,
} from './sqlSchemaRegistry';

export type CompletionKind =
	| 'schema'
	| 'table'
	| 'column'
	| 'routine'
	| 'keyword'
	| 'insertColumn'
	| 'connectHint'
	| 'general';

export interface ScopeColumn {
	name: string;
	type?: string;
	source?: string;
	nullable?: boolean;
	comment?: string | null;
}

export interface SqlCompletionContext {
	kind: CompletionKind;
	prefix: string;
	rawPrefix: string;
	qualifier?: string;
	clause: string;
	triggerKind: 'dot' | 'word';
	stmtText: string;
	textBeforeInStmt: string;
	scopeColumns: ScopeColumn[];
	scopeRelations: RelationInfo[];
	cteNames: string[];
	aliases: AliasMap;
	inNoise: boolean;
}

const COLUMN_CLAUSES = new Set([
	'SELECT',
	'WHERE',
	'ON',
	'HAVING',
	'GROUP BY',
	'ORDER BY',
	'SET',
]);

const TABLE_CLAUSES = new Set(['FROM', 'JOIN', 'INSERT INTO', 'UPDATE', 'DELETE FROM']);

function registryColumnResolver(registry: SqlSchemaRegistry): ColumnResolver {
	return {
		getColumnNames(schema: string, relation: string): string[] {
			return registry.getRelationColumns(schema, relation).map((c) => c.name);
		},
		getRelationSchema(relation: string): string | undefined {
			return registry.getTableSchema(relation);
		},
	};
}

function collectScopeColumns(
	registry: SqlSchemaRegistry,
	aliases: AliasMap,
	ctes: Map<string, string>,
	tableIndex: Map<string, string>
): ScopeColumn[] {
	const resolver = registryColumnResolver(registry);
	const seen = new Set<string>();
	const out: ScopeColumn[] = [];

	const addCol = (col: ScopeColumn) => {
		if (seen.has(col.name)) {
			return;
		}
		seen.add(col.name);
		out.push(col);
	};

	for (const [alias, source] of Object.entries(aliases)) {
		if (source.kind === 'table' && source.table) {
			const schema =
				source.schema || registry.getTableSchema(source.table) || 'public';
			for (const c of registry.getRelationColumns(schema, source.table)) {
				addCol({
					name: c.name,
					type: c.type,
					source: alias,
					nullable: c.nullable,
					comment: c.comment,
				});
			}
		} else if (source.kind === 'cte' && source.table) {
			const cols =
				source.columns ??
				(() => {
					const body = ctes.get(source.table);
					return body
						? SQLParser.resolveSelectOutputColumns(
								body,
								ctes,
								tableIndex,
								resolver,
								true
							)
						: [];
				})();
			for (const name of cols) {
				addCol({ name, source: alias });
			}
		} else if (source.kind === 'subquery' && source.columns) {
			for (const name of source.columns) {
				addCol({ name, source: alias });
			}
		}
	}

	return out;
}

function detectCompletionKind(
	triggerKind: 'dot' | 'word',
	qualifier: string | null | undefined,
	clause: string,
	textBeforeInStmt: string
): CompletionKind {
	if (triggerKind === 'dot' && qualifier) {
		return 'column';
	}

	const insertTarget = SQLParser.detectInsertTarget(textBeforeInStmt);
	if (insertTarget && /\(\s*[^)]*$/.test(textBeforeInStmt.slice(-80))) {
		return 'insertColumn';
	}

	if (TABLE_CLAUSES.has(clause)) {
		return 'table';
	}
	if (COLUMN_CLAUSES.has(clause)) {
		return 'column';
	}
	return 'general';
}

function isCompletionNoise(text: string, offset: number): boolean {
	const region = SQLParser.getLexRegionAt(text, Math.max(0, offset - 1));
	return region === 'line-comment' || region === 'block-comment' || region === 'string';
}

export function buildSqlCompletionContextFromText(
	text: string,
	offset: number,
	registry: SqlSchemaRegistry
): SqlCompletionContext {
	if (offset < 0 || offset > text.length) {
		offset = text.length;
	}

	if (isCompletionNoise(text, offset)) {
		return {
			kind: 'general',
			prefix: '',
			rawPrefix: '',
			clause: 'SELECT',
			triggerKind: 'word',
			stmtText: '',
			textBeforeInStmt: '',
			scopeColumns: [],
			scopeRelations: [],
			cteNames: [],
			aliases: {},
			inNoise: true,
		};
	}

	const textBeforeCursor = text.slice(0, offset);
	const { text: stmtText, start: stmtStart } = SQLParser.findQueryScopeAt(
		text,
		offset,
		true
	);
	const offsetInStmt = offset - stmtStart;
	const textBeforeInStmt = stmtText.slice(0, offsetInStmt);

	const { qualifier, prefix, triggerKind, rawPrefix } =
		SQLParser.getPrefixContext(textBeforeCursor);
	const clause = SQLParser.detectClause(textBeforeInStmt.toUpperCase());

	const ctes = SQLParser.parseCTEs(stmtText, true);
	const tableIndex = registry.getTableIndex();
	const resolver = registryColumnResolver(registry);
	const aliases = SQLParser.parseAliases(
		stmtText,
		new Set(ctes.keys()),
		tableIndex,
		true,
		ctes,
		resolver
	);

	const scopeColumns = collectScopeColumns(registry, aliases, ctes, tableIndex);
	const scopeRelations = registry.getAllRelations();
	const kind = detectCompletionKind(triggerKind, qualifier, clause, textBeforeInStmt);

	return {
		kind,
		prefix,
		rawPrefix: rawPrefix ?? prefix,
		qualifier: qualifier ?? undefined,
		clause,
		triggerKind,
		stmtText,
		textBeforeInStmt,
		scopeColumns,
		scopeRelations,
		cteNames: [...ctes.keys()],
		aliases,
		inNoise: false,
	};
}

export function buildSqlCompletionContext(
	document: vscode.TextDocument,
	position: vscode.Position,
	registry: SqlSchemaRegistry
): SqlCompletionContext {
	const offset = document.offsetAt(position);
	return buildSqlCompletionContextFromText(document.getText(), offset, registry);
}

export function columnInfoToScope(col: ColumnInfo, source?: string): ScopeColumn {
	return {
		name: col.name,
		type: col.type,
		source,
		nullable: col.nullable,
		comment: col.comment,
	};
}
