import * as vscode from 'vscode';
import * as fs from 'fs';
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

interface TableRenderModel {
	columnCount: number;
	keysCount: number;
	checksCount: number;
	indexesCount: number;
	columnsTabHtml: string;
	keyConstraintsHtml: string;
	outgoingFkHtml: string;
	incomingFkHtml: string;
	checksHtml: string;
	dataHeaderHtml: string;
	indexesHtml: string;
	ddl: string;
	pkCol: string;
	allColumns: string[];
	fieldNames: string[];
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
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources', 'objectDetails')],
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

				case 'refreshPanel':
					await this._refreshPanelInPlace(panel, panelKey, schema, objectName, objectType, queryExecutor);
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

		panel.webview.html = this._loadingHtml(context, panel.webview, title, objectType);

		try {
			await this._loadAndRender(context, panel, panelKey, schema, objectName, objectType, queryExecutor);
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
		context: vscode.ExtensionContext,
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
			panel.webview.html = this._tableHtml(context, panel.webview, schema, objectName, ddl, indexes, foreignKeys, constraints, columnDetails);

		} else if (objectType === 'view') {
			const [ddl, columnDetails] = await Promise.all([
				queryExecutor.getViewDDL(schema, objectName),
				this._fetchColumnDetails(queryExecutor, schema, objectName),
			]);
			if (!this.panels.has(panelKey)) { return; }
			panel.webview.html = this._tableHtml(context, panel.webview, schema, objectName, ddl, [], [], [], columnDetails);
		}
	}

	private static async _refreshPanelInPlace(
		panel: vscode.WebviewPanel,
		panelKey: string,
		schema: string,
		objectName: string,
		objectType: string,
		queryExecutor: QueryExecutor
	) {
		if (!this.panels.has(panelKey)) { return; }
		try {
			if (objectType === 'table') {
				const [ddl, indexes, foreignKeys, constraints, columnDetails] = await Promise.all([
					queryExecutor.getTableDDL(schema, objectName),
					queryExecutor.getIndexes(schema, objectName),
					queryExecutor.getForeignKeys(schema, objectName),
					queryExecutor.getConstraints(schema, objectName),
					this._fetchColumnDetails(queryExecutor, schema, objectName),
				]);
				if (!this.panels.has(panelKey)) { return; }
				const snapshot = this._buildTableRenderModel(schema, ddl, indexes, foreignKeys, constraints, columnDetails);
				panel.webview.postMessage({ command: 'panelSnapshot', snapshot });
				return;
			}
			if (objectType === 'view') {
				const [ddl, columnDetails] = await Promise.all([
					queryExecutor.getViewDDL(schema, objectName),
					this._fetchColumnDetails(queryExecutor, schema, objectName),
				]);
				if (!this.panels.has(panelKey)) { return; }
				const snapshot = this._buildTableRenderModel(schema, ddl, [], [], [], columnDetails);
				panel.webview.postMessage({ command: 'panelSnapshot', snapshot });
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to refresh object details: ${err}`);
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

	private static _loadingHtml(
		context: vscode.ExtensionContext,
		webview: vscode.Webview,
		title: string,
		_objectType: string
	): string {
		const template = this._readWebviewAsset(context, 'loading.html');
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'objectDetails', 'loading.css')).toString();
		return template
			.replace(/__CSP_SOURCE__/g, webview.cspSource)
			.replace('__LOADING_CSS_URI__', cssUri)
			.replace('__TITLE__', esc(title));
	}

	private static _nonce(): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let value = '';
		for (let i = 0; i < 32; i++) {
			value += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return value;
	}

	private static _readWebviewAsset(context: vscode.ExtensionContext, fileName: string): string {
		const uri = vscode.Uri.joinPath(context.extensionUri, 'resources', 'objectDetails', fileName);
		return fs.readFileSync(uri.fsPath, 'utf8');
	}

	private static _buildTableRenderModel(
		schema: string,
		ddl: string,
		indexes: IndexInfo[],
		foreignKeys: ForeignKeyInfo[],
		constraints: ConstraintInfo[],
		columnDetails: ColumnDetail[]
	): TableRenderModel {
		const fieldNames = columnDetails.map(c => c.col);
		const pkCol = columnDetails.find(c => c.is_pk)?.col ?? fieldNames[0] ?? '';

		const columnsTabHtml = columnDetails.map((col) => {
			const badges: string[] = [];
			if (col.is_pk) { badges.push(`<span class="badge badge--pk">PK</span>`); }
			if (col.is_unique && !col.is_pk) { badges.push(`<span class="badge badge--uq">UQ</span>`); }
			if (col.fk_table) { badges.push(`<span class="badge badge--fk">FK</span>`); }
			if (col.notnull && !col.is_pk) { badges.push(`<span class="badge badge--nn">NN</span>`); }

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

		const indexesHtml = indexes.length
			? indexes.map(idx => `<tr>
				<td class="mono">${esc(idx.name)}</td>
				<td>${esc(idx.columns.join(', '))}</td>
				<td>${esc(idx.type)}</td>
				<td class="center">${idx.unique ? '<span class="badge badge--yes">✓</span>' : '—'}</td>
				<td class="center">${idx.primary ? '<span class="badge badge--pk">PK</span>' : '—'}</td>
			</tr>`).join('')
			: '<tr><td colspan="5" class="empty">No indexes</td></tr>';

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

		const dataHeaderHtml = fieldNames.map((f, i) =>
			`<th class="sortable" data-col="${i}" data-colname="${esc(f)}">${esc(f)} <span class="sort-icon"></span></th>`
		).join('');

		return {
			columnCount: columnDetails.length,
			keysCount: keyConstraints.length + foreignKeys.length,
			checksCount: checkConstraints.length,
			indexesCount: indexes.length,
			columnsTabHtml,
			keyConstraintsHtml,
			outgoingFkHtml: fkRows(outgoing, 'outgoing'),
			incomingFkHtml: fkRows(incoming, 'incoming'),
			checksHtml,
			dataHeaderHtml,
			indexesHtml,
			ddl,
			pkCol,
			allColumns: fieldNames,
			fieldNames,
		};
	}

	private static _tableHtml(
		context: vscode.ExtensionContext,
		webview: vscode.Webview,
		schema: string,
		tableName: string,
		ddl: string,
		indexes: IndexInfo[],
		foreignKeys: ForeignKeyInfo[],
		constraints: ConstraintInfo[],
		columnDetails: ColumnDetail[]
	): string {
		const model = this._buildTableRenderModel(schema, ddl, indexes, foreignKeys, constraints, columnDetails);

		const nonce = this._nonce();
		const template = this._readWebviewAsset(context, 'table.html');
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'objectDetails', 'table.css')).toString();
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'resources', 'objectDetails', 'table.js')).toString();

		return template
			.replace(/__NONCE__/g, nonce)
			.replace(/__CSP_SOURCE__/g, webview.cspSource)
			.replace('__TABLE_CSS_URI__', cssUri)
			.replace('__TABLE_JS_URI__', jsUri)
			.replace('__COLUMN_COUNT__', String(model.columnCount))
			.replace('__KEYS_COUNT__', String(model.keysCount))
			.replace('__CHECKS_COUNT__', String(model.checksCount))
			.replace('__INDEXES_COUNT__', String(model.indexesCount))
			.replace('__COLUMNS_TAB_HTML__', model.columnsTabHtml)
			.replace('__KEY_CONSTRAINTS_HTML__', model.keyConstraintsHtml)
			.replace('__OUTGOING_FK_HTML__', model.outgoingFkHtml)
			.replace('__INCOMING_FK_HTML__', model.incomingFkHtml)
			.replace('__CHECKS_HTML__', model.checksHtml)
			.replace('__DATA_HEADER_HTML__', model.dataHeaderHtml)
			.replace('__INDEXES_HTML__', model.indexesHtml)
			.replace('__DDL_JSON__', JSON.stringify(model.ddl))
			.replace('__PK_COL_JSON__', JSON.stringify(model.pkCol))
			.replace('__ALL_COLUMNS_JSON__', JSON.stringify(model.allColumns));
	}
}