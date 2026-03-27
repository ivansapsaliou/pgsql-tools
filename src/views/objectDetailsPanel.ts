import * as vscode from 'vscode';
import { QueryExecutor, QueryResult, IndexInfo, ForeignKeyInfo, ConstraintInfo } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ResultsViewProvider } from './resultsPanel';

function esc(text: string): string {
	const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
	return text.replace(/[&<>"']/g, (m) => map[m]);
}

function qIdent(name: string): string {
	return `"${String(name).replace(/"/g, '""')}"`;
}

interface ColumnDetail {
	col: string;
	col_type: string;
	notnull: boolean;
	col_default: string | null;
	col_comment: string | null;
	is_pk: boolean;
	is_unique: boolean;
	fk_table: string | null;
	fk_col: string | null;
}

const ICONS: Record<string, { light: string; dark: string }> = {
	table: {
		light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="3" rx="0.5" fill="#007acc"/><rect x="1" y="6" width="6" height="3" rx="0.5" fill="#007acc" opacity="0.7"/><rect x="9" y="6" width="6" height="3" rx="0.5" fill="#007acc" opacity="0.7"/><rect x="1" y="11" width="6" height="3" rx="0.5" fill="#007acc" opacity="0.5"/><rect x="9" y="11" width="6" height="3" rx="0.5" fill="#007acc" opacity="0.5"/></svg>`,
		dark:  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="3" rx="0.5" fill="#4ec9b0"/><rect x="1" y="6" width="6" height="3" rx="0.5" fill="#4ec9b0" opacity="0.7"/><rect x="9" y="6" width="6" height="3" rx="0.5" fill="#4ec9b0" opacity="0.7"/><rect x="1" y="11" width="6" height="3" rx="0.5" fill="#4ec9b0" opacity="0.5"/><rect x="9" y="11" width="6" height="3" rx="0.5" fill="#4ec9b0" opacity="0.5"/></svg>`,
	},
	view: {
		light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" fill="#007acc"/><path d="M8 3C4.5 3 1.5 8 1.5 8s3 5 6.5 5 6.5-5 6.5-5S11.5 3 8 3z" fill="none" stroke="#007acc" stroke-width="1.2"/></svg>`,
		dark:  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.5" fill="#c586c0"/><path d="M8 3C4.5 3 1.5 8 1.5 8s3 5 6.5 5 6.5-5 6.5-5S11.5 3 8 3z" fill="none" stroke="#c586c0" stroke-width="1.2"/></svg>`,
	},
	function: {
		light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="2" y="13" font-family="monospace" font-size="12" font-weight="bold" fill="#007acc">f</text><text x="8" y="13" font-family="monospace" font-size="10" fill="#007acc">()</text></svg>`,
		dark:  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="2" y="13" font-family="monospace" font-size="12" font-weight="bold" fill="#dcdcaa">f</text><text x="8" y="13" font-family="monospace" font-size="10" fill="#dcdcaa">()</text></svg>`,
	},
	procedure: {
		light: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="1" y="13" font-family="monospace" font-size="10" font-weight="bold" fill="#007acc">proc</text></svg>`,
		dark:  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="1" y="13" font-family="monospace" font-size="10" font-weight="bold" fill="#b5cea8">proc</text></svg>`,
	},
};

function svgToUri(svg: string): vscode.Uri {
	const encoded = Buffer.from(svg).toString('base64');
	return vscode.Uri.parse(`data:image/svg+xml;base64,${encoded}`);
}

export class ObjectDetailsPanel {
	private static panels: Map<string, vscode.WebviewPanel> = new Map();
	private static pendingOpen: Map<string, ReturnType<typeof setTimeout>> = new Map();

	static async show(
		context: vscode.ExtensionContext,
		schema: string,
		objectName: string,
		objectType: string,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider?: ResultsViewProvider
	) {
		const panelKey = `${schema}.${objectName}:${objectType}`;

		const existingPanel = this.panels.get(panelKey);
		if (existingPanel) {
			existingPanel.reveal(undefined, false);
			return;
		}

		const existingTimer = this.pendingOpen.get(panelKey);
		if (existingTimer) { clearTimeout(existingTimer); }

		const timer = setTimeout(async () => {
			this.pendingOpen.delete(panelKey);
			if (this.panels.has(panelKey)) {
				this.panels.get(panelKey)!.reveal(undefined, false);
				return;
			}
			await this._openPanel(context, panelKey, schema, objectName, objectType, queryExecutor, connectionManager, resultsViewProvider);
		}, 150);

		this.pendingOpen.set(panelKey, timer);
	}

	private static async _openPanel(
		context: vscode.ExtensionContext,
		panelKey: string,
		schema: string,
		objectName: string,
		objectType: string,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider?: ResultsViewProvider
	) {
		const title = `${objectName}`;
		const iconSet = ICONS[objectType] ?? ICONS['table'];

		const panel = vscode.window.createWebviewPanel(
			'pgsqlObjectDetails',
			title,
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [],
			}
		);

		panel.iconPath = {
			light: svgToUri(iconSet.light),
			dark:  svgToUri(iconSet.dark),
		};

		this.panels.set(panelKey, panel);
		panel.onDidDispose(() => this.panels.delete(panelKey));

		panel.webview.onDidReceiveMessage(async (message) => {
			switch (message.command) {
				case 'openInResults':
					if (!resultsViewProvider) { break; }
					try {
						const result = await queryExecutor.executeQuery(
							`SELECT * FROM "${schema}"."${objectName}" LIMIT 1000`
						);
						await resultsViewProvider.show(
							{
								rows: result.rows,
								columns: result.fields?.map((f: any) => f.name) || [],
								rowCount: result.rowCount || 0,
								originalRows: JSON.parse(JSON.stringify(result.rows)),
								schema, tableName: objectName,
							},
							queryExecutor, connectionManager
						);
					} catch (err) {
						vscode.window.showErrorMessage(`Failed to open in results: ${err}`);
					}
					break;

				case 'openTable':
					await ObjectDetailsPanel.show(
						context, message.schema, message.table, 'table',
						queryExecutor, connectionManager, resultsViewProvider
					);
					break;

				case 'loadPage':
				case 'loadSortedPage': {
					try {
						const pageSize = message.limit || 1000;
						const offset = (message.page - 1) * pageSize;
						const orderBy = message.orderBy ? ` ORDER BY ${qIdent(message.orderBy)} ${message.orderDir || 'ASC'}` : '';
						const result = await queryExecutor.executeQuery(
							`SELECT ctid::text AS "__pgtools_ctid", * FROM ${qIdent(schema)}.${qIdent(objectName)}${orderBy} LIMIT ${pageSize} OFFSET ${offset}`
						);
						panel.webview.postMessage({
							command: 'pageData',
							rows: result.rows,
							fields: (result.fields?.map((f: any) => f.name) || []).filter((n: string) => n !== '__pgtools_ctid'),
							page: message.page,
							orderBy: message.orderBy || null,
							orderDir: message.orderDir || null,
						});
					} catch (err) {
						vscode.window.showErrorMessage(`Failed to load page: ${err}`);
					}
					break;
				}

				// ── Apply row edits (from Data tab) ─────────────────────────
				case 'applyRowChanges': {
					try {
						const changes: Array<{ pkCol: string; pkVal: any; rowCtid?: string; col: string; val: any }> = message.changes;
						if (!changes || changes.length === 0) {
							vscode.window.showInformationMessage('No changes to apply');
							break;
						}
						for (const ch of changes) {
							const escapedVal = ch.val === null ? 'NULL' : `'${String(ch.val).replace(/'/g, "''")}'`;
							const colSql = qIdent(ch.col);
							const tableSql = `${qIdent(schema)}.${qIdent(objectName)}`;
							if (ch.rowCtid) {
								const escapedTid = `'${String(ch.rowCtid).replace(/'/g, "''")}'::tid`;
								await queryExecutor.executeQuery(
									`UPDATE ${tableSql} SET ${colSql} = ${escapedVal} WHERE ctid = ${escapedTid}`
								);
								continue;
							}
							if (!ch.pkCol) {
								throw new Error('Cannot apply changes: primary key is missing and row identifier is not provided');
							}
							const pkColSql = qIdent(ch.pkCol);
							const escapedPk  = ch.pkVal === null ? 'NULL' : `'${String(ch.pkVal).replace(/'/g, "''")}'`;
							await queryExecutor.executeQuery(
								ch.pkVal === null
									? `UPDATE ${tableSql} SET ${colSql} = ${escapedVal} WHERE ${pkColSql} IS NULL`
									: `UPDATE ${tableSql} SET ${colSql} = ${escapedVal} WHERE ${pkColSql} = ${escapedPk}`
							
								);
						}
						panel.webview.postMessage({ command: 'rowChangesApplied' });
						vscode.window.showInformationMessage(`✓ ${changes.length} change(s) saved`);
					} catch (err) {
						vscode.window.showErrorMessage(`Failed to save changes: ${err}`);
						panel.webview.postMessage({ command: 'rowChangesFailed', error: String(err) });
						await this._showDataTabErrorInResults(
							resultsViewProvider,
							'Apply row changes failed',
							err,
							{ schema, table: objectName, operation: 'applyRowChanges', changesCount: message?.changes?.length ?? 0 }
						);
					}
					break;
				}

				case '__deleteRowsButtonClicked': {
					vscode.window.showInformationMessage(`Data: deleteRows button clicked (${objectType})`);
					break;
				}

				case 'applyTableRowEdits': {
					try {
						if (objectType !== 'table') {
							throw new Error('Row inserts/updates are supported only for tables');
						}

						const updates: Array<{ pkCol: string; pkVal: any; rowCtid?: string | null; col: string; val: any }> =
							Array.isArray(message.updates) ? message.updates : [];

						const inserts: Array<{ values: Record<string, any> }> =
							Array.isArray(message.inserts) ? message.inserts : [];

						// 1) INSERTs (new local rows)
						let insertOpCount = 0;
						for (const ins of inserts) {
							const values: Record<string, any> =
								ins && typeof ins.values === 'object' && ins.values !== null ? ins.values : {};

							const columns = Object.keys(values)
								.filter((c) => c && c !== '__pgtools_ctid' && values[c] !== undefined);

							const tableSql = `${qIdent(schema)}.${qIdent(objectName)}`;
							if (columns.length === 0) {
								await queryExecutor.executeQuery(`INSERT INTO ${tableSql} DEFAULT VALUES`);
							} else {
								const colSql = columns.map((c) => qIdent(c)).join(', ');
								const valSql = columns.map((c) => this._toSqlLiteral(values[c])).join(', ');
								await queryExecutor.executeQuery(`INSERT INTO ${tableSql} (${colSql}) VALUES (${valSql})`);
							}
							insertOpCount++;
						}

						// 2) UPDATEs (cell edits for existing rows)
						let updateOpCount = 0;
						for (const ch of updates) {
							const escapedVal =
								ch.val === null || ch.val === undefined
									? 'NULL'
									: `'${String(ch.val).replace(/'/g, "''")}'`;

							const colSql = qIdent(ch.col);
							const tableSql = `${qIdent(schema)}.${qIdent(objectName)}`;

							if (ch.rowCtid) {
								const escapedTid = `'${String(ch.rowCtid).replace(/'/g, "''")}'::tid`;
								await queryExecutor.executeQuery(
									`UPDATE ${tableSql} SET ${colSql} = ${escapedVal} WHERE ctid = ${escapedTid}`
								);
								updateOpCount++;
								continue;
							}

							if (!ch.pkCol) {
								throw new Error('Cannot apply update: primary key is missing and row identifier is not provided');
							}

							const pkColSql = qIdent(ch.pkCol);
							const escapedPk =
								ch.pkVal === null || ch.pkVal === undefined
									? 'NULL'
									: `'${String(ch.pkVal).replace(/'/g, "''")}'`;

							await queryExecutor.executeQuery(
								ch.pkVal === null || ch.pkVal === undefined
									? `UPDATE ${tableSql} SET ${colSql} = ${escapedVal} WHERE ${pkColSql} IS NULL`
									: `UPDATE ${tableSql} SET ${colSql} = ${escapedVal} WHERE ${pkColSql} = ${escapedPk}`
							);
							updateOpCount++;
						}

						panel.webview.postMessage({ command: 'tableRowEditsApplied', inserted: insertOpCount, updated: updateOpCount });
						vscode.window.showInformationMessage(`✓ Saved table edits (inserted ${insertOpCount} row(s), updated ${updateOpCount} cell(s))`);
					} catch (err) {
						const errText = `Failed to apply table row edits: ${err}`;
						vscode.window.showErrorMessage(errText);
						panel.webview.postMessage({ command: 'tableRowEditsFailed', error: errText });
						await this._showDataTabErrorInResults(
							resultsViewProvider,
							'Apply table row edits failed',
							err,
							{ schema, table: objectName, operation: 'applyTableRowEdits', updatesCount: Array.isArray(message?.updates) ? message.updates.length : 0, insertsCount: Array.isArray(message?.inserts) ? message.inserts.length : 0 }
						);
					}
					break;
				}

				case 'deleteRows': {
					try {
						if (objectType !== 'table') {
							throw new Error('Row deletion is supported only for tables');
						}
						vscode.window.showInformationMessage(`✓ Deleted btn`);
						const rows: Array<{ pkCol: string; pkVal: any; rowCtid?: string | null }> = Array.isArray(message.rows) ? message.rows : [];
						if (rows.length === 0) {
							throw new Error('No rows selected for deletion');
						}
						const tableSql = `${qIdent(schema)}.${qIdent(objectName)}`;
						let deleted = 0;
						for (const row of rows) {
							if (row.rowCtid) {
								const escapedTid = `'${String(row.rowCtid).replace(/'/g, "''")}'::tid`;
								await queryExecutor.executeQuery(`DELETE FROM ${tableSql} WHERE ctid = ${escapedTid}`);
								deleted++;
								continue;
							}
							if (!row.pkCol) {
								throw new Error('Cannot delete rows: primary key is missing and row identifier is not provided');
							}
							const pkColSql = qIdent(row.pkCol);
							const escapedPk = row.pkVal === null ? 'NULL' : `'${String(row.pkVal).replace(/'/g, "''")}'`;
							await queryExecutor.executeQuery(
								row.pkVal === null
									? `DELETE FROM ${tableSql} WHERE ${pkColSql} IS NULL`
									: `DELETE FROM ${tableSql} WHERE ${pkColSql} = ${escapedPk}`
							);
							deleted++;
						}
						panel.webview.postMessage({ command: 'rowsDeleted', deleted });
						vscode.window.showInformationMessage(`✓ ${deleted} row(s) deleted`);
					} catch (err) {
						const errText = `Failed to delete rows: ${err}`;
						vscode.window.showErrorMessage(errText);
						panel.webview.postMessage({ command: 'deleteRowsFailed', error: errText });
						await this._showDataTabErrorInResults(
							resultsViewProvider,
							'Delete rows failed',
							err,
							{ schema, table: objectName, operation: 'deleteRows', requestedRows: message?.rows?.length ?? 0 }
						);
					}
					break;
				}

				case 'createRow': {
					try {
						const values = (message && typeof message.values === 'object' && message.values !== null) ? message.values as Record<string, any> : {};
						const columns = Object.keys(values).filter((c) => c && c !== '__pgtools_ctid');
						const tableSql = `${qIdent(schema)}.${qIdent(objectName)}`;
						if (columns.length === 0) {
							await queryExecutor.executeQuery(`INSERT INTO ${tableSql} DEFAULT VALUES`);
						} else {
							const colSql = columns.map((c) => qIdent(c)).join(', ');
							const valSql = columns.map((c) => this._toSqlLiteral(values[c])).join(', ');
							await queryExecutor.executeQuery(`INSERT INTO ${tableSql} (${colSql}) VALUES (${valSql})`);
						}
						panel.webview.postMessage({ command: 'rowCreated' });
						vscode.window.showInformationMessage('✓ New row created');
					} catch (err) {
						const errText = `Failed to create row: ${err}`;
						vscode.window.showErrorMessage(errText);
						panel.webview.postMessage({ command: 'createRowFailed', error: errText });
						await this._showDataTabErrorInResults(
							resultsViewProvider,
							'Create row failed',
							err,
							{ schema, table: objectName, operation: 'createRow' }
						);
					}
					break;
				}

				case 'executeRoutineDDL': {
					try {
						if (objectType !== 'function' && objectType !== 'procedure') {
							throw new Error(`executeRoutineDDL is not supported for objectType="${objectType}"`);
						}
						const ddl: unknown = message.ddl;
						if (typeof ddl !== 'string') {
							throw new Error('Missing/invalid "ddl" payload');
						}
						const trimmed = ddl.trim();
						if (!trimmed) { throw new Error('DDL is empty'); }
						const finalDdl = trimmed.endsWith(';') ? trimmed : `${trimmed};`;
						await queryExecutor.executeQuery(finalDdl);
						vscode.window.showInformationMessage(
							`${objectType === 'function' ? 'Function' : 'Procedure'} "${schema}.${objectName}" updated`
						);
						this._refresh(context, panelKey, schema, objectName, objectType, queryExecutor, connectionManager, resultsViewProvider);
					} catch (err) {
						vscode.window.showErrorMessage(`Failed to execute DDL: ${err}`);
					}
					break;
				}

				case 'createColumn': {
					try {
						let sql = `ALTER TABLE "${schema}"."${objectName}" ADD COLUMN "${message.columnName}" ${message.columnType}`;
						if (message.notNull) { sql += ' NOT NULL'; }
						if (message.defaultValue) { sql += ` DEFAULT ${message.defaultValue}`; }
						await queryExecutor.executeQuery(sql);
						if (message.comment) {
							await queryExecutor.executeQuery(
								`COMMENT ON COLUMN "${schema}"."${objectName}"."${message.columnName}" IS '${message.comment.replace(/'/g, "''")}'`
							);
						}
						vscode.window.showInformationMessage(`Column "${message.columnName}" created`);
						this._refresh(context, panelKey, schema, objectName, objectType, queryExecutor, connectionManager, resultsViewProvider);
					} catch (err) {
						vscode.window.showErrorMessage(`Failed to create column: ${err}`);
					}
					break;
				}

				// ── FIX: delete column — always use CASCADE, single query ────
				case 'deleteColumnClicked': {
					const rawColName: string = String(message.columnName ?? '');
					const colName = rawColName.trim();
					if (!colName) { break; }
					try {
						if (objectType !== 'table') {
							throw new Error('Column deletion is supported only for tables');
						}
						const e = (s: string) => s.replace(/'/g, "''");
						const lookup = await queryExecutor.executeQuery(`
							SELECT a.attname AS col
							FROM pg_catalog.pg_attribute a
							JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
							JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
							WHERE n.nspname = '${e(schema)}'
							  AND c.relname = '${e(objectName)}'
							  AND a.attnum > 0
							  AND NOT a.attisdropped
							  AND lower(a.attname) = lower('${e(colName)}')
							LIMIT 1
						`);
						const actualColName: string = lookup.rows[0]?.col;
						if (!actualColName) {
							throw new Error(`Column "${colName}" not found in ${schema}.${objectName}`);
						}
						await queryExecutor.executeQuery(
							`ALTER TABLE ${qIdent(schema)}.${qIdent(objectName)} DROP COLUMN ${qIdent(actualColName)} CASCADE`
						);

						const verify = await queryExecutor.executeQuery(`
							SELECT 1
							FROM information_schema.columns
							WHERE table_schema = '${e(schema)}'
							  AND table_name = '${e(objectName)}'
							  AND column_name = '${e(actualColName)}'
							LIMIT 1
						`);
						if ((verify.rowCount || 0) > 0) {
							throw new Error(`Column "${actualColName}" still exists after DROP COLUMN`);
						}
						vscode.window.showInformationMessage(`Column "${actualColName}" deleted`);
						panel.webview.postMessage({ command: 'deleteColumnApplied', columnName: actualColName });
						this._refresh(context, panelKey, schema, objectName, objectType, queryExecutor, connectionManager, resultsViewProvider);
					} catch (err) {
						const errMsg = `Failed to delete column "${colName}": ${err}`;
						vscode.window.showErrorMessage(errMsg);
						panel.webview.postMessage({ command: 'deleteColumnFailed', error: errMsg, columnName: colName });
					}
					break;
				}

				case 'editColumn': {
					try {
						const originalName: string = message.originalColumnName || message.columnName;
						const newName: string = message.columnName;
						if (!originalName || !newName) { throw new Error('Missing column name(s)'); }
						let colName = originalName;

						if (newName !== originalName) {
							await queryExecutor.executeQuery(
								`ALTER TABLE "${schema}"."${objectName}" RENAME COLUMN "${originalName}" TO "${newName}"`
							);
							colName = newName;
						}
						if (message.columnType) {
							await queryExecutor.executeQuery(
								`ALTER TABLE "${schema}"."${objectName}" ALTER COLUMN "${colName}" TYPE ${message.columnType}`
							);
						}
						if (message.notNull) {
							await queryExecutor.executeQuery(
								`ALTER TABLE "${schema}"."${objectName}" ALTER COLUMN "${colName}" SET NOT NULL`
							);
						} else {
							await queryExecutor.executeQuery(
								`ALTER TABLE "${schema}"."${objectName}" ALTER COLUMN "${colName}" DROP NOT NULL`
							);
						}
						if (message.defaultValue) {
							await queryExecutor.executeQuery(
								`ALTER TABLE "${schema}"."${objectName}" ALTER COLUMN "${colName}" SET DEFAULT ${message.defaultValue}`
							);
						} else {
							await queryExecutor.executeQuery(
								`ALTER TABLE "${schema}"."${objectName}" ALTER COLUMN "${colName}" DROP DEFAULT`
							);
						}
						if (message.comment !== null && message.comment !== undefined) {
							await queryExecutor.executeQuery(
								`COMMENT ON COLUMN "${schema}"."${objectName}"."${colName}" IS '${String(message.comment).replace(/'/g, "''")}'`
							);
						} else {
							await queryExecutor.executeQuery(
								`COMMENT ON COLUMN "${schema}"."${objectName}"."${colName}" IS NULL`
							);
						}
						vscode.window.showInformationMessage(`Column "${colName}" updated`);
						this._refresh(context, panelKey, schema, objectName, objectType, queryExecutor, connectionManager, resultsViewProvider);
					} catch (err) {
						vscode.window.showErrorMessage(`Failed to update column: ${err}`);
					}
					break;
				}

				case 'promptRenameColumn': {
					const newName = await vscode.window.showInputBox({
						prompt: `Rename column "${message.columnName}"`,
						value: message.columnName,
						validateInput: (v) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v) ? null : 'Invalid identifier',
					});
					if (newName && newName !== message.columnName) {
						try {
							await queryExecutor.executeQuery(
								`ALTER TABLE "${schema}"."${objectName}" RENAME COLUMN "${message.columnName}" TO "${newName}"`
							);
							vscode.window.showInformationMessage(`Column "${message.columnName}" renamed to "${newName}"`);
							this._refresh(context, panelKey, schema, objectName, objectType, queryExecutor, connectionManager, resultsViewProvider);
						} catch (err) {
							vscode.window.showErrorMessage(`Failed to rename: ${err}`);
						}
					}
					break;
				}
			}
		});

		panel.webview.html = this._loadingHtml(title, objectType);

		try {
			await this._loadAndRender(panel, panelKey, schema, objectName, objectType, queryExecutor);
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to load object details: ${err}`);
			panel.dispose();
		}
	}

	private static _refresh(
		context: vscode.ExtensionContext,
		panelKey: string,
		schema: string,
		objectName: string,
		objectType: string,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider?: ResultsViewProvider
	) {
		const p = this.panels.get(panelKey);
		if (p) { p.dispose(); }
		setTimeout(() => {
			this._openPanel(context, panelKey, schema, objectName, objectType, queryExecutor, connectionManager, resultsViewProvider);
		}, 50);
	}

	private static async _loadAndRender(
		panel: vscode.WebviewPanel,
		panelKey: string,
		schema: string,
		objectName: string,
		objectType: string,
		queryExecutor: QueryExecutor
	) {
		if (objectType === 'table') {
			const [ddl, indexes, foreignKeys, constraints, columnDetails] = await Promise.all([
				queryExecutor.getTableDDL(schema, objectName),
				queryExecutor.getIndexes(schema, objectName),
				queryExecutor.getForeignKeys(schema, objectName),
				queryExecutor.getConstraints(schema, objectName),
				this._fetchColumnDetails(queryExecutor, schema, objectName),
			]);
			if (!this.panels.has(panelKey)) { return; }
			panel.webview.html = this._tableHtml(schema, objectName, ddl, indexes, foreignKeys, constraints, columnDetails);

		} else if (objectType === 'view') {
			const [ddl, columnDetails] = await Promise.all([
				queryExecutor.getViewDDL(schema, objectName),
				this._fetchColumnDetails(queryExecutor, schema, objectName),
			]);
			if (!this.panels.has(panelKey)) { return; }
			panel.webview.html = this._tableHtml(schema, objectName, ddl, [], [], [], columnDetails);

		} else if (objectType === 'function') {
			const ddl = await queryExecutor.getFunctionDDL(schema, objectName);
			if (!this.panels.has(panelKey)) { return; }
			panel.webview.html = this._codeHtml(schema, objectName, ddl, 'Function');

		} else if (objectType === 'procedure') {
			const ddl = await queryExecutor.getProcedureDDL(schema, objectName);
			if (!this.panels.has(panelKey)) { return; }
			panel.webview.html = this._codeHtml(schema, objectName, ddl, 'Procedure');
		}
	}

	private static async _fetchColumnDetails(
		queryExecutor: QueryExecutor,
		schema: string,
		tableName: string
	): Promise<ColumnDetail[]> {
		const e = (s: string) => s.replace(/'/g, "''");
		const res = await queryExecutor.executeQuery(`
			SELECT
				a.attname                                                       AS col,
				pg_catalog.format_type(a.atttypid, a.atttypmod)                AS col_type,
				a.attnotnull                                                    AS notnull,
				pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)                   AS col_default,
				col_description(c.oid, a.attnum)                               AS col_comment,
				EXISTS (
					SELECT 1 FROM pg_constraint pk
					WHERE pk.conrelid = c.oid AND pk.contype = 'p' AND a.attnum = ANY(pk.conkey)
				) AS is_pk,
				EXISTS (
					SELECT 1 FROM pg_constraint uq
					WHERE uq.conrelid = c.oid AND uq.contype = 'u' AND a.attnum = ANY(uq.conkey)
				) AS is_unique,
				(SELECT cc.relname FROM pg_constraint fk JOIN pg_class cc ON cc.oid = fk.confrelid
				 WHERE fk.conrelid = c.oid AND fk.contype = 'f' AND a.attnum = ANY(fk.conkey) LIMIT 1) AS fk_table,
				(SELECT ta.attname FROM pg_constraint fk
				 JOIN pg_attribute ta ON ta.attrelid = fk.confrelid AND ta.attnum = fk.confkey[array_position(fk.conkey, a.attnum)]
				 WHERE fk.conrelid = c.oid AND fk.contype = 'f' AND a.attnum = ANY(fk.conkey) LIMIT 1) AS fk_col
			FROM   pg_catalog.pg_attribute  a
			JOIN   pg_catalog.pg_class      c  ON c.oid = a.attrelid
			JOIN   pg_catalog.pg_namespace  n  ON n.oid = c.relnamespace
			LEFT   JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
			WHERE  n.nspname = '${e(schema)}' AND c.relname = '${e(tableName)}'
			  AND  a.attnum > 0 AND NOT a.attisdropped
			ORDER  BY a.attnum
		`);
		return res.rows as ColumnDetail[];
	}

	private static _formatType(colType: string): { display: string; class: string } {
		let type = colType.toUpperCase()
			.replace(/CHARACTER VARYING/g, 'VARCHAR')
			.replace(/TIMESTAMP WITHOUT TIME ZONE/g, 'TIMESTAMP')
			.replace(/TIMESTAMP WITH TIME ZONE/g, 'TIMESTAMPTZ')
			.replace(/TIME WITHOUT TIME ZONE/g, 'TIME')
			.replace(/TIME WITH TIME ZONE/g, 'TIMETZ')
			.replace(/INTEGER/g, 'INT')
			.replace(/BOOLEAN/g, 'BOOL');

		let cssClass = 'type-other';
		if (/^(INT|SMALLINT|BIGINT|DECIMAL|NUMERIC|REAL|DOUBLE|FLOAT|SERIAL|BIGSERIAL|MONEY)/.test(type)) { cssClass = 'type-number'; }
		else if (/^(VARCHAR|CHAR|TEXT|BPCHAR|NCHAR)/.test(type)) { cssClass = 'type-string'; }
		else if (/^(DATE|TIME|TIMESTAMP)/.test(type)) { cssClass = 'type-datetime'; }
		else if (/^UUID/.test(type)) { cssClass = 'type-uuid'; }
		else if (/^JSON/.test(type)) { cssClass = 'type-json'; }
		else if (/^(BYTEA|BLOB|BINARY)/.test(type)) { cssClass = 'type-binary'; }
		else if (/^BOOL/.test(type)) { cssClass = 'type-boolean'; }
		return { display: type, class: cssClass };
	}

	private static _toSqlLiteral(value: any): string {
		if (value === null || value === undefined) { return 'NULL'; }
		if (typeof value === 'number' && Number.isFinite(value)) { return String(value); }
		if (typeof value === 'boolean') { return value ? 'TRUE' : 'FALSE'; }
		return `'${String(value).replace(/'/g, "''")}'`;
	}

	private static async _showDataTabErrorInResults(
		resultsViewProvider: ResultsViewProvider | undefined,
		title: string,
		error: unknown,
		meta?: Record<string, any>
	) {
		if (!resultsViewProvider) { return; }
		try {
			const payload = {
				error: String(error),
				timestamp: new Date().toISOString(),
				...(meta || {}),
			};
			await resultsViewProvider.showRichContent({
				type: 'json',
				title: `Object Details: ${title}`,
				content: JSON.stringify(payload, null, 2),
			});
		} catch {
			// Ignore secondary failures when reporting errors to Query Results
		}
	}

	private static _loadingHtml(title: string, objectType: string): string {
		return `<!DOCTYPE html><html><head><meta charset="UTF-8">
		<style>
			body { display:flex;align-items:center;justify-content:center;height:100vh;
				font-family:var(--vscode-font-family);color:var(--vscode-foreground);
				background:var(--vscode-editor-background); }
			.spinner { width:20px;height:20px;border:2px solid rgba(128,128,128,.2);
				border-top-color:var(--vscode-progressBar-background,#0e70c0);
				border-radius:50%;animation:spin .7s linear infinite; }
			@keyframes spin{to{transform:rotate(360deg)}}
			.wrap{display:flex;align-items:center;gap:10px;opacity:.7;font-size:13px;}
		</style></head>
		<body><div class="wrap"><div class="spinner"></div><span>Loading <b>${esc(title)}</b>…</span></div></body></html>`;
	}

	private static _codeHtml(schema: string, name: string, ddl: string, typeLabel: string): string {
		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;font-family:var(--vscode-font-family);
	font-size:var(--vscode-font-size,13px);background:var(--vscode-editor-background);
	color:var(--vscode-foreground);display:flex;flex-direction:column;overflow:hidden}
.header{display:flex;align-items:center;gap:8px;padding:6px 12px;
	background:var(--vscode-editorGroupHeader-tabsBackground);
	border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.header-title{font-size:13px;font-weight:600}
.badge{font-size:11px;opacity:.55;background:var(--vscode-badge-background);
	color:var(--vscode-badge-foreground);padding:1px 7px;border-radius:10px}
.content{flex:1;overflow:hidden;display:flex;flex-direction:column}
#ddlEditor{flex:1}
.tabs{display:flex;background:var(--vscode-editorGroupHeader-tabsBackground);
	border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;padding:0 4px}
.tab{padding:6px 14px;font-size:12px;font-weight:500;cursor:pointer;
	border-bottom:2px solid transparent;color:var(--vscode-foreground);opacity:.65;user-select:none}
.tab.active{opacity:1;border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-textLink-foreground)}
.tab-pane{display:none;flex:1;overflow:hidden;flex-direction:column}
.tab-pane.active{display:flex}
.toolbar{display:flex;align-items:center;gap:8px;padding:4px 10px;
	background:var(--vscode-editorGroupHeader-tabsBackground);
	border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0}
.btn{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;
	background:var(--vscode-button-background);color:var(--vscode-button-foreground);
	border:none;border-radius:2px;font-family:inherit;font-size:11px;cursor:pointer;height:24px}
.btn:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.btn:disabled{opacity:.35;cursor:default}
.state{font-size:11px;opacity:.6}
.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;
	align-items:center;justify-content:center;z-index:1000}
.modal{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);
	border-radius:4px;min-width:340px;max-width:90%;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.modal-hd{display:flex;align-items:center;justify-content:space-between;
	padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border)}
.modal-title{font-weight:600;font-size:13px}
.modal-x{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:18px;opacity:.6}
.modal-x:hover{opacity:1}
.modal-bd{padding:14px}
.modal-ft{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;
	border-top:1px solid var(--vscode-panel-border)}
.btn-cancel{padding:5px 12px;background:var(--vscode-button-secondaryBackground);
	color:var(--vscode-button-secondaryForeground);border:none;border-radius:2px;cursor:pointer;font-size:12px}
.btn-ok{padding:5px 12px;background:var(--vscode-button-background);
	color:var(--vscode-button-foreground);border:none;border-radius:2px;cursor:pointer;font-size:12px}
.btn-ok:hover{background:var(--vscode-button-hoverBackground)}
</style></head><body>
<div class="header">
	<span class="header-title">${esc(name)}</span>
	<span class="badge">${esc(typeLabel)}</span>
	<span class="badge">schema: ${esc(schema)}</span>
</div>
<div class="content">
	<div class="tabs">
		<div class="tab active" data-tab="ddl">DDL</div>
	</div>
	<div class="tab-pane active" id="ddl-pane">
		<div class="toolbar">
			<button class="btn" id="editSaveBtn">✎ Edit</button>
			<span class="state" id="dirtyState">Saved</span>
		</div>
		<div id="ddlEditor"></div>
	</div>
</div>

<!-- Confirm modal (replaces window.confirm; webviews are sandboxed) -->
<div id="confirmOv" class="modal-ov" style="display:none">
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmMsg">
		<div class="modal-hd">
			<span class="modal-title" id="confirmTitle">Confirm</span>
			<button class="modal-x" id="confirmClose" aria-label="Close">&times;</button>
		</div>
		<div class="modal-bd">
			<div id="confirmMsg" style="white-space:pre-wrap;line-height:1.35"></div>
		</div>
		<div class="modal-ft">
			<button type="button" class="btn-cancel" id="confirmCancel">Cancel</button>
			<button type="button" class="btn-ok" id="confirmOk">OK</button>
		</div>
	</div>
</div>
<script>
require.config({paths:{vs:'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs'}});
require(['vs/editor/editor.main'],function(){
	const isDark = document.body.classList.contains('vscode-dark')
		|| document.body.classList.contains('vscode-high-contrast');
	const isHC = document.body.classList.contains('vscode-high-contrast');
	const base = isHC ? 'hc-black' : (isDark ? 'vs-dark' : 'vs');

	function getVar(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}

	function applyTheme(){
		const dark = document.body.classList.contains('vscode-dark')
			|| document.body.classList.contains('vscode-high-contrast');
		const hc = document.body.classList.contains('vscode-high-contrast');
		const b = hc ? 'hc-black' : (dark ? 'vs-dark' : 'vs');
		const bg  = getVar('--vscode-editor-background');
		const fg  = getVar('--vscode-editor-foreground');
		const ln  = getVar('--vscode-editorLineNumber-foreground');
		const cur = getVar('--vscode-editorCursor-foreground');
		const sel = getVar('--vscode-editor-selectionBackground');
		monaco.editor.defineTheme('vsc-match', {
			base: b, inherit: true, rules: [],
			colors: Object.assign({},
				bg  ? {'editor.background': bg}  : {},
				fg  ? {'editor.foreground': fg}   : {},
				ln  ? {'editorLineNumber.foreground': ln} : {},
				cur ? {'editorCursor.foreground': cur}    : {},
				sel ? {'editor.selectionBackground': sel} : {}
			)
		});
		monaco.editor.setTheme('vsc-match');
	}

	applyTheme();
	const vscode = acquireVsCodeApi();

	function confirmModal(message, opts){
		const o = opts || {};
		const ov = document.getElementById('confirmOv');
		const titleEl = document.getElementById('confirmTitle');
		const msgEl = document.getElementById('confirmMsg');
		const okBtn = document.getElementById('confirmOk');
		const cancelBtn = document.getElementById('confirmCancel');
		const closeBtn = document.getElementById('confirmClose');

		titleEl.textContent = o.title || 'Confirm';
		msgEl.textContent = String(message || '');
		okBtn.textContent = o.okText || 'OK';
		cancelBtn.textContent = o.cancelText || 'Cancel';

		ov.style.display = 'flex';
		okBtn.focus();

		return new Promise((resolve)=>{
			function cleanup(){
				ov.style.display = 'none';
				document.removeEventListener('keydown', onKey);
				ov.removeEventListener('click', onOverlayClick);
				okBtn.removeEventListener('click', onOk);
				cancelBtn.removeEventListener('click', onCancel);
				closeBtn.removeEventListener('click', onCancel);
			}
			function finish(val){
				cleanup();
				resolve(!!val);
			}
			function onOk(){ finish(true); }
			function onCancel(){ finish(false); }
			function onOverlayClick(e){ if(e && e.target && e.target.id==='confirmOv'){ finish(false); } }
			function onKey(e){
				if(e.key==='Escape'){ finish(false); }
				if(e.key==='Enter'){ finish(true); }
			}
			okBtn.addEventListener('click', onOk);
			cancelBtn.addEventListener('click', onCancel);
			closeBtn.addEventListener('click', onCancel);
			ov.addEventListener('click', onOverlayClick);
			document.addEventListener('keydown', onKey);
		});
	}

	const editSaveBtn = document.getElementById('editSaveBtn');
	const dirtyState = document.getElementById('dirtyState');
	const editorHost = document.getElementById('ddlEditor');

	let diffEditor = null;
	let modifiedEditor = null;
	let isEditMode = false;
	const originalText = ${JSON.stringify(ddl)};

	const fontFamily = getVar('--vscode-editor-font-family') || 'Consolas, monospace';

	const originalModel = monaco.editor.createModel(originalText, 'sql');
	const modifiedModel = monaco.editor.createModel(originalText, 'sql');

	diffEditor = monaco.editor.createDiffEditor(editorHost,{
		automaticLayout:true,
		minimap:{enabled:false},
		fontSize:13,
		fontFamily,
		wordWrap:'on',
		tabSize:2,
		lineNumbers:'on',
		renderWhitespace:'none',
		scrollBeyondLastLine:false,
		renderSideBySide:false,
		renderIndicators:true,
		originalEditable:false,
	});
	diffEditor.setModel({original: originalModel, modified: modifiedModel});

	const originalEd = diffEditor.getOriginalEditor();
	modifiedEditor = diffEditor.getModifiedEditor();

	originalEd.updateOptions({ readOnly: true });
	modifiedEditor.updateOptions({ readOnly: true });

	function refreshDirty(){
		const val = modifiedEditor.getValue();
		const dirty = val !== originalText;
		if(!isEditMode){
			dirtyState.textContent = dirty ? 'Modified' : 'Saved';
			editSaveBtn.textContent = '✎ Edit';
			editSaveBtn.disabled = false;
			return;
		}
		dirtyState.textContent = dirty ? 'Modified' : 'Saved';
		editSaveBtn.textContent = dirty ? '▶ Execute' : '▶ Execute (no changes)';
		editSaveBtn.disabled = !dirty;
	}

	modifiedEditor.onDidChangeModelContent(()=>refreshDirty());
	refreshDirty();

	editSaveBtn.addEventListener('click', async ()=>{
		if(!diffEditor || !modifiedEditor){ return; }
		if(!isEditMode){
			isEditMode = true;
			modifiedEditor.updateOptions({ readOnly: false });
			refreshDirty();
			return;
		}
		const ddlToExecute = modifiedEditor.getValue();
		const ok = await confirmModal(
			'Execute DDL and recreate this routine?\\n\\nThe changes will apply immediately.',
			{ title:'Execute DDL', okText:'Execute', cancelText:'Cancel' }
		);
		if(!ok){ return; }
		editSaveBtn.disabled = true;
		vscode.postMessage({ command:'executeRoutineDDL', ddl: ddlToExecute });
	});

	new MutationObserver(applyTheme).observe(document.body,{attributes:true,attributeFilter:['class']});
	diffEditor.layout();
	document.querySelectorAll('.tab').forEach(tab=>{
		tab.addEventListener('click',()=>{
			setTimeout(()=>diffEditor && diffEditor.layout(),30);
		});
	});
});
</script></body></html>`;
	}

	private static _tableHtml(
		schema: string,
		tableName: string,
		ddl: string,
		indexes: IndexInfo[],
		foreignKeys: ForeignKeyInfo[],
		constraints: ConstraintInfo[],
		columnDetails: ColumnDetail[]
	): string {
		const fieldNames = columnDetails.map(c => c.col);

		// Find PK column for row editing
		const pkCol = columnDetails.find(c => c.is_pk)?.col ?? fieldNames[0] ?? '';

		// ── Columns tab ──
		const columnsTabHtml = columnDetails.map((col) => {
			const badges: string[] = [];
			if (col.is_pk)                  { badges.push(`<span class="badge badge--pk">PK</span>`); }
			if (col.is_unique && !col.is_pk){ badges.push(`<span class="badge badge--uq">UQ</span>`); }
			if (col.fk_table)               { badges.push(`<span class="badge badge--fk">FK</span>`); }
			if (col.notnull && !col.is_pk)  { badges.push(`<span class="badge badge--nn">NN</span>`); }

			const fkRef = col.fk_table
				? `<a class="fk-link" data-schema="${esc(schema)}" data-table="${esc(col.fk_table)}">→ ${esc(col.fk_table)}${col.fk_col ? '.' + esc(col.fk_col) : ''}</a>`
				: '—';

			const ft = this._formatType(col.col_type);
			return `<tr data-col-name="${esc(col.col)}"
				data-col-type="${esc(col.col_type)}"
				data-col-default="${esc(col.col_default ?? '')}"
				data-col-comment="${esc(col.col_comment ?? '')}"
				data-col-notnull="${col.notnull ? '1' : '0'}">
				<td class="mono col-name">${esc(col.col)}</td>
				<td class="mono"><span class="type-badge ${ft.class}">${ft.display}</span></td>
				<td>${badges.join(' ')}</td>
				<td class="mono small">${col.col_default ? esc(col.col_default) : '<span class="dim">—</span>'}</td>
				<td class="mono small">${fkRef}</td>
				<td class="comment">${col.col_comment ? esc(col.col_comment) : '<span class="dim">—</span>'}</td>
			</tr>`;
		}).join('');

		// ── Indexes tab ──
		const indexesHtml = indexes.length
			? indexes.map(idx => `<tr>
				<td class="mono">${esc(idx.name)}</td>
				<td>${esc(idx.columns.join(', '))}</td>
				<td>${esc(idx.type)}</td>
				<td class="center">${idx.unique ? '<span class="badge badge--yes">✓</span>' : '—'}</td>
				<td class="center">${idx.primary ? '<span class="badge badge--pk">PK</span>' : '—'}</td>
			</tr>`).join('')
			: '<tr><td colspan="5" class="empty">No indexes</td></tr>';

		// ── FK tab ──
		const outgoing = foreignKeys.filter(fk => fk.direction === 'outgoing');
		const incoming = foreignKeys.filter(fk => fk.direction === 'incoming');
		const fkRows = (fks: ForeignKeyInfo[], dir: string) => fks.length
			? fks.map(fk => `<tr>
				<td class="mono">${esc(fk.constraintName)}</td>
				<td>${esc(fk.columns.join(', '))}</td>
				<td><a class="fk-link" data-schema="${esc(fk.foreignSchema)}" data-table="${esc(fk.foreignTable)}">${esc(fk.foreignSchema)}.${esc(fk.foreignTable)}</a></td>
				<td>${esc(fk.foreignColumns.join(', '))}</td>
			</tr>`).join('')
			: `<tr><td colspan="4" class="empty">No ${dir} FK</td></tr>`;

		// ── Keys & Checks tabs ──
		const keyConstraints = constraints.filter((c) => c.type === 'PRIMARY KEY' || c.type === 'UNIQUE');
		const checkConstraints = constraints.filter((c) => c.type === 'CHECK');

		const keyConstraintsHtml = keyConstraints.length
			? keyConstraints.map(c => `<tr>
				<td class="mono">${esc(c.name)}</td>
				<td><span class="badge badge--${c.type === 'PRIMARY KEY' ? 'pk' : 'uq'}">${esc(c.type)}</span></td>
				<td>${esc(c.columns.join(', '))}</td>
				<td class="mono small">${c.definition ? esc(c.definition) : '—'}</td>
			</tr>`).join('')
			: '<tr><td colspan="4" class="empty">No keys</td></tr>';

		const checksHtml = checkConstraints.length
			? checkConstraints.map(c => `<tr>
				<td class="mono">${esc(c.name)}</td>
				<td>${esc(c.columns.join(', '))}</td>
				<td class="mono small">${c.definition ? esc(c.definition) : '—'}</td>
			</tr>`).join('')
			: '<tr><td colspan="3" class="empty">No checks</td></tr>';

		// ── Data tab header ──
		const dataHeaderHtml = fieldNames.map((f, i) =>
			`<th class="sortable" data-col="${i}" data-colname="${esc(f)}">${esc(f)} <span class="sort-icon"></span></th>`
		).join('');
		const allColumnsForInsert = JSON.stringify(fieldNames);

		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);
	background:var(--vscode-editor-background);color:var(--vscode-foreground);
	display:flex;flex-direction:column;overflow:hidden}

.tabs{display:flex;background:var(--vscode-editorGroupHeader-tabsBackground);
	border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;padding:0 4px}
.tab{padding:6px 14px;font-size:12px;font-weight:500;cursor:pointer;
	border-bottom:2px solid transparent;color:var(--vscode-foreground);opacity:.65;user-select:none}
.tab:hover{opacity:.9}
.tab.active{opacity:1;border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-textLink-foreground)}
.tab-count{display:inline-block;margin-left:4px;padding:0 5px;
	background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
	border-radius:8px;font-size:10px;font-weight:600;vertical-align:middle}

.content{flex:1;overflow:hidden;display:flex;flex-direction:column}
.tab-pane{display:none;flex:1;overflow:hidden;flex-direction:column}
.tab-pane.active{display:flex}
#ddlEditor{flex:1}

.toolbar{display:flex;align-items:center;gap:6px;padding:4px 8px;
	background:var(--vscode-editorGroupHeader-tabsBackground);
	border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;height:32px}
.sw{position:relative;flex:1;max-width:240px}
.si{position:absolute;left:6px;top:50%;transform:translateY(-50%);opacity:.45;font-size:11px;pointer-events:none}
.sinput{width:100%;padding:3px 8px 3px 22px;background:var(--vscode-input-background);
	border:1px solid var(--vscode-input-border,transparent);color:var(--vscode-input-foreground);
	font-family:inherit;font-size:12px;border-radius:2px;outline:none;height:22px}
.sinput:focus{border-color:var(--vscode-focusBorder)}
.sinput::placeholder{color:var(--vscode-input-placeholderForeground)}
.row-info{font-size:11px;opacity:.5;margin-left:auto}

.btn-act{display:inline-flex;align-items:center;justify-content:center;
	width:24px;height:22px;padding:0;background:var(--vscode-button-background);
	color:var(--vscode-button-foreground);border:none;border-radius:2px;font-size:13px;cursor:pointer}
.btn-act:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.btn-act:disabled{opacity:.35;cursor:default}
.btn-act.danger:hover:not(:disabled){color:var(--vscode-errorForeground,#f14c4c)}

/* Inline btn (data tab toolbar) */
.btn-inline{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;height:22px;
	background:var(--vscode-button-background);color:var(--vscode-button-foreground);
	border:none;border-radius:2px;font-family:inherit;font-size:11px;cursor:pointer}
.btn-inline:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.btn-inline:disabled{opacity:.35;cursor:default}
.btn-inline.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.btn-inline.secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
.btn-inline.danger{background:transparent;color:var(--vscode-errorForeground,#f14c4c);border:1px solid rgba(229,83,75,.3)}
.btn-inline.danger:hover:not(:disabled){background:rgba(229,83,75,.1)}
.changes-badge{display:inline-block;padding:1px 6px;background:var(--vscode-badge-background);
	color:var(--vscode-badge-foreground);border-radius:8px;font-size:10px;font-weight:600}

.tscroll{flex:1;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
thead{position:sticky;top:0;z-index:5}
th{padding:4px 10px;text-align:left;background:var(--vscode-editorGroupHeader-tabsBackground);
	font-weight:600;font-size:11px;border-bottom:2px solid var(--vscode-panel-border);
	border-right:1px solid var(--vscode-panel-border);white-space:nowrap}
th.sortable{cursor:pointer;user-select:none}
th.sortable:hover{background:var(--vscode-list-hoverBackground)}
th.sorted-asc .sort-icon::after{content:' ▲';font-size:8px}
th.sorted-desc .sort-icon::after{content:' ▼';font-size:8px}
td{padding:4px 10px;height:26px;
	border-bottom:1px solid var(--vscode-list-inactiveSelectionBackground,rgba(128,128,128,0.08));
	border-right:1px solid var(--vscode-panel-border);
	max-width:360px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;vertical-align:middle}
tr:hover td{background:var(--vscode-list-hoverBackground)}
#colBody tr{cursor:pointer}
#colBody tr.sel td{background:var(--vscode-list-activeSelectionBackground)}
.center{text-align:center}
.mono{font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
.small{font-size:10px}
.null-val{color:#808080;font-style:italic}
.empty{text-align:center;opacity:.4;padding:16px!important;font-style:italic}
.dim{opacity:.35}
.col-name{font-weight:600}
.comment{font-size:11px;color:var(--vscode-descriptionForeground);white-space:normal;max-width:220px}

/* ── Data tab cell editing ── */
#dataTable td.cell{position:relative;padding:0;}
#dataTable td.cell .cell-display{display:block;padding:4px 10px;height:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
#dataTable td.cell input.cell-input{display:none;width:100%;height:100%;padding:3px 8px;
	background:var(--vscode-input-background);color:var(--vscode-input-foreground);
	border:1.5px solid var(--vscode-focusBorder);font-family:var(--vscode-editor-font-family,monospace);
	font-size:11px;outline:none;box-sizing:border-box;}
#dataTable td.cell.editing .cell-display{display:none;}
#dataTable td.cell.editing input.cell-input{display:block;}
#dataTable td.cell.edited{background:rgba(255,200,80,.08)!important;border-bottom-color:rgba(255,200,80,.3)!important;}
#dataTable tr.selected td{background:var(--vscode-list-activeSelectionBackground);}
#dataTable .row-num{width:40px;min-width:40px;text-align:right;color:var(--vscode-editorLineNumber-foreground);
	font-size:10px;border-right:2px solid var(--vscode-panel-border);padding-right:6px;
	cursor:default;user-select:none;background:var(--vscode-editorGutter-background,var(--vscode-editorGroupHeader-tabsBackground));}

.badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700}
.badge--pk{background:rgba(86,156,214,.2);color:#569cd6}
.badge--uq{background:rgba(220,220,170,.2);color:#dcdcaa}
.badge--fk{background:rgba(210,162,42,.2);color:#d2a22a}
.badge--nn{background:rgba(206,145,120,.15);color:#ce9178}
.badge--ck{background:rgba(206,145,120,.2);color:#ce9178}
.badge--yes{background:rgba(78,201,176,.2);color:#4ec9b0}

.fk-link{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none;
	font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
.fk-link:hover{text-decoration:underline}

.type-badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600;
	font-family:var(--vscode-editor-font-family,monospace)}
.type-string  {background:rgba(86,156,214,.15);color:#569cd6}
.type-number  {background:rgba(181,206,168,.15);color:#b5cea8}
.type-datetime{background:rgba(206,145,120,.15);color:#ce9178}
.type-boolean {background:rgba(220,220,170,.15);color:#dcdcaa}
.type-uuid    {background:rgba(197,134,192,.15);color:#c586c0}
.type-json    {background:rgba(78,201,176,.15);color:#4ec9b0}
.type-binary  {background:rgba(156,220,254,.15);color:#9cdcfe}
.type-other   {background:rgba(128,128,128,.15);color:#808080}

.sec-h{padding:5px 10px;font-size:10px;font-weight:700;opacity:.6;
	background:var(--vscode-sideBar-background,var(--vscode-editorGroupHeader-tabsBackground));
	border-bottom:1px solid var(--vscode-panel-border);text-transform:uppercase;letter-spacing:.06em}

.pag{display:flex;align-items:center;gap:5px;padding:4px 10px;
	background:var(--vscode-editorGroupHeader-tabsBackground);
	border-top:1px solid var(--vscode-panel-border);flex-shrink:0;font-size:11px;height:30px}
.pbtn{background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);
	cursor:pointer;font-size:11px;padding:1px 7px;border-radius:2px}
.pbtn:hover:not(:disabled){background:var(--vscode-list-hoverBackground)}
.pbtn:disabled{opacity:.3;cursor:default}
.pbtn.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.pinfo{opacity:.5;margin-left:auto}

.modal-ov{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;
	align-items:center;justify-content:center;z-index:1000}
.modal{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);
	border-radius:4px;min-width:340px;max-width:90%;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.modal-hd{display:flex;align-items:center;justify-content:space-between;
	padding:10px 14px;border-bottom:1px solid var(--vscode-panel-border)}
.modal-title{font-weight:600;font-size:13px}
.modal-x{background:none;border:none;color:var(--vscode-foreground);cursor:pointer;font-size:18px;opacity:.6}
.modal-x:hover{opacity:1}
.modal-bd{padding:14px}
.modal-ft{display:flex;justify-content:flex-end;gap:8px;padding:10px 14px;
	border-top:1px solid var(--vscode-panel-border)}
.fg{margin-bottom:12px}
.fg:last-child{margin-bottom:0}
.fg label{display:block;font-size:11px;font-weight:600;margin-bottom:4px}
.fi,.fs{width:100%;padding:5px 8px;background:var(--vscode-input-background);
	border:1px solid var(--vscode-input-border,transparent);color:var(--vscode-input-foreground);
	font-family:inherit;font-size:12px;border-radius:2px}
.fi:focus,.fs:focus{border-color:var(--vscode-focusBorder);outline:none}
.btn-cancel{padding:5px 12px;background:var(--vscode-button-secondaryBackground);
	color:var(--vscode-button-secondaryForeground);border:none;border-radius:2px;cursor:pointer;font-size:12px}
.btn-ok{padding:5px 12px;background:var(--vscode-button-background);
	color:var(--vscode-button-foreground);border:none;border-radius:2px;cursor:pointer;font-size:12px}
.btn-ok:hover{background:var(--vscode-button-hoverBackground)}
</style></head><body>

<div class="tabs">
	<div class="tab active" data-tab="columns">Columns <span class="tab-count">${columnDetails.length}</span></div>
	<div class="tab" data-tab="keys">Keys <span class="tab-count">${keyConstraints.length + foreignKeys.length}</span></div>
	<div class="tab" data-tab="checks">Checks <span class="tab-count">${checkConstraints.length}</span></div>
	<div class="tab" data-tab="indexes">Indexes <span class="tab-count">${indexes.length}</span></div>
	<div class="tab" data-tab="data">Data</div>
	<div class="tab" data-tab="ddl">DDL</div>
</div>

<div class="content">

<!-- ── COLUMNS ── -->
<div class="tab-pane active" id="columns-pane">
	<div class="toolbar">
		<button class="btn-act" id="addColBtn" title="Add column">+</button>
		<button class="btn-act danger" id="deleteColBtn" disabled title="Delete selected column">−</button>
		<button class="btn-act" id="editColBtn" disabled title="Edit selected column">✎</button>
		<div class="sw"><span class="si">⌕</span>
			<input class="sinput" id="colSearch" placeholder="Filter columns…" autocomplete="off">
		</div>
	</div>
	<div class="tscroll">
		<table><thead><tr>
			<th>Column</th><th>Type</th><th>Flags</th><th>Default</th><th>References</th><th>Comment</th>
		</tr></thead>
		<tbody id="colBody">${columnsTabHtml}</tbody></table>
	</div>
</div>

<!-- ── DDL ── -->
<div class="tab-pane" id="ddl-pane">
	<div id="ddlEditor"></div>
</div>

<!-- ── KEYS ── -->
<div class="tab-pane" id="keys-pane">
	<div class="tscroll">
		<div class="sec-h">Key constraints (PK / UNIQUE)</div>
		<table>
			<thead><tr><th>Name</th><th>Type</th><th>Columns</th><th>Definition</th></tr></thead>
			<tbody>${keyConstraintsHtml}</tbody>
		</table>

		<div class="sec-h" style="margin-top:1px">Foreign keys</div>
		<div class="sec-h">Outgoing (this → other)</div>
		<table><thead><tr><th>Constraint</th><th>Columns</th><th>References</th><th>Ref. Columns</th></tr></thead>
		<tbody>${fkRows(outgoing, 'outgoing')}</tbody></table>
		<div class="sec-h" style="margin-top:1px">Incoming (other → this)</div>
		<table><thead><tr><th>Constraint</th><th>Ref. Columns</th><th>From Table</th><th>Columns</th></tr></thead>
		<tbody>${fkRows(incoming, 'incoming')}</tbody></table>
	</div>
</div>

<!-- ── CHECKS ── -->
<div class="tab-pane" id="checks-pane">
	<div class="tscroll"><table>
		<thead><tr><th>Name</th><th>Columns</th><th>Definition</th></tr></thead>
		<tbody>${checksHtml}</tbody>
	</table></div>
</div>

<!-- ── DATA (with inline editing) ── -->
<div class="tab-pane" id="data-pane">
	<div class="toolbar">
		<div class="sw"><span class="si">⌕</span>
			<input class="sinput" id="dataSearch" placeholder="Search rows…" autocomplete="off">
		</div>
		<button class="btn-inline" id="addRowBtn">+ Row</button>
		<button class="btn-inline danger" id="deleteRowsBtn" disabled>− Delete</button>
		<label style="display:flex;align-items:center;gap:4px;font-size:11px;flex-shrink:0">
			<span style="opacity:.5">Limit:</span>
			<input type="text" class="sinput" id="dataLimit" value="1000" style="width:60px;text-align:right;padding-left:8px">
		</label>
		<!-- Change controls (hidden until edits exist) -->
		<span id="changesGroup" style="display:none;align-items:center;gap:5px">
			<span class="changes-badge" id="changesBadge">0</span>
			<span style="font-size:11px;opacity:.6">changed</span>
			<button class="btn-inline" id="applyChangesBtn">✓ Apply</button>
			<button class="btn-inline danger" id="discardChangesBtn">✕ Discard</button>
		</span>
		<span class="row-info" id="rowInfo">—</span>
	</div>
	<div class="tscroll" id="dataScroll">
		<table id="dataTable">
			<thead><tr><th class="row-num">#</th>${dataHeaderHtml}</tr></thead>
			<tbody id="dataBody"></tbody>
		</table>
	</div>
	<div class="pag" id="dataPag" style="display:none">
		<button class="pbtn" id="prevPage" disabled>‹</button>
		<span id="pageButtons"></span>
		<button class="pbtn" id="nextPage">›</button>
		<span class="pinfo" id="pagInfo"></span>
	</div>
</div>

<!-- ── INDEXES ── -->
<div class="tab-pane" id="indexes-pane">
	<div class="tscroll"><table>
		<thead><tr><th>Name</th><th>Columns</th><th>Type</th><th class="center">Unique</th><th class="center">Primary</th></tr></thead>
		<tbody>${indexesHtml}</tbody>
	</table></div>
</div>

</div><!-- /content -->

<!-- Add/Edit column modal -->
<div id="addModal" class="modal-ov" style="display:none">
	<div class="modal">
		<div class="modal-hd"><span class="modal-title" id="modalTitle">Add Column</span><button class="modal-x" id="closeModal">&times;</button></div>
		<div class="modal-bd">
			<div class="fg"><label>Column Name</label><input type="text" id="nc-name" class="fi" placeholder="column_name"></div>
			<div class="fg"><label>Data Type</label>
				<select id="nc-type" class="fs">
					<option>VARCHAR(255)</option><option>INTEGER</option><option>BIGINT</option>
					<option>TEXT</option><option>BOOLEAN</option><option>DATE</option>
					<option>TIMESTAMP</option><option>NUMERIC</option><option>REAL</option>
					<option>UUID</option><option>JSONB</option><option>BYTEA</option>
				</select>
			</div>
			<div class="fg"><label><input type="checkbox" id="nc-notnull"> NOT NULL</label></div>
			<div class="fg"><label>Default Value</label><input type="text" id="nc-default" class="fi" placeholder="Optional"></div>
			<div class="fg"><label>Comment</label><input type="text" id="nc-comment" class="fi" placeholder="Optional"></div>
		</div>
		<div class="modal-ft">
			<button type="button" class="btn-cancel" id="cancelModal">Cancel</button>
			<button type="button" class="btn-ok" id="confirmModal">Add Column</button>
		</div>
	</div>
</div>

<!-- Confirm modal (replaces window.confirm; webviews are sandboxed) -->
<div id="confirmOv" class="modal-ov" style="display:none">
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmMsg">
		<div class="modal-hd">
			<span class="modal-title" id="confirmTitle">Confirm</span>
			<button class="modal-x" id="confirmClose" aria-label="Close">&times;</button>
		</div>
		<div class="modal-bd">
			<div id="confirmMsg" style="white-space:pre-wrap;line-height:1.35"></div>
		</div>
		<div class="modal-ft">
			<button type="button" class="btn-cancel" id="confirmCancel">Cancel</button>
			<button type="button" class="btn-ok" id="confirmOk">OK</button>
		</div>
	</div>
</div>

<script>
require.config({paths:{vs:'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs'}});
const vscode = acquireVsCodeApi();

// ── Monaco theme ───────────────────────────────────────────────
function getVar(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}
function applyTheme(){
	const dark = document.body.classList.contains('vscode-dark')||document.body.classList.contains('vscode-high-contrast');
	const hc   = document.body.classList.contains('vscode-high-contrast');
	const base = hc ? 'hc-black' : (dark ? 'vs-dark' : 'vs');
	const colors = {};
	['--vscode-editor-background','--vscode-editor-foreground','--vscode-editorLineNumber-foreground',
	 '--vscode-editorCursor-foreground','--vscode-editor-selectionBackground'].forEach(v=>{
		const val = getVar(v); if(val) colors[v.replace('--vscode-','').replace(/-([a-z])/g,(_,c)=>'.'+c)] = val;
	});
	monaco.editor.defineTheme('vsc',{base,inherit:true,rules:[],colors});
	monaco.editor.setTheme('vsc');
}

let ddlEditor;
require(['vs/editor/editor.main'],()=>{
	applyTheme();
	ddlEditor = monaco.editor.create(document.getElementById('ddlEditor'),{
		value: ${JSON.stringify(ddl)},
		language:'sql',theme:'vsc',readOnly:true,
		minimap:{enabled:false},fontSize:13,
		fontFamily: getVar('--vscode-editor-font-family') || 'Consolas, monospace',
		automaticLayout:true,scrollBeyondLastLine:false,wordWrap:'on',
		tabSize:2,lineNumbers:'on',
	});
	new MutationObserver(applyTheme).observe(document.body,{attributes:true,attributeFilter:['class']});
});

// ── Tabs ───────────────────────────────────────────────────────
let dataLoaded = false;
document.querySelectorAll('.tab').forEach(tab=>{
	tab.addEventListener('click',()=>{
		const name = tab.dataset.tab;
		document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
		document.querySelectorAll('.tab-pane').forEach(p=>p.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById(name+'-pane').classList.add('active');
		if(name==='ddl' && ddlEditor){ setTimeout(()=>ddlEditor.layout(),30); }
		if(name==='data' && !dataLoaded){ dataLoaded=true; loadPage(1); }
	});
});

// ── FK links ───────────────────────────────────────────────────
document.addEventListener('click',e=>{
	const a=e.target.closest('.fk-link');
	if(a){ vscode.postMessage({command:'openTable',schema:a.dataset.schema,table:a.dataset.table}); }
});

// ── Column search ──────────────────────────────────────────────
document.getElementById('colSearch').addEventListener('input',e=>{
	const q=e.target.value.toLowerCase();
	document.querySelectorAll('#colBody tr').forEach(r=>{
		r.style.display=q&&!r.textContent.toLowerCase().includes(q)?'none':'';
	});
});

// ── Column row selection ───────────────────────────────────────
let selCol = null;
let selColMeta = null;
let modalMode = 'add';
let editOriginalColumnName = null;
let pendingDeleteColumn = null;

document.getElementById('colBody').addEventListener('click',function(e){
	const row = e.target instanceof Element ? e.target.closest('tr[data-col-name]') : null;
	if(!row){ return; }
	document.querySelectorAll('#colBody tr').forEach(r=>r.classList.remove('sel'));
	row.classList.add('sel');

	function decodeAttr(v){
		if(v===null||v===undefined){return null;}
		const ta=document.createElement('textarea');
		ta.innerHTML=String(v);
		return ta.value;
	}

	selCol = decodeAttr(row.getAttribute('data-col-name'));
	const defVal = decodeAttr(row.getAttribute('data-col-default'));
	const commentVal = decodeAttr(row.getAttribute('data-col-comment'));
	selColMeta = {
		colType: decodeAttr(row.getAttribute('data-col-type'))||'',
		notNull: row.getAttribute('data-col-notnull')==='1',
		defaultValue: defVal||null,
		comment: commentVal||null,
	};
	document.getElementById('deleteColBtn').disabled=false;
	document.getElementById('editColBtn').disabled=false;
});

// ── Delete column ──────────────────────────────────────────────
document.getElementById('deleteColBtn').addEventListener('click', async function(){
	if(!selCol){ return; }
	// Use webview confirm — posts back to extension only if confirmed
	const ok = await confirmModal(
		'Delete column "'+selCol+'"?\\n\\nAll data in this column will be permanently lost. Dependent objects will also be dropped (CASCADE).',
		{ title:'Delete column', okText:'Delete', cancelText:'Cancel' }
	);
	if(ok)	{
		pendingDeleteColumn = selCol;
		this.disabled = true;
		document.getElementById('editColBtn').disabled=true;
		vscode.postMessage({command:'deleteColumnClicked', columnName: selCol});
	}
});

// ── Edit column ────────────────────────────────────────────────
document.getElementById('editColBtn').addEventListener('click',function(){
	if(!selCol||!selColMeta){return;}
	modalMode='edit';
	editOriginalColumnName=selCol;
	document.getElementById('modalTitle').textContent='Edit Column';
	document.getElementById('confirmModal').textContent='Save Changes';
	document.getElementById('addModal').style.display='flex';
	document.getElementById('nc-name').value=selCol;
	const typeSelect=document.getElementById('nc-type');
	const colType=selColMeta.colType||'';
	let hasOpt=false;
	for(const opt of typeSelect.options){if(opt.value===colType){hasOpt=true;break;}}
	if(!hasOpt){const opt=document.createElement('option');opt.value=colType;opt.textContent=colType;typeSelect.appendChild(opt);}
	typeSelect.value=colType;
	document.getElementById('nc-notnull').checked=!!selColMeta.notNull;
	document.getElementById('nc-default').value=selColMeta.defaultValue??'';
	document.getElementById('nc-comment').value=selColMeta.comment??'';
	document.getElementById('nc-name').focus();
});

// ── Add column modal ───────────────────────────────────────────
document.getElementById('addColBtn').onclick=()=>{
	modalMode='add'; editOriginalColumnName=null;
	document.getElementById('modalTitle').textContent='Add Column';
	document.getElementById('confirmModal').textContent='Add Column';
	document.getElementById('addModal').style.display='flex';
	document.getElementById('nc-name').value='';
	document.getElementById('nc-default').value='';
	document.getElementById('nc-comment').value='';
	document.getElementById('nc-notnull').checked=false;
	const ts=document.getElementById('nc-type');
	if(ts&&ts.options.length){ts.value=ts.options[0].value;}
	document.getElementById('nc-name').focus();
};
function closeModal(){
	document.getElementById('addModal').style.display='none';
	modalMode='add'; editOriginalColumnName=null;
}
document.getElementById('closeModal').onclick=closeModal;
document.getElementById('cancelModal').onclick=closeModal;
document.getElementById('addModal').addEventListener('click',e=>{if(e.target.id==='addModal')closeModal();});
document.getElementById('confirmModal').onclick=()=>{
	const name=document.getElementById('nc-name').value.trim();
	if(!name){alert('Please enter a column name.');return;}
	if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)){alert('Invalid identifier.');return;}
	const columnType=document.getElementById('nc-type').value;
	const defaultValue=document.getElementById('nc-default').value.trim()||null;
	const comment=document.getElementById('nc-comment').value.trim()||null;
	if(modalMode==='add'){
		vscode.postMessage({command:'createColumn',columnName:name,columnType,
			notNull:document.getElementById('nc-notnull').checked,defaultValue,comment});
	}else{
		if(!editOriginalColumnName){alert('Column to edit is not selected.');return;}
		vscode.postMessage({command:'editColumn',originalColumnName:editOriginalColumnName,
			columnName:name,columnType,notNull:document.getElementById('nc-notnull').checked,defaultValue,comment});
	}
	closeModal();
};

// ── Confirm modal helper (window.confirm is blocked in sandboxed webviews) ──
function confirmModal(message, opts){
	const o = opts || {};
	const ov = document.getElementById('confirmOv');
	const titleEl = document.getElementById('confirmTitle');
	const msgEl = document.getElementById('confirmMsg');
	const okBtn = document.getElementById('confirmOk');
	const cancelBtn = document.getElementById('confirmCancel');
	const closeBtn = document.getElementById('confirmClose');

	titleEl.textContent = o.title || 'Confirm';
	msgEl.textContent = String(message || '');
	okBtn.textContent = o.okText || 'OK';
	cancelBtn.textContent = o.cancelText || 'Cancel';

	ov.style.display = 'flex';
	okBtn.focus();

	return new Promise((resolve)=>{
		function cleanup(){
			ov.style.display = 'none';
			document.removeEventListener('keydown', onKey);
			ov.removeEventListener('click', onOverlayClick);
			okBtn.removeEventListener('click', onOk);
			cancelBtn.removeEventListener('click', onCancel);
			closeBtn.removeEventListener('click', onCancel);
		}
		function finish(val){
			cleanup();
			resolve(!!val);
		}
		function onOk(){ finish(true); }
		function onCancel(){ finish(false); }
		function onOverlayClick(e){ if(e && e.target && e.target.id==='confirmOv'){ finish(false); } }
		function onKey(e){
			if(e.key==='Escape'){ finish(false); }
			if(e.key==='Enter'){ finish(true); }
		}
		okBtn.addEventListener('click', onOk);
		cancelBtn.addEventListener('click', onCancel);
		closeBtn.addEventListener('click', onCancel);
		ov.addEventListener('click', onOverlayClick);
		document.addEventListener('keydown', onKey);
	});
}

// ══════════════════════════════════════════════════════════════
//  DATA TAB — pagination, sorting, inline editing
// ══════════════════════════════════════════════════════════════
const PK_COL = ${JSON.stringify(pkCol)};
const ROW_CTID_COL = '__pgtools_ctid';
const ALL_COLUMNS = ${allColumnsForInsert};
let PAGE_SIZE=1000, CUR=1, TOTAL_PAGES=1, HAS_MORE=false;
let SORT_COL=null, SORT_DIR='ASC', SORT_IDX=null, FIELDS=[];

// pendingEdits: Map<rowIndex, Map<colName, newValue>>
const pendingEdits = new Map();
// originalData[rowIndex][colName] = original value (from server)
let originalData = [];
let serverRowsLen = 0; // number of rows loaded from DB
const newRowIndices = new Set(); // row indices inside originalData that are not persisted yet
const selectedRowIndices = new Set();
let lastSelectedRowIndex = null;

function getEditCount(){
	let n=0;
	for(const row of pendingEdits.values()) n+=row.size;
	return n;
}

function updateChangesUI(){
	const n=getEditCount();
	const grp=document.getElementById('changesGroup');
	grp.style.display=n>0?'inline-flex':'none';
	document.getElementById('changesBadge').textContent=String(n);
}

function updateDeleteRowsButton(){
	const btn = document.getElementById('deleteRowsBtn');
	if (btn) { btn.disabled = selectedRowIndices.size === 0; }
}

function setRowInfo(text){
	const el = document.getElementById('rowInfo');
	if(el){ el.textContent = text; }
}

function applyRowSelectionStyles(){
	document.querySelectorAll('#dataBody tr[data-row]').forEach((tr)=>{
		const rowIdx = parseInt(tr.getAttribute('data-row')||'-1',10);
		tr.classList.toggle('selected', selectedRowIndices.has(rowIdx));
	});
	updateDeleteRowsButton();
}

function isNewRow(rowIdx){
	return newRowIndices.has(rowIdx);
}

function renderDataRows(){
	const tbody = document.getElementById('dataBody');
	const fields = FIELDS || [];
	if(!tbody){ return; }

	if(!originalData.length){
		tbody.innerHTML='<tr><td colspan="100%" style="text-align:center;opacity:.4;padding:20px;font-style:italic">No data</td></tr>';
		return;
	}

	tbody.innerHTML=originalData.map((row,ri)=>{
		const cells=fields.map(f=>{
			const v=row[f];
			const isNull=v===null || v===undefined;
			const newRow=isNewRow(ri);
			const isPk=f===PK_COL;

			const disp = isNull ? (newRow ? '' : 'NULL') : escH(String(v));
			const dispClass = (isNull && !newRow) ? 'cell-display null-val' : 'cell-display';

			return '<td class="cell'+(isPk?' pk-cell':'')+'" data-row="'+ri+'" data-col="'+escH(f)+'">'
				+'<span class="'+dispClass+'">'+disp+'</span>'
				+'<input class="cell-input" type="text" value="'+escH(isNull ? '' : String(v))+'">'
				+'</td>';
		}).join('');
		return '<tr data-row="'+ri+'"><td class="row-num">'+(ri+1+(CUR-1)*PAGE_SIZE)+'</td>'+cells+'</tr>';
	}).join('');

	applyRowSelectionStyles();
}

// Apply / Discard
document.getElementById('applyChangesBtn').addEventListener('click',()=>{
	const updates=[];
	const insertValuesByRow = new Map(); // rowIdx -> {col: value}

	// Ensure all local new rows are inserted, even if user didn't edit anything.
	for(const rowIdx of Array.from(newRowIndices)){
		insertValuesByRow.set(rowIdx, {});
	}

	for(const [rowIdx, colMap] of pendingEdits.entries()){
		const orig=originalData[rowIdx];
		if(!orig){continue;}

		if(isNewRow(rowIdx)){
			const values = insertValuesByRow.get(rowIdx);
			if(!values){continue;}
			for(const [col,val] of colMap.entries()){
				let v = val;
				// Convention: user can type "NULL" to force SQL NULL.
				if(typeof v === 'string' && v.trim().toUpperCase()==='NULL'){ v = null; }
				values[col]=v;
			}
		}else{
			const pkVal=orig[PK_COL];
			const rowCtid=orig[ROW_CTID_COL]||null;
			for(const [col,val] of colMap.entries()){
				updates.push({pkCol:PK_COL, pkVal, rowCtid, col, val});
			}
		}
	}

	const inserts = Array.from(insertValuesByRow.entries()).map(([_, values])=>({ values }));

	if(updates.length===0 && inserts.length===0){return;}

	setRowInfo('Sending: applyTableRowEdits (inserts: ' + inserts.length + ', updates: ' + updates.length + ')…');
	document.getElementById('applyChangesBtn').disabled=true;
	vscode.postMessage({command:'applyTableRowEdits', updates, inserts});
});

document.getElementById('discardChangesBtn').addEventListener('click',()=>{
	pendingEdits.clear();
	newRowIndices.clear();
	selectedRowIndices.clear();
	lastSelectedRowIndex = null;
	originalData = originalData.slice(0, serverRowsLen);
	updateChangesUI();
	document.getElementById('applyChangesBtn').disabled=false;
	renderDataRows();
});

// Inline cell editing — double-click
document.getElementById('dataBody').addEventListener('dblclick',e=>{
	const cell=e.target.closest('td.cell');
	if(!cell){return;}
	// Don't allow editing PK column
	if(cell.dataset.col===PK_COL && PK_COL!==''){
		// Allow editing only non-PK cells
		return;
	}
	startCellEdit(cell);
});

function startCellEdit(cell){
	if(cell.classList.contains('editing')){return;}
	cell.classList.add('editing');
	const input=cell.querySelector('input.cell-input');
	const disp=cell.querySelector('.cell-display');
	// Set input value from display (strip NULL placeholder)
	const rowIdx=parseInt(cell.dataset.row);
	const col=cell.dataset.col;
	const orig=originalData[rowIdx];
	const currentVal=(pendingEdits.get(rowIdx)?.get(col)!==undefined)
		? pendingEdits.get(rowIdx).get(col)
		: (orig?(orig[col]===undefined?null:orig[col]):null);
	input.value=(currentVal===null)?'':String(currentVal);
	input.focus();
	input.select();

	function commit(){
		cell.classList.remove('editing');
		const newVal=input.value;
		const origVal=orig?(orig[col]===undefined?null:orig[col]):null;
		const origStr=(origVal===null)?'':String(origVal);
		// Only record if actually changed from DB value
		if(newVal!==origStr){
			if(!pendingEdits.has(rowIdx)){pendingEdits.set(rowIdx,new Map());}
			pendingEdits.get(rowIdx).set(col,newVal===''?null:newVal);
			const newRow=isNewRow(rowIdx);
			if(newVal==='' && newRow){
				disp.textContent='';
				disp.className='cell-display';
			}else{
				disp.textContent=newVal===''?'NULL':newVal;
				disp.className=newVal===''?'cell-display null-val':'cell-display';
			}
			cell.classList.add('edited');
		} else {
			// Revert to original if unchanged
			if(pendingEdits.has(rowIdx)){pendingEdits.get(rowIdx).delete(col);}
			const newRow=isNewRow(rowIdx);
			if(origVal===null && newRow){
				disp.textContent='';
				disp.className='cell-display';
			}else{
				disp.textContent=origVal===null?'NULL':String(origVal);
				disp.className=origVal===null?'cell-display null-val':'cell-display';
			}
			cell.classList.remove('edited');
		}
		updateChangesUI();
	}

	input.addEventListener('blur',()=>commit(),{once:true});
	input.addEventListener('keydown',ev=>{
		if(ev.key==='Enter'){input.blur();}
		if(ev.key==='Escape'){
			cell.classList.remove('editing');
			input.removeEventListener('blur',commit);
			// Don't commit on escape
		}
	});
}

// Row selection (single / ctrl / shift)
document.getElementById('dataBody').addEventListener('click',e=>{
	const row=e.target.closest('tr[data-row]');
	if(!row){return;}
	const rowIdx = parseInt(row.dataset.row,10);
	if(Number.isNaN(rowIdx)){return;}
	if(e.shiftKey && lastSelectedRowIndex!==null){
		const [from,to]=rowIdx>lastSelectedRowIndex?[lastSelectedRowIndex,rowIdx]:[rowIdx,lastSelectedRowIndex];
		selectedRowIndices.clear();
		for(let i=from;i<=to;i++){selectedRowIndices.add(i);}
	}else if(e.ctrlKey || e.metaKey){
		if(selectedRowIndices.has(rowIdx)){selectedRowIndices.delete(rowIdx);}
		else{selectedRowIndices.add(rowIdx);}
		lastSelectedRowIndex=rowIdx;
	}else{
		selectedRowIndices.clear();
		selectedRowIndices.add(rowIdx);
		lastSelectedRowIndex=rowIdx;
	}
	applyRowSelectionStyles();
});

document.getElementById('deleteRowsBtn').addEventListener('click', async ()=>{
	// Notify extension immediately (for click debugging)
	vscode.postMessage({ command:'__deleteRowsButtonClicked' });
	console.log('[pgsql-tools] deleteRows click; selection size:', selectedRowIndices.size, 'newRowIndices size:', newRowIndices.size);
	setRowInfo('Preparing delete... (selected: ' + selectedRowIndices.size + ')');
	if(selectedRowIndices.size===0){
		console.warn('[pgsql-tools] deleteRows: nothing selected');
		return;
	}

	const sorted = Array.from(selectedRowIndices).sort((a,b)=>a-b);
	console.log('[pgsql-tools] deleteRows request, selected indices:', sorted);

	// Split selection into local new rows and persisted rows.
	const newSelected = sorted.filter((idx)=>isNewRow(idx));
	const persistedSelected = sorted.filter((idx)=>!isNewRow(idx));
	console.log('[pgsql-tools] deleteRows split; new:', newSelected, 'persisted:', persistedSelected);
	setRowInfo('Delete: selected=' + sorted.length + ', new=' + newSelected.length + ', persisted=' + persistedSelected.length);

	if(newSelected.length>0){
		// New (not persisted) rows are deleted locally only.
		// Note: local new rows are expected to be appended at the end, so slicing by serverRowsLen is safe.
		console.log('[pgsql-tools] deleteRows: local new rows removed:', newSelected);
		pendingEdits.clear();
		newRowIndices.clear();
		selectedRowIndices.clear();
		lastSelectedRowIndex = null;
		if(typeof serverRowsLen === 'number' && serverRowsLen>=0){
			originalData = originalData.slice(0, serverRowsLen);
		}
		updateChangesUI();
		renderDataRows();
	}

	// If everything was local/new, nothing to send to server.
	if(persistedSelected.length===0){
		return;
	}

	const ok = await confirmModal(
		'Delete '+persistedSelected.length+' selected row(s) from server?\\n\\nThis action cannot be undone.',
		{ title:'Delete rows', okText:'Delete', cancelText:'Cancel' }
	);
	if(!ok){return;}
	const rows = persistedSelected.map((idx)=>{
		const data = originalData[idx] || {};
		return {
			pkCol: PK_COL,
			pkVal: Object.prototype.hasOwnProperty.call(data, PK_COL) ? data[PK_COL] : null,
			rowCtid: data[ROW_CTID_COL] || null
		};
	});
	console.log('[pgsql-tools] deleteRows payload (persisted only):', rows);
	setRowInfo('Sending: deleteRows (' + rows.length + ' persisted row(s))…');
	vscode.postMessage({ command:'deleteRows', rows });
});

function addEmptyLocalRow(){
	// Create an empty (unpersisted) row in the UI and select it.
	const newIdx = originalData.length;
	const row = {};
	for(const col of ALL_COLUMNS){ row[col] = null; }
	row[ROW_CTID_COL] = null;

	originalData.push(row);
	newRowIndices.add(newIdx);

	selectedRowIndices.clear();
	selectedRowIndices.add(newIdx);
	lastSelectedRowIndex = newIdx;

	renderDataRows();

	const tr = document.querySelector('#dataBody tr[data-row="'+newIdx+'"]');
	if(tr){ tr.scrollIntoView({ block:'nearest' }); }
}

document.getElementById('addRowBtn').addEventListener('click', addEmptyLocalRow);

// Search
document.getElementById('dataSearch').addEventListener('input',e=>{
	const q=e.target.value.toLowerCase();
	document.querySelectorAll('#dataBody tr').forEach(r=>{
		r.style.display=q&&!r.innerText.toLowerCase().includes(q)?'none':'';
	});
});

// Pagination
function pageRange(c,t){
	if(t<=7)return Array.from({length:t},(_,i)=>i+1);
	if(c<=4)return[1,2,3,4,5,'…',t];
	if(c>=t-3)return[1,'…',t-4,t-3,t-2,t-1,t];
	return[1,'…',c-1,c,c+1,'…',t];
}
function renderPag(){
	const box=document.getElementById('pageButtons');
	box.innerHTML='';
	pageRange(CUR,TOTAL_PAGES).forEach(p=>{
		if(p==='…'){const s=document.createElement('span');s.textContent='…';s.style.cssText='padding:0 4px;opacity:.4;font-size:11px';box.appendChild(s);}
		else{const b=document.createElement('button');b.className='pbtn'+(p===CUR?' active':'');b.textContent=p;b.onclick=()=>loadPage(p);box.appendChild(b);}
	});
	document.getElementById('pagInfo').textContent='Page '+CUR+' of '+TOTAL_PAGES;
	document.getElementById('prevPage').disabled=CUR===1;
	document.getElementById('nextPage').disabled=CUR>=TOTAL_PAGES&&!HAS_MORE;
}
function loadPage(p){
	CUR=p; renderPag();
	document.getElementById('rowInfo').textContent='Loading…';
	// Clear pending edits when changing page
	pendingEdits.clear();
	selectedRowIndices.clear();
	lastSelectedRowIndex = null;
	newRowIndices.clear();
	applyRowSelectionStyles();
	updateChangesUI();
	PAGE_SIZE=parseInt(document.getElementById('dataLimit').value,10)||1000;
	if(SORT_COL&&FIELDS.includes(SORT_COL)){
		vscode.postMessage({command:'loadSortedPage',page:p,limit:PAGE_SIZE,orderBy:SORT_COL,orderDir:SORT_DIR});
	}else{
		vscode.postMessage({command:'loadPage',page:p,limit:PAGE_SIZE});
	}
}
document.getElementById('dataLimit').addEventListener('change',()=>{PAGE_SIZE=parseInt(document.getElementById('dataLimit').value,10)||1000;loadPage(1);});
document.getElementById('prevPage').onclick=()=>{if(CUR>1)loadPage(CUR-1);};
document.getElementById('nextPage').onclick=()=>{if(CUR<TOTAL_PAGES||HAS_MORE)loadPage(CUR+1);};

// Sort
document.addEventListener('click',e=>{
	const th=e.target.closest('#dataTable th.sortable');
	if(!th){return;}
	const idx=parseInt(th.dataset.col,10);
	const colName=th.dataset.colname||'';
	if(SORT_IDX===idx){SORT_DIR=SORT_DIR==='ASC'?'DESC':'ASC';}
	else{SORT_IDX=idx;SORT_DIR='ASC';}
	SORT_COL=colName;
	document.querySelectorAll('#dataTable th.sortable').forEach(h=>h.classList.remove('sorted-asc','sorted-desc'));
	th.classList.add(SORT_DIR==='ASC'?'sorted-asc':'sorted-desc');
	loadPage(1);
});

// Receive page data from extension
window.addEventListener('message',e=>{
	const msg=e.data;

	if(msg.command==='pageData'){
		const tbody=document.getElementById('dataBody');
		const fields=msg.fields||[];
		if(fields.length>0){FIELDS=fields;}
		originalData=msg.rows||[];
		serverRowsLen = originalData.length;
		newRowIndices.clear();

		if(!originalData.length){
			tbody.innerHTML='<tr><td colspan="100%" style="text-align:center;opacity:.4;padding:20px;font-style:italic">No data</td></tr>';
			document.getElementById('rowInfo').textContent='0 rows';
			document.getElementById('dataPag').style.display='none';
			return;
		}

		selectedRowIndices.clear();
		lastSelectedRowIndex = null;
		renderDataRows();

		HAS_MORE=originalData.length>=PAGE_SIZE;
		TOTAL_PAGES=HAS_MORE?CUR+1:CUR;
		const s=(CUR-1)*PAGE_SIZE+1, en=(CUR-1)*PAGE_SIZE+originalData.length;
		document.getElementById('rowInfo').textContent=s+'–'+en+(HAS_MORE?'+ rows':' rows');
		const pag=document.getElementById('dataPag');
		pag.style.display=(TOTAL_PAGES>1||HAS_MORE)?'flex':'none';
		renderPag();

		if(msg.orderBy){
			SORT_COL=msg.orderBy; SORT_DIR=msg.orderDir||'ASC'; SORT_IDX=FIELDS.indexOf(msg.orderBy);
			document.querySelectorAll('#dataTable th.sortable').forEach(h=>{
				h.classList.remove('sorted-asc','sorted-desc');
				if(parseInt(h.dataset.col)===SORT_IDX){h.classList.add(SORT_DIR==='ASC'?'sorted-asc':'sorted-desc');}
			});
		}
		return;
	}

	if(msg.command==='rowChangesApplied'){
		// Commit edits to originalData and clear pending
		pendingEdits.forEach((colMap,rowIdx)=>{
			if(!originalData[rowIdx]){return;}
			colMap.forEach((val,col)=>{originalData[rowIdx][col]=val;});
		});
		pendingEdits.clear();
		// Remove edited highlights
		document.querySelectorAll('#dataBody td.cell.edited').forEach(c=>c.classList.remove('edited'));
		updateChangesUI();
		document.getElementById('applyChangesBtn').disabled=false;
		setRowInfo('✓ applyRowChanges applied');
	}

	if(msg.command==='rowChangesFailed'){
		document.getElementById('applyChangesBtn').disabled=false;
		console.error('[pgsql-tools] rowChangesFailed:', msg.error);
		setRowInfo('✗ applyRowChanges failed');
	}

	if(msg.command==='rowsDeleted'){
		selectedRowIndices.clear();
		lastSelectedRowIndex = null;
		applyRowSelectionStyles();
		loadPage(CUR);
		setRowInfo('✓ deleteRows applied (' + (msg.deleted ?? 'ok') + ')');
		return;
	}

	if(msg.command==='deleteRowsFailed'){
		console.error('[pgsql-tools] deleteRowsFailed:', msg.error);
		setRowInfo('✗ deleteRows failed (see console / Query Results)');
		return;
	}

	if(msg.command==='tableRowEditsApplied'){
		pendingEdits.clear();
		newRowIndices.clear();
		selectedRowIndices.clear();
		lastSelectedRowIndex = null;
		document.getElementById('applyChangesBtn').disabled=false;
		loadPage(CUR);
		setRowInfo('✓ applyTableRowEdits applied');
		return;
	}

	if(msg.command==='tableRowEditsFailed'){
		document.getElementById('applyChangesBtn').disabled=false;
		console.error('[pgsql-tools] tableRowEditsFailed:', msg.error);
		setRowInfo('✗ applyTableRowEdits failed (see console / Query Results)');
		return;
	}

	if(msg.command==='deleteColumnApplied'){
		pendingDeleteColumn=null;
		return;
	}

	if(msg.command==='deleteColumnFailed'){
		const deleteBtn=document.getElementById('deleteColBtn');
		const editBtn=document.getElementById('editColBtn');
		if(deleteBtn){ deleteBtn.disabled = !selCol; }
		if(editBtn){ editBtn.disabled = !selCol; }
		const errText = msg.error || ('Failed to delete column "'+(pendingDeleteColumn||'')+'"');
		pendingDeleteColumn=null;
		alert(errText);
	}
});

function escH(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
</script></body></html>`;
	}
}