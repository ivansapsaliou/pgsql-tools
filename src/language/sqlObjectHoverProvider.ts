import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import { getObjectRefAtPosition, type SqlObjectRef } from './sqlObjectScanner';

const SQL_KEYWORDS: Record<string, string> = {
	SELECT: 'Retrieves data from a table',
	INSERT: 'Adds new rows to a table',
	UPDATE: 'Modifies existing rows in a table',
	DELETE: 'Removes rows from a table',
	CREATE: 'Creates a new database object',
	ALTER: 'Modifies an existing database object',
	DROP: 'Deletes a database object',
	WHERE: 'Specifies conditions for rows to be returned',
	JOIN: 'Combines rows from two or more tables',
	GROUP: 'Groups rows by one or more columns',
	ORDER: 'Sorts the result set',
	LIMIT: 'Limits the number of rows returned',
};

const MAX_DDL_LINES = 80;
const DDL_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
	text: string;
	ts: number;
}

function truncateDdl(ddl: string): string {
	const lines = ddl.split(/\r?\n/);
	if (lines.length <= MAX_DDL_LINES) {
		return ddl;
	}
	return lines.slice(0, MAX_DDL_LINES).join('\n') + '\n\n…';
}

function isHoverDdlEnabled(): boolean {
	return vscode.workspace.getConfiguration('pgsql-tools').get<boolean>('sqlObjectHoverDdl', true);
}

export class SqlObjectHoverProvider implements vscode.HoverProvider {
	private ddlCache = new Map<string, CacheEntry>();

	constructor(
		private registry: SqlSchemaRegistry,
		private queryExecutor: QueryExecutor
	) {}

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken
	): Promise<vscode.Hover | undefined> {
		if (document.uri.scheme === 'pgsql-tools-git') {
			return undefined;
		}

		const wordRange = document.getWordRangeAtPosition(position);
		if (wordRange) {
			const word = document.getText(wordRange);
			const hint = SQL_KEYWORDS[word.toUpperCase()];
			if (hint) {
				return new vscode.Hover(hint);
			}
		}

		return this.provideObjectHover(document, position);
	}

	private async provideObjectHover(
		document: vscode.TextDocument,
		position: vscode.Position
	): Promise<vscode.Hover | undefined> {
		await this.registry.ensureFresh();
		const ref = getObjectRefAtPosition(document, position, this.registry);
		if (!ref) {
			return undefined;
		}

		if (ref.kind === 'column') {
			return this.columnHover(ref);
		}

		if (!isHoverDdlEnabled()) {
			return new vscode.Hover(
				`**${ref.schema}.${ref.name}** (${ref.kind})`,
				ref.range
			);
		}

		const ddl = await this.fetchDdl(ref);
		if (!ddl) {
			return undefined;
		}

		const md = new vscode.MarkdownString();
		md.isTrusted = false;
		md.supportHtml = false;
		md.appendMarkdown(`**${ref.schema}.${ref.name}** (${ref.kind})\n\n`);
		md.appendCodeblock(truncateDdl(ddl), 'sql');
		return new vscode.Hover(md, ref.range);
	}

	private columnHover(ref: Extract<SqlObjectRef, { kind: 'column' }>): vscode.Hover {
		const col = this.registry.getColumn(ref.schema, ref.table, ref.column);
		const md = new vscode.MarkdownString();
		md.isTrusted = false;
		if (!col) {
			md.appendMarkdown(`**${ref.column}** · \`${ref.schema}.${ref.table}\``);
		} else {
			md.appendMarkdown(`**${col.name}** · \`${col.type}\``);
			if (!col.nullable) {
				md.appendMarkdown(' · NOT NULL');
			}
			md.appendMarkdown(`\n\n\`${ref.schema}.${ref.table}\``);
			if (col.comment) {
				md.appendMarkdown(`\n\n${col.comment}`);
			}
		}
		return new vscode.Hover(md, ref.range);
	}

	private cacheKey(ref: SqlObjectRef): string {
		if (ref.kind === 'column') {
			return `column:${ref.schema}.${ref.table}.${ref.column}`;
		}
		return `${ref.kind}:${ref.schema}.${ref.name}`;
	}

	private async fetchDdl(ref: SqlObjectRef): Promise<string | null> {
		if (ref.kind === 'column') {
			return null;
		}

		const key = this.cacheKey(ref);
		const cached = this.ddlCache.get(key);
		if (cached && Date.now() - cached.ts < DDL_CACHE_TTL_MS) {
			return cached.text;
		}

		try {
			let ddl: string;
			switch (ref.kind) {
				case 'table':
					ddl = await this.queryExecutor.getTableDDL(ref.schema, ref.name);
					break;
				case 'view':
					ddl = await this.queryExecutor.getViewDDL(ref.schema, ref.name);
					break;
				case 'function':
					ddl = await this.queryExecutor.getFunctionDDL(ref.schema, ref.name);
					break;
				case 'procedure':
					ddl = await this.queryExecutor.getProcedureDDL(ref.schema, ref.name);
					break;
				default:
					return null;
			}
			this.ddlCache.set(key, { text: ddl, ts: Date.now() });
			return ddl;
		} catch {
			return null;
		}
	}
}
