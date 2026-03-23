import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ResultsViewProvider } from '../views/resultsPanel';

/**
 * Split SQL text into individual statements, respecting:
 *  - single-quoted strings (including escaped '' inside)
 *  - dollar-quoted strings ($$ ... $$ and $tag$ ... $tag$)
 *  - block comments (/* ... *\/)
 *  - line comments (-- ...)
 */
function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = '';
	let i = 0;

	while (i < sql.length) {
		// Block comment
		if (sql[i] === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			if (end === -1) { current += sql.slice(i); i = sql.length; }
			else { current += sql.slice(i, end + 2); i = end + 2; }
			continue;
		}
		// Line comment
		if (sql[i] === '-' && sql[i + 1] === '-') {
			const end = sql.indexOf('\n', i);
			if (end === -1) { current += sql.slice(i); i = sql.length; }
			else { current += sql.slice(i, end + 1); i = end + 1; }
			continue;
		}
		// Single-quoted string
		if (sql[i] === "'") {
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
				if (sql[j] === "'") { j++; break; }
				j++;
			}
			current += sql.slice(i, j);
			i = j;
			continue;
		}
		// Dollar-quoted string
		if (sql[i] === '$') {
			const tagMatch = sql.slice(i).match(/^\$([^$]*)\$/);
			if (tagMatch) {
				const tag = tagMatch[0];
				const endIdx = sql.indexOf(tag, i + tag.length);
				if (endIdx === -1) { current += sql.slice(i); i = sql.length; }
				else { current += sql.slice(i, endIdx + tag.length); i = endIdx + tag.length; }
				continue;
			}
		}
		// Statement separator
		if (sql[i] === ';') {
			current += ';';
			const trimmed = current.trim();
			if (trimmed && trimmed !== ';') {
				statements.push(trimmed);
			}
			current = '';
			i++;
			continue;
		}
		current += sql[i++];
	}

	const last = current.trim();
	if (last) statements.push(last);

	return statements;
}

export class ExecuteSqlFileCommand {
	static register(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider: ResultsViewProvider
	) {
		return vscode.commands.registerCommand('pgsql-tools.executeSqlFile', async () => {
			const editor = vscode.window.activeTextEditor;

			if (!editor) {
				vscode.window.showErrorMessage('No SQL file is open');
				return;
			}

			if (editor.document.languageId !== 'sql') {
				vscode.window.showErrorMessage('Current file is not a SQL file');
				return;
			}

			const activeConnection = connectionManager.getActiveConnectionName();
			if (!activeConnection) {
				vscode.window.showErrorMessage(
					'No active database connection. Please select a connection first.'
				);
				return;
			}

			// Get selected text or entire document
			let rawSql = '';
			const hasSelection = !editor.selection.isEmpty;
			if (hasSelection) {
				rawSql = editor.document.getText(editor.selection);
			} else {
				rawSql = editor.document.getText();
			}

			rawSql = rawSql.trim();
			if (!rawSql) {
				vscode.window.showErrorMessage('Query is empty');
				return;
			}

			const statements = splitStatements(rawSql);
			if (statements.length === 0) {
				vscode.window.showErrorMessage('No valid SQL statements found');
				return;
			}

			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: statements.length > 1
							? `Executing ${statements.length} statements…`
							: 'Executing query…',
						cancellable: false,
					},
					async () => {
						// Execute all statements; show results for the last SELECT-like one
						let lastResult: any = null;
						let lastSchema = 'public';
						let lastTable = '';

						for (let idx = 0; idx < statements.length; idx++) {
							const stmt = statements[idx];
							const result = await queryExecutor.executeQuery(stmt);

							// Track the last result that returned rows
							if (result.rows && result.rows.length > 0) {
								lastResult = result;
								const tableMatch = stmt.match(/FROM\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i);
								if (tableMatch) {
									lastSchema = tableMatch[1] || 'public';
									lastTable = tableMatch[2];
								}
							} else if (result.rowCount !== undefined && idx === statements.length - 1) {
								// Last statement returned no rows (INSERT/UPDATE/DELETE etc.)
								lastResult = result;
							}
						}

						if (lastResult) {
							await resultsViewProvider.show(
								{
									rows: lastResult.rows ?? [],
									columns: lastResult.fields?.map((f: any) => f.name) ?? [],
									rowCount: lastResult.rowCount ?? 0,
									originalRows: JSON.parse(JSON.stringify(lastResult.rows ?? [])),
									schema: lastSchema,
									tableName: lastTable,
								},
								queryExecutor,
								connectionManager
							);
						}

						const msg =
							statements.length > 1
								? `✓ ${statements.length} statements executed. Last result: ${lastResult?.rowCount ?? 0} rows.`
								: `✓ Query executed! ${lastResult?.rowCount ?? 0} rows returned.`;
						vscode.window.showInformationMessage(msg);
					}
				);
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`Query execution failed: ${errorMessage}`);
			}
		});
	}
}