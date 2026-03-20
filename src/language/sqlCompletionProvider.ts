import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';

export class SQLCompletionProvider implements vscode.CompletionItemProvider {
	private schemas: string[] = [];
	private tables: Map<string, string[]> = new Map();
	private columns: Map<string, string[]> = new Map();

	constructor(
		private queryExecutor: QueryExecutor,
		private connectionManager: ConnectionManager
	) {
		this.loadSchemaInfo();
	}

	private async loadSchemaInfo(): Promise<void> {
		try {
			const activeConnection = this.connectionManager.getActiveConnectionName();
			if (!activeConnection) {
				return;
			}

			// Load schemas
			this.schemas = await this.queryExecutor.getSchemata();

			// Load tables for each schema
			for (const schema of this.schemas) {
				const tables = await this.queryExecutor.getTables(schema);
				this.tables.set(schema, tables);

				// Load columns for each table
				for (const table of tables) {
					const columns = await this.queryExecutor.getColumns(schema, table);
					const columnNames = columns.map(col => col.column_name);
					this.columns.set(`${schema}.${table}`, columnNames);
				}
			}
		} catch (error) {
			console.error('Failed to load schema info:', error);
		}
	}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		context: vscode.CompletionContext
	): Promise<vscode.CompletionItem[]> {
		const lineText = document.lineAt(position.line).text;
		const textBefore = lineText.substring(0, position.character);
		const word = this.getWordAt(textBefore);

		const completionItems: vscode.CompletionItem[] = [];

		// SQL Keywords
		const keywords = [
			'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
			'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS',
			'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
			'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE',
			'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
			'DISTINCT', 'AS', 'WITH', 'UNION', 'INTERSECT', 'EXCEPT',
			'PRIMARY', 'KEY', 'FOREIGN', 'UNIQUE', 'CHECK', 'DEFAULT',
			'NULL', 'TRUE', 'FALSE'
		];

		// Add keyword completions
		for (const keyword of keywords) {
			if (keyword.toLowerCase().startsWith(word.toLowerCase())) {
				const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
				item.insertText = keyword;
				item.documentation = `SQL Keyword: ${keyword}`;
				completionItems.push(item);
			}
		}

		// Add schema completions
		for (const schema of this.schemas) {
			if (schema.toLowerCase().startsWith(word.toLowerCase())) {
				const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Module);
				item.insertText = schema;
				item.documentation = `Schema: ${schema}`;
				completionItems.push(item);
			}
		}

		// Add table completions
		for (const [schema, tables] of this.tables) {
			for (const table of tables) {
				if (table.toLowerCase().startsWith(word.toLowerCase())) {
					const item = new vscode.CompletionItem(table, vscode.CompletionItemKind.Struct);
					item.insertText = table;
					item.documentation = `Table: ${schema}.${table}`;
					completionItems.push(item);
				}
			}
		}

		// Add column completions
		for (const [fullName, columns] of this.columns) {
			for (const column of columns) {
				if (column.toLowerCase().startsWith(word.toLowerCase())) {
					const item = new vscode.CompletionItem(column, vscode.CompletionItemKind.Field);
					item.insertText = column;
					item.documentation = `Column: ${fullName}.${column}`;
					completionItems.push(item);
				}
			}
		}

		// Add functions
		const functions = [
			{ name: 'COUNT', detail: 'COUNT(*)' },
			{ name: 'SUM', detail: 'SUM(column)' },
			{ name: 'AVG', detail: 'AVG(column)' },
			{ name: 'MIN', detail: 'MIN(column)' },
			{ name: 'MAX', detail: 'MAX(column)' },
			{ name: 'COALESCE', detail: 'COALESCE(val1, val2)' },
			{ name: 'CAST', detail: 'CAST(value AS type)' },
			{ name: 'SUBSTRING', detail: 'SUBSTRING(string, start, length)' },
			{ name: 'LENGTH', detail: 'LENGTH(string)' },
			{ name: 'UPPER', detail: 'UPPER(string)' },
			{ name: 'LOWER', detail: 'LOWER(string)' },
			{ name: 'TRIM', detail: 'TRIM(string)' },
			{ name: 'NOW', detail: 'NOW()' },
			{ name: 'DATE', detail: 'DATE(timestamp)' },
		];

		for (const func of functions) {
			if (func.name.toLowerCase().startsWith(word.toLowerCase())) {
				const item = new vscode.CompletionItem(func.name, vscode.CompletionItemKind.Function);
				item.insertText = func.name + '(';
				item.documentation = func.detail;
				completionItems.push(item);
			}
		}

		return completionItems;
	}

	resolveCompletionItem?(item: vscode.CompletionItem): vscode.CompletionItem {
		return item;
	}

	private getWordAt(text: string): string {
		const match = text.match(/[\w_]*$/);
		return match ? match[0] : '';
	}

	async refresh(): Promise<void> {
		this.schemas = [];
		this.tables.clear();
		this.columns.clear();
		await this.loadSchemaInfo();
	}
}