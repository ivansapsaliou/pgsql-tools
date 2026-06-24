import * as vscode from 'vscode';
import { SQLParser } from './sqlParser';
import {
	SqlSchemaRegistry,
	type ColumnInfo,
	type RelationInfo,
} from './sqlSchemaRegistry';
import {
	buildSqlCompletionContextFromText,
	type SqlCompletionContext,
} from './sqlCompletionContext';
import {
	builtinFunctionsByPrefix,
	formatBuiltinSignature,
} from './sqlBuiltinFunctions';

export interface SqlCompletionItemDto {
	label: string;
	kind: number;
	detail?: string;
	documentation?: string;
	insertText?: string;
	sortText?: string;
	filterText?: string;
	rangeOffset: number;
	rangeLength: number;
}

export interface SqlCompletionResult {
	items: SqlCompletionItemDto[];
	isIncomplete: boolean;
}

export function isIntelliSenseEnabled(): boolean {
	return vscode.workspace
		.getConfiguration('pgsql-tools.intelliSense')
		.get<boolean>('enabled', true);
}

function wordRangeAtOffset(
	text: string,
	offset: number,
	rawPrefix: string
): { start: number; length: number } {
	if (rawPrefix) {
		return { start: Math.max(0, offset - rawPrefix.length), length: rawPrefix.length };
	}
	let start = offset;
	while (start > 0 && /[\w"]/.test(text[start - 1])) {
		start--;
	}
	return { start, length: offset - start };
}

function toDto(
	item: vscode.CompletionItem,
	range: { start: number; length: number }
): SqlCompletionItemDto {
	const doc =
		item.documentation instanceof vscode.MarkdownString
			? item.documentation.value
			: typeof item.documentation === 'string'
				? item.documentation
				: undefined;
	const insertText =
		item.insertText instanceof vscode.SnippetString
			? item.insertText.value
			: typeof item.insertText === 'string'
				? item.insertText
				: undefined;
	return {
		label: typeof item.label === 'string' ? item.label : item.label.label,
		kind: item.kind ?? vscode.CompletionItemKind.Text,
		detail: item.detail,
		documentation: doc,
		insertText,
		sortText: item.sortText,
		filterText: item.filterText,
		rangeOffset: range.start,
		rangeLength: range.length,
	};
}

export async function computeSqlCompletions(
	registry: SqlSchemaRegistry,
	text: string,
	offset: number
): Promise<SqlCompletionResult> {
	if (!isIntelliSenseEnabled()) {
		return { items: [], isIncomplete: false };
	}

	if (!registry.isConnected()) {
		const item = new vscode.CompletionItem(
			'Подключитесь к PostgreSQL…',
			vscode.CompletionItemKind.Text
		);
		item.detail = 'PostgreSQL Tools — нет активного подключения';
		item.sortText = '0';
		return {
			items: [toDto(item, { start: offset, length: 0 })],
			isIncomplete: false,
		};
	}

	const loaded = await registry.ensureFresh();
	const ctx = buildSqlCompletionContextFromText(text, offset, registry);
	if (ctx.inNoise) {
		return { items: [], isIncomplete: false };
	}

	const range = wordRangeAtOffset(text, offset, ctx.rawPrefix);
	const builder = new SqlCompletionItemBuilder(registry);
	const items = builder.build(ctx, range);
	return { items: items.map((i) => toDto(i, range)), isIncomplete: !loaded };
}

class SqlCompletionItemBuilder {
	constructor(private registry: SqlSchemaRegistry) {}

	build(ctx: SqlCompletionContext, _range: { start: number; length: number }): vscode.CompletionItem[] {
		if (ctx.triggerKind === 'dot' && ctx.qualifier) {
			return this.getQualifiedCompletions(ctx);
		}

		const items: vscode.CompletionItem[] = [];
		switch (ctx.kind) {
			case 'table':
				items.push(
					...this.getRelationCompletions(ctx),
					...this.getCteCompletions(ctx),
					...this.getSchemaCompletions(ctx)
				);
				break;
			case 'column':
			case 'insertColumn':
				items.push(...this.getColumnCompletions(ctx));
				break;
			default:
				items.push(
					...this.getRelationCompletions(ctx),
					...this.getColumnCompletions(ctx),
					...this.getRoutineCompletions(ctx),
					...this.getSchemaCompletions(ctx),
					...this.getBuiltinCompletions(ctx),
					...this.getKeywordCompletions(ctx)
				);
		}
		return items;
	}

	private getQualifiedCompletions(ctx: SqlCompletionContext): vscode.CompletionItem[] {
		const { qualifier, prefix } = ctx;
		if (!qualifier) {
			return [];
		}

		const source = ctx.aliases[qualifier];
		if (source) {
			return this.columnsFromSource(source, ctx, prefix, qualifier);
		}

		if (this.registry.hasSchema(qualifier)) {
			return this.registry
				.getAllRelations()
				.filter((r) => r.schema.toLowerCase() === qualifier)
				.filter((r) => r.name.toLowerCase().startsWith(prefix))
				.map((r) => this.relationItem(r));
		}

		const schema = this.registry.getTableSchema(qualifier);
		if (schema) {
			return this.columnItems(this.registry.getRelationColumns(schema, qualifier), prefix);
		}

		return [];
	}

	private columnsFromSource(
		source: { kind: string; schema?: string; table?: string; columns?: string[] },
		ctx: SqlCompletionContext,
		prefix: string,
		alias?: string
	): vscode.CompletionItem[] {
		if (source.kind === 'table' && source.table) {
			const schema =
				source.schema || this.registry.getTableSchema(source.table) || 'public';
			return this.columnItems(
				this.registry.getRelationColumns(schema, source.table),
				prefix,
				alias
			);
		}
		if (source.columns && source.columns.length > 0) {
			return source.columns
				.filter((c) => c.toLowerCase().startsWith(prefix))
				.map((c) => {
					const item = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
					item.detail = alias ? `column · ${alias}` : 'column';
					item.sortText = '1' + c;
					return item;
				});
		}
		if (source.kind === 'cte' && source.table) {
			const ctes = SQLParser.parseCTEs(ctx.stmtText, true);
			const body = ctes.get(source.table);
			if (body) {
				const cols = SQLParser.resolveSelectOutputColumns(
					body,
					ctes,
					this.registry.getTableIndex(),
					{
						getColumnNames: (s, r) =>
							this.registry.getRelationColumns(s, r).map((c) => c.name),
						getRelationSchema: (r) => this.registry.getTableSchema(r),
					},
					true
				);
				return cols
					.filter((c) => c.toLowerCase().startsWith(prefix))
					.map((c) => {
						const item = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
						item.detail = `column · CTE ${source.table}`;
						item.sortText = '1' + c;
						return item;
					});
			}
		}
		return [];
	}

	private getColumnCompletions(ctx: SqlCompletionContext): vscode.CompletionItem[] {
		const { prefix } = ctx;

		if (ctx.kind === 'insertColumn') {
			const target = SQLParser.detectInsertTarget(ctx.textBeforeInStmt);
			if (target) {
				const schema =
					target.schema ||
					this.registry.getTableSchema(target.table) ||
					'public';
				return this.columnItems(
					this.registry.getRelationColumns(schema, target.table),
					prefix
				);
			}
		}

		const items: vscode.CompletionItem[] = [];
		const seen = new Set<string>();

		for (const col of ctx.scopeColumns) {
			if (!col.name.toLowerCase().startsWith(prefix) || seen.has(col.name)) {
				continue;
			}
			seen.add(col.name);
			const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
			item.detail = col.type
				? `${col.type}${col.source ? ` · ${col.source}` : ''}`
				: col.source
					? `column · ${col.source}`
					: 'column';
			if (col.comment) {
				item.documentation = new vscode.MarkdownString(col.comment);
			}
			item.sortText = '1' + col.name;
			items.push(item);
		}

		return items;
	}

	private getRelationCompletions(ctx: SqlCompletionContext): vscode.CompletionItem[] {
		return this.registry.findRelationsByPrefix(ctx.prefix).map((r) => this.relationItem(r));
	}

	private getCteCompletions(ctx: SqlCompletionContext): vscode.CompletionItem[] {
		return ctx.cteNames
			.filter((n) => n.startsWith(ctx.prefix))
			.map((n) => {
				const item = new vscode.CompletionItem(n, vscode.CompletionItemKind.Reference);
				item.detail = 'CTE';
				item.sortText = '2' + n;
				return item;
			});
	}

	private relationItem(r: RelationInfo): vscode.CompletionItem {
		const kind =
			r.kind === 'view'
				? vscode.CompletionItemKind.Interface
				: vscode.CompletionItemKind.Class;
		const item = new vscode.CompletionItem(r.name, kind);
		item.detail = `${r.kind} · ${r.schema}`;
		item.documentation = new vscode.MarkdownString(
			`**${r.schema}.${r.name}** (${r.kind})\n\nColumns: ${r.columns.map((c) => `\`${c.name}\``).join(', ')}`
		);
		item.sortText = '3' + r.name;
		item.filterText = `${r.schema}.${r.name} ${r.name}`;
		return item;
	}

	private getSchemaCompletions(ctx: SqlCompletionContext): vscode.CompletionItem[] {
		return this.registry
			.getSchemas()
			.filter((s) => s.toLowerCase().startsWith(ctx.prefix))
			.map((s) => {
				const item = new vscode.CompletionItem(s, vscode.CompletionItemKind.Module);
				item.detail = 'schema';
				item.sortText = '4' + s;
				return item;
			});
	}

	private getRoutineCompletions(ctx: SqlCompletionContext): vscode.CompletionItem[] {
		const seen = new Set<string>();
		const items: vscode.CompletionItem[] = [];

		for (const routine of this.registry.getAllRoutines()) {
			if (!routine.name.toLowerCase().startsWith(ctx.prefix)) {
				continue;
			}
			const key = `${routine.schema}.${routine.name}:${routine.oid}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);

			const item = new vscode.CompletionItem(
				routine.name,
				routine.kind === 'procedure'
					? vscode.CompletionItemKind.Method
					: vscode.CompletionItemKind.Function
			);
			const args = routine.identityArgs || '';
			item.detail = `${routine.kind} · ${routine.schema}(${args})`;
			item.insertText = new vscode.SnippetString(
				args ? `${routine.name}($1)` : `${routine.name}()`
			);
			item.sortText = '5' + routine.name;
			item.filterText = `${routine.schema}.${routine.name} ${routine.name}`;
			items.push(item);
		}

		return items;
	}

	private getBuiltinCompletions(ctx: SqlCompletionContext): vscode.CompletionItem[] {
		return builtinFunctionsByPrefix(ctx.prefix).map((fn) => {
			const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
			item.detail = formatBuiltinSignature(fn);
			if (fn.documentation) {
				item.documentation = new vscode.MarkdownString(fn.documentation);
			}
			item.insertText = new vscode.SnippetString(
				fn.params.length ? `${fn.name}($1)` : `${fn.name}()`
			);
			item.sortText = '6' + fn.name;
			return item;
		});
	}

	private getKeywordCompletions(ctx: SqlCompletionContext): vscode.CompletionItem[] {
		const keywords = [
			'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'FROM', 'WHERE',
			'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN', 'CROSS JOIN',
			'ON', 'USING', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
			'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE',
			'IS NULL', 'IS NOT NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
			'UNION', 'UNION ALL', 'WITH', 'RETURNING', 'SET', 'VALUES', 'DEFAULT',
			'DECLARE', 'BEGIN', 'IF', 'THEN', 'ELSIF', 'ELSE', 'END IF', 'LOOP', 'FOR', 'WHILE',
			'RETURN', 'RAISE', 'PERFORM', 'EXECUTE',
		];

		return keywords
			.filter((k) => k.toLowerCase().startsWith(ctx.prefix.toLowerCase()))
			.map((k) => {
				const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
				item.sortText = '9' + k;
				return item;
			});
	}

	private columnItems(cols: ColumnInfo[], prefix: string, source?: string): vscode.CompletionItem[] {
		return cols
			.filter((c) => c.name.toLowerCase().startsWith(prefix))
			.map((c) => {
				const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
				item.detail =
					c.type + (c.nullable ? '' : ' NOT NULL') + (source ? ` · ${source}` : '');
				const docParts = [
					`**${c.name}**`,
					'',
					`Type: \`${c.type}\``,
					`Nullable: ${c.nullable ? 'yes' : 'no'}`,
				];
				if (c.comment) {
					docParts.push('', c.comment);
				}
				item.documentation = new vscode.MarkdownString(docParts.join('\n'));
				item.sortText = '1' + c.name;
				return item;
			});
	}
}

export function dtoToCompletionItem(
	dto: SqlCompletionItemDto,
	document: vscode.TextDocument,
	fallbackOffset: number
): vscode.CompletionItem {
	const item = new vscode.CompletionItem(dto.label, dto.kind);
	item.detail = dto.detail;
	if (dto.documentation) {
		item.documentation = new vscode.MarkdownString(dto.documentation);
	}
	if (dto.insertText) {
		item.insertText = dto.insertText;
	}
	item.sortText = dto.sortText;
	item.filterText = dto.filterText;
	const start = document.positionAt(dto.rangeOffset);
	const end = document.positionAt(dto.rangeOffset + dto.rangeLength);
	item.range = new vscode.Range(start, end);
	if (dto.label.startsWith('Подключитесь')) {
		item.command = {
			command: 'pgsql-tools.selectConnection',
			title: 'Select Connection',
		};
	}
	return item;
}
