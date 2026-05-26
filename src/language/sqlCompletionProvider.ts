import * as vscode from 'vscode';
import { SQLParser } from './sqlParser';
import {
	SqlSchemaRegistry,
	type ColumnInfo,
} from './sqlSchemaRegistry';

export class SQLCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private registry: SqlSchemaRegistry) {}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		_context: vscode.CompletionContext
	): Promise<vscode.CompletionItem[]> {
		this.registry.ensureFresh().catch(() => {});

		const fullText = document.getText();
		const offset = document.offsetAt(position);
		const textBeforeCursor = fullText.slice(0, offset);

		const { text: stmtText, start: stmtStart } = SQLParser.findQueryScopeAt(fullText, offset, true);
		const offsetInStmt = offset - stmtStart;
		const textBeforeInStmt = stmtText.slice(0, offsetInStmt);

		const { qualifier, prefix, triggerKind } = SQLParser.getPrefixContext(textBeforeCursor);

		const items: vscode.CompletionItem[] = [];

		if (triggerKind === 'dot' && qualifier) {
			items.push(
				...(await this.getQualifiedCompletions(qualifier, prefix, stmtText, textBeforeInStmt))
			);
		} else {
			const clause = SQLParser.detectClause(textBeforeInStmt.toUpperCase());
			items.push(...this.getKeywordCompletions(prefix, clause));
			items.push(...this.getFunctionCompletions(prefix, clause));
			items.push(...this.getTableCompletions(prefix));
			items.push(...this.getSchemaCompletions(prefix));

			if (['SELECT', 'WHERE', 'ON', 'HAVING', 'SET'].includes(clause)) {
				items.push(...(await this.getContextColumnCompletions(prefix, stmtText, textBeforeInStmt)));
			}
		}

		return items;
	}

	private async getQualifiedCompletions(
		qualifier: string,
		prefix: string,
		stmtText: string,
		_textBefore: string
	): Promise<vscode.CompletionItem[]> {
		const ctes = SQLParser.parseCTEs(stmtText);
		const tableIndex = this.registry.getTableIndex();
		const aliases = SQLParser.parseAliases(stmtText, new Set(ctes.keys()), tableIndex);

		const source = aliases[qualifier];

		if (!source) {
			const tables = this.registry
				.getAllTables()
				.filter((t) => t.schema.toLowerCase() === qualifier);
			if (tables.length > 0) {
				return tables
					.filter((t) => t.table.toLowerCase().startsWith(prefix))
					.map((t) => {
						const item = new vscode.CompletionItem(t.table, vscode.CompletionItemKind.Class);
						item.detail = `table in ${t.schema}`;
						item.sortText = '0' + t.table;
						return item;
					});
			}

			const schema = this.registry.getTableSchema(qualifier);
			if (schema) {
				return this.columnItems(this.registry.getColumns(schema, qualifier), prefix);
			}

			return [];
		}

		if (source.kind === 'table' && source.table) {
			const schema = source.schema || this.registry.getTableSchema(source.table) || 'public';
			return this.columnItems(this.registry.getColumns(schema, source.table), prefix);
		}

		if (source.kind === 'cte' && source.table) {
			const cteBody = ctes.get(source.table);
			if (cteBody) {
				const cols = this.extractSelectColumns(cteBody, ctes, tableIndex);
				return cols
					.filter((c) => c.toLowerCase().startsWith(prefix))
					.map((c) => {
						const item = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
						item.detail = `column (from CTE ${source.table})`;
						item.sortText = '1' + c;
						return item;
					});
			}
		}

		if (source.kind === 'subquery' && source.columns) {
			return source.columns
				.filter((c) => c.toLowerCase().startsWith(prefix))
				.map((c) => {
					const item = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
					item.detail = 'column (from subquery)';
					item.sortText = '1' + c;
					return item;
				});
		}

		return [];
	}

	private async getContextColumnCompletions(
		prefix: string,
		stmtText: string,
		_textBefore: string
	): Promise<vscode.CompletionItem[]> {
		const ctes = SQLParser.parseCTEs(stmtText);
		const tableIndex = this.registry.getTableIndex();
		const aliases = SQLParser.parseAliases(stmtText, new Set(ctes.keys()), tableIndex);

		const seen = new Set<string>();
		const items: vscode.CompletionItem[] = [];

		for (const source of Object.values(aliases)) {
			let cols: string[] = [];

			if (source.kind === 'table' && source.table) {
				const schema = source.schema || this.registry.getTableSchema(source.table) || 'public';
				cols = this.registry.getColumns(schema, source.table).map((c) => c.name);
			} else if (source.kind === 'cte' && source.table) {
				const cteBody = ctes.get(source.table);
				if (cteBody) {
					cols = this.extractSelectColumns(cteBody, ctes, tableIndex);
				}
			} else if (source.kind === 'subquery' && source.columns) {
				cols = source.columns;
			}

			for (const col of cols) {
				if (!col.toLowerCase().startsWith(prefix)) {
					continue;
				}
				if (seen.has(col)) {
					continue;
				}
				seen.add(col);

				const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
				item.detail = 'column';
				item.sortText = '2' + col;
				items.push(item);
			}
		}

		return items;
	}

	private extractSelectColumns(
		sql: string,
		ctes: Map<string, string>,
		tableIndex: Map<string, string>
	): string[] {
		const clean = SQLParser.stripNoise(sql);
		const selectMatch = clean.match(/\bSELECT\s+([\s\S]+?)\s+FROM\b/i);
		if (!selectMatch) {
			return [];
		}

		const selectList = selectMatch[1];

		if (selectList.trim() === '*') {
			const aliases = SQLParser.parseAliases(sql, new Set(ctes.keys()), tableIndex);
			const cols: string[] = [];
			for (const src of Object.values(aliases)) {
				if (src.kind === 'table' && src.table) {
					const schema = src.schema || this.registry.getTableSchema(src.table) || 'public';
					this.registry.getColumns(schema, src.table).forEach((c) => cols.push(c.name));
				}
			}
			return [...new Set(cols)];
		}

		return this.splitTopLevel(selectList)
			.map((expr) => {
				expr = expr.trim();
				const asMatch = expr.match(/\bAS\s+(\w+)\s*$/i);
				if (asMatch) {
					return asMatch[1];
				}
				const colMatch = expr.match(/(?:\w+\.)?(\w+)\s*$/);
				return colMatch ? colMatch[1] : null;
			})
			.filter((c): c is string => c !== null && c !== '*');
	}

	private splitTopLevel(sql: string): string[] {
		const parts: string[] = [];
		let depth = 0;
		let start = 0;
		for (let i = 0; i < sql.length; i++) {
			if (sql[i] === '(') {
				depth++;
			} else if (sql[i] === ')') {
				depth--;
			} else if (sql[i] === ',' && depth === 0) {
				parts.push(sql.slice(start, i));
				start = i + 1;
			}
		}
		parts.push(sql.slice(start));
		return parts;
	}

	private columnItems(cols: ColumnInfo[], prefix: string): vscode.CompletionItem[] {
		return cols
			.filter((c) => c.name.toLowerCase().startsWith(prefix))
			.map((c) => {
				const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
				item.detail = c.type + (c.nullable ? '' : ' NOT NULL');
				const docParts = [`**${c.name}**`, '', `Type: \`${c.type}\``, `Nullable: ${c.nullable ? 'yes' : 'no'}`];
				if (c.comment) {
					docParts.push('', c.comment);
				}
				item.documentation = new vscode.MarkdownString(docParts.join('\n'));
				item.sortText = '1' + c.name;
				return item;
			});
	}

	private getTableCompletions(prefix: string): vscode.CompletionItem[] {
		return this.registry
			.getAllTables()
			.filter((t) => t.table.toLowerCase().startsWith(prefix))
			.map((t) => {
				const item = new vscode.CompletionItem(t.table, vscode.CompletionItemKind.Class);
				item.detail = `table · ${t.schema}`;
				item.documentation = new vscode.MarkdownString(
					`**${t.schema}.${t.table}**\n\nColumns: ${t.columns.map((c) => `\`${c.name}\``).join(', ')}`
				);
				item.sortText = '3' + t.table;
				return item;
			});
	}

	private getSchemaCompletions(prefix: string): vscode.CompletionItem[] {
		const schemas = [...new Set(this.registry.getAllTables().map((t) => t.schema))];
		return schemas
			.filter((s) => s.toLowerCase().startsWith(prefix))
			.map((s) => {
				const item = new vscode.CompletionItem(s, vscode.CompletionItemKind.Module);
				item.detail = 'schema';
				item.sortText = '4' + s;
				return item;
			});
	}

	private getKeywordCompletions(prefix: string, _clause: string): vscode.CompletionItem[] {
		const keywords = [
			'SELECT',
			'INSERT INTO',
			'UPDATE',
			'DELETE FROM',
			'FROM',
			'WHERE',
			'JOIN',
			'INNER JOIN',
			'LEFT JOIN',
			'RIGHT JOIN',
			'FULL OUTER JOIN',
			'CROSS JOIN',
			'ON',
			'USING',
			'GROUP BY',
			'ORDER BY',
			'HAVING',
			'LIMIT',
			'OFFSET',
			'DISTINCT',
			'AS',
			'AND',
			'OR',
			'NOT',
			'IN',
			'NOT IN',
			'EXISTS',
			'NOT EXISTS',
			'BETWEEN',
			'LIKE',
			'ILIKE',
			'IS NULL',
			'IS NOT NULL',
			'CASE',
			'WHEN',
			'THEN',
			'ELSE',
			'END',
			'UNION',
			'UNION ALL',
			'INTERSECT',
			'EXCEPT',
			'CREATE TABLE',
			'ALTER TABLE',
			'DROP TABLE',
			'CREATE INDEX',
			'DROP INDEX',
			'CREATE VIEW',
			'DROP VIEW',
			'WITH',
			'RETURNING',
			'SET',
			'VALUES',
			'DEFAULT',
			'BEGIN',
			'COMMIT',
			'ROLLBACK',
		];

		return keywords
			.filter((k) => k.toLowerCase().startsWith(prefix.toLowerCase()))
			.map((k) => {
				const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
				item.sortText = '5' + k;
				return item;
			});
	}

	private getFunctionCompletions(prefix: string, _clause: string): vscode.CompletionItem[] {
		const functions: Array<{ name: string; sig: string; doc: string }> = [
			{ name: 'COUNT', sig: 'COUNT(expression)', doc: 'Count rows' },
			{ name: 'SUM', sig: 'SUM(expression)', doc: 'Sum values' },
			{ name: 'AVG', sig: 'AVG(expression)', doc: 'Average value' },
			{ name: 'MIN', sig: 'MIN(expression)', doc: 'Minimum value' },
			{ name: 'MAX', sig: 'MAX(expression)', doc: 'Maximum value' },
			{ name: 'COALESCE', sig: 'COALESCE(val1, val2, ...)', doc: 'First non-NULL value' },
			{ name: 'NOW', sig: 'NOW()', doc: 'Current timestamp' },
			{ name: 'LOWER', sig: 'LOWER(string)', doc: 'Lowercase' },
			{ name: 'UPPER', sig: 'UPPER(string)', doc: 'Uppercase' },
		];

		return functions
			.filter((f) => f.name.toLowerCase().startsWith(prefix.toLowerCase()))
			.map((f) => {
				const item = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Function);
				item.detail = f.sig;
				item.documentation = new vscode.MarkdownString(`**${f.sig}**\n\n${f.doc}`);
				item.insertText = new vscode.SnippetString(f.name + '($0)');
				item.sortText = '6' + f.name;
				return item;
			});
	}

	async refresh(): Promise<void> {
		this.registry.clear();
		await this.registry.refresh();
	}
}
