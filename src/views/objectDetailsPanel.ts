import * as vscode from 'vscode';
import { QueryExecutor, QueryResult, IndexInfo, ForeignKeyInfo, ConstraintInfo } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ResultsViewProvider } from './resultsPanel';

function esc(text: string): string {
	const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
	return text.replace(/[&<>"']/g, (m) => map[m]);
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

export class ObjectDetailsPanel {
	private static currentPanel: vscode.WebviewPanel | undefined;
	private static currentSchema: string = '';
	private static currentTable: string = '';

	static async show(
		context: vscode.ExtensionContext,
		schema: string,
		objectName: string,
		objectType: string,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider?: ResultsViewProvider
	) {
		if (this.currentPanel) {
			this.currentPanel.reveal(vscode.ViewColumn.One);
		} else {
			this.currentPanel = vscode.window.createWebviewPanel(
				'pgsqlObjectDetails',
				objectName,
				vscode.ViewColumn.One,
				{ enableScripts: true }
			);
			this.currentPanel.onDidDispose(() => { this.currentPanel = undefined; });
		}

		this.currentSchema = schema;
		this.currentTable = objectName;
		this.currentPanel.title = objectName;

		// Сообщения из вебвью
		this.currentPanel.webview.onDidReceiveMessage(async (message) => {
			if (message.command === 'openInResults' && resultsViewProvider) {
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
							schema,
							tableName: objectName,
						},
						queryExecutor,
						connectionManager
					);
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to open in results: ${err}`);
				}
			} else if (message.command === 'openTable') {
				await ObjectDetailsPanel.show(
					context, message.schema, message.table, 'table',
					queryExecutor, connectionManager, resultsViewProvider
				);
			} else if (message.command === 'loadPage' || message.command === 'loadSortedPage') {
				try {
					const pageSize = message.limit || 1000;
					const offset = (message.page - 1) * pageSize;
				const orderBy = message.orderBy ? ` ORDER BY "${message.orderBy}" ${message.orderDir || 'ASC'}` : '';
					const result = await queryExecutor.executeQuery(
						`SELECT * FROM "${schema}"."${objectName}"${orderBy} LIMIT ${pageSize} OFFSET ${offset}`
					);
					this.currentPanel?.webview.postMessage({
						command: 'pageData',
						rows: result.rows,
						fields: result.fields?.map((f: any) => f.name) || [],
						page: message.page,
						orderBy: message.orderBy || null,
						orderDir: message.orderDir || null,
					});
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to load page: ${err}`);
				}
			} else if (message.command === 'createColumn') {
				try {
					const colName = message.columnName;
					const colType = message.columnType;
					const notNull = message.notNull;
					const defaultValue = message.defaultValue || null;
					const comment = message.comment || null;

					let sql = `ALTER TABLE "${schema}"."${objectName}" ADD COLUMN "${colName}" ${colType}`;
					if (notNull) {
						sql += ' NOT NULL';
					}
					if (defaultValue) {
						sql += ` DEFAULT ${defaultValue}`;
					}
					await queryExecutor.executeQuery(sql);

					if (comment) {
						await queryExecutor.executeQuery(
							`COMMENT ON COLUMN "${schema}"."${objectName}"."${colName}" IS '${comment.replace(/'/g, "''")}'`
						);
					}

					vscode.window.showInformationMessage(`Column "${colName}" created successfully`);
					// Refresh the panel
					await ObjectDetailsPanel.show(
						context, schema, objectName, 'table',
						queryExecutor, connectionManager, resultsViewProvider
					);
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to create column: ${err}`);
				}
			} else if (message.command === 'deleteColumn') {
				try {
					const colName = message.columnName;
					const sql = `ALTER TABLE "${schema}"."${objectName}" DROP COLUMN "${colName}"`;
					await queryExecutor.executeQuery(sql);

					vscode.window.showInformationMessage(`Column "${colName}" deleted successfully`);
					// Refresh the panel
					await ObjectDetailsPanel.show(
						context, schema, objectName, 'table',
						queryExecutor, connectionManager, resultsViewProvider
					);
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to delete column: ${err}`);
				}
			} else if (message.command === 'renameColumn') {
				try {
					const oldColName = message.oldColumnName;
					const newColName = message.newColumnName;
					const sql = `ALTER TABLE "${schema}"."${objectName}" RENAME COLUMN "${oldColName}" TO "${newColName}"`;
					await queryExecutor.executeQuery(sql);

					vscode.window.showInformationMessage(`Column "${oldColName}" renamed to "${newColName}" successfully`);
					// Refresh the panel
					await ObjectDetailsPanel.show(
						context, schema, objectName, 'table',
						queryExecutor, connectionManager, resultsViewProvider
					);
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to rename column: ${err}`);
				}
			}
		});

		try {
			if (objectType === 'table') {
				// Параллельная загрузка: DDL, индексы, FK, ограничения, колонки (без данных)
				// Данные загружаются лениво при переходе на вкладку Data
				const [ddl, indexes, foreignKeys, constraints, columnDetails] =
					await Promise.all([
						queryExecutor.getTableDDL(schema, objectName),
						queryExecutor.getIndexes(schema, objectName),
						queryExecutor.getForeignKeys(schema, objectName),
						queryExecutor.getConstraints(schema, objectName),
						this.fetchColumnDetails(queryExecutor, schema, objectName),
					]);

				this.currentPanel.webview.html = this.getHtml(
					schema, objectName, ddl, null,
					indexes, foreignKeys, constraints, columnDetails
				);
			} else if (objectType === 'function') {
				const ddl = await queryExecutor.getFunctionDDL(schema, objectName);
				this.currentPanel.webview.html = this.getFunctionHtml(schema, objectName, ddl);
			} else if (objectType === 'procedure') {
				const ddl = await queryExecutor.getProcedureDDL(schema, objectName);
				this.currentPanel.webview.html = this.getFunctionHtml(schema, objectName, ddl);
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to load object details: ${err}`);
		}
	}

	// ── Загрузка расширенной информации о колонках ────────────────────────────

	private static async fetchColumnDetails(
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

				-- PK?
				EXISTS (
					SELECT 1 FROM pg_constraint pk
					WHERE pk.conrelid = c.oid
					  AND pk.contype = 'p'
					  AND a.attnum = ANY(pk.conkey)
				) AS is_pk,

				-- UNIQUE (не PK)?
				EXISTS (
					SELECT 1 FROM pg_constraint uq
					WHERE uq.conrelid = c.oid
					  AND uq.contype = 'u'
					  AND a.attnum = ANY(uq.conkey)
				) AS is_unique,

				-- FK target table
				(
					SELECT cc.relname
					FROM pg_constraint fk
					JOIN pg_class cc ON cc.oid = fk.confrelid
					WHERE fk.conrelid = c.oid
					  AND fk.contype = 'f'
					  AND a.attnum = ANY(fk.conkey)
					LIMIT 1
				) AS fk_table,

				-- FK target column
				(
					SELECT ta.attname
					FROM pg_constraint fk
					JOIN pg_attribute ta ON ta.attrelid = fk.confrelid
					  AND ta.attnum = fk.confkey[
					      array_position(fk.conkey, a.attnum)
					  ]
					WHERE fk.conrelid = c.oid
					  AND fk.contype = 'f'
					  AND a.attnum = ANY(fk.conkey)
					LIMIT 1
				) AS fk_col

			FROM   pg_catalog.pg_attribute  a
			JOIN   pg_catalog.pg_class      c  ON c.oid = a.attrelid
			JOIN   pg_catalog.pg_namespace  n  ON n.oid = c.relnamespace
			LEFT   JOIN pg_catalog.pg_attrdef ad
				   ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
			WHERE  n.nspname = '${e(schema)}'
			  AND  c.relname = '${e(tableName)}'
			  AND  a.attnum > 0
			  AND  NOT a.attisdropped
			ORDER  BY a.attnum
		`);

		return res.rows as ColumnDetail[];
	}

	// ── Форматирование типов данных ──────────────────────────────────────────

	private static formatColumnType(colType: string): { display: string; class: string } {
		// Приводим к верхнему регистру
		let type = colType.toUpperCase();

		// Заменяем "character varying" на "VARCHAR"
		type = type.replace(/CHARACTER VARYING/g, 'VARCHAR');

		// Заменяем "timestamp without time zone" на "TIMESTAMP"
		type = type.replace(/TIMESTAMP WITHOUT TIME ZONE/g, 'TIMESTAMP');

		// Заменяем "timestamp with time zone" на "TIMESTAMPTZ"
		type = type.replace(/TIMESTAMP WITH TIME ZONE/g, 'TIMESTAMPTZ');

		// Заменяем "time without time zone" на "TIME"
		type = type.replace(/TIME WITHOUT TIME ZONE/g, 'TIME');

		// Заменяем "time with time zone" на "TIMETZ"
		type = type.replace(/TIME WITH TIME ZONE/g, 'TIMETZ');

		// Заменяем "integer" на "INT"
		type = type.replace(/INTEGER/g, 'INT');

		// Заменяем "boolean" на "BOOL"
		type = type.replace(/BOOLEAN/g, 'BOOL');

		// Определяем категорию для раскраски
		let cssClass = 'type-other';

		// Числовые типы
		if (/^(INT|SMALLINT|BIGINT|DECIMAL|NUMERIC|REAL|DOUBLE PRECISION|FLOAT|FLOAT4|FLOAT8|INT8|INT4|INT2|SERIAL|BIGSERIAL|MONEY)/.test(type)) {
			cssClass = 'type-number';
		}
		// Строковые типы
		else if (/^(VARCHAR|CHAR|TEXT|CHAR\(|\(BPCHAR|NCHAR|NVARCHAR|CLOB)/.test(type)) {
			cssClass = 'type-string';
		}
		// Дата/время
		else if (/^(DATE|TIME|TIMESTAMP|TIMESTAMPTZ|TIMETZ)/.test(type)) {
			cssClass = 'type-datetime';
		}
		// UUID
		else if (/^UUID/.test(type)) {
			cssClass = 'type-uuid';
		}
		// JSON/JSONB
		else if (/^JSON/.test(type)) {
			cssClass = 'type-json';
		}
		// Бинарные
		else if (/^(BYTEA|BLOB|BINARY|VARBINARY)/.test(type)) {
			cssClass = 'type-binary';
		}
		// Булевы
		else if (/^BOOL/.test(type)) {
			cssClass = 'type-boolean';
		}

		return { display: type, class: cssClass };
	}

	// ── HTML ──────────────────────────────────────────────────────────────────

	private static getHtml(
		schema: string,
		tableName: string,
		ddl: string,
		data: QueryResult | null,
		indexes: IndexInfo[],
		foreignKeys: ForeignKeyInfo[],
		constraints: ConstraintInfo[],
		columnDetails: ColumnDetail[]
	): string {
		// Use columnDetails for field names (works even when data is null)
		const fieldNames = columnDetails.map(c => c.col);

		// ── Вкладка Columns ──────────────────────────────────────────────────
		const columnsTabHtml = columnDetails.map((col) => {
			const badges: string[] = [];
			if (col.is_pk) badges.push(`<span class="badge badge--pk">PK</span>`);
			if (col.is_unique && !col.is_pk) badges.push(`<span class="badge badge--uq">UQ</span>`);
			if (col.fk_table) badges.push(`<span class="badge badge--fk">FK</span>`);
			if (col.notnull && !col.is_pk) badges.push(`<span class="badge badge--nn">NOT NULL</span>`);

			const fkRef = col.fk_table
				? `<a class="fk-link" data-schema="${esc(schema)}" data-table="${esc(col.fk_table)}">
					→ ${esc(col.fk_table)}${col.fk_col ? '.' + esc(col.fk_col) : ''}
				   </a>`
				: '—';

			// Форматируем тип данных
			const formattedType = this.formatColumnType(col.col_type);

			return `<tr data-col-name="${esc(col.col)}">
				<td class="monospace col-name-cell">${esc(col.col)}</td>
				<td class="monospace"><span class="type-badge ${formattedType.class}">${formattedType.display}</span></td>
				<td>${badges.join(' ')}</td>
				<td class="monospace small">${col.col_default ? esc(col.col_default) : '<span style="opacity:0.4">—</span>'}</td>
				<td class="monospace small">${fkRef}</td>
				<td class="comment-cell">${col.col_comment ? esc(col.col_comment) : '<span style="opacity:0.35">—</span>'}</td>
				<td class="actions-cell">
					<button type="button" class="btn-delete-col" data-col="${esc(col.col)}" title="Delete column">✕</button>
				</td>
			</tr>`;
		}).join('');

		// ── Вкладка Indexes ───────────────────────────────────────────────────
		const indexesHtml = indexes.length > 0
			? indexes.map((idx) => `
				<tr>
					<td class="monospace">${esc(idx.name)}</td>
					<td>${esc(idx.columns.join(', '))}</td>
					<td>${esc(idx.type)}</td>
					<td class="center">${idx.unique ? '<span class="badge badge--yes">✓</span>' : '—'}</td>
					<td class="center">${idx.primary ? '<span class="badge badge--pk">PK</span>' : '—'}</td>
				</tr>`).join('')
			: '<tr><td colspan="5" class="empty-cell">No indexes</td></tr>';

		// ── Вкладка FK ────────────────────────────────────────────────────────
		const outgoing = foreignKeys.filter((fk) => fk.direction === 'outgoing');
		const incoming = foreignKeys.filter((fk) => fk.direction === 'incoming');

		const fkHtml = (fks: ForeignKeyInfo[], dir: string) =>
			fks.length > 0
				? fks.map((fk) => `
					<tr>
						<td class="monospace">${esc(fk.constraintName)}</td>
						<td>${esc(fk.columns.join(', '))}</td>
						<td><a class="fk-link" data-schema="${esc(fk.foreignSchema)}" data-table="${esc(fk.foreignTable)}">
							${esc(fk.foreignSchema)}.${esc(fk.foreignTable)}
						</a></td>
						<td>${esc(fk.foreignColumns.join(', '))}</td>
					</tr>`).join('')
				: `<tr><td colspan="4" class="empty-cell">No ${dir} foreign keys</td></tr>`;

		// ── Вкладка Constraints ───────────────────────────────────────────────
		const constraintsHtml = constraints.length > 0
			? constraints.map((c) => `
				<tr>
					<td class="monospace">${esc(c.name)}</td>
					<td><span class="badge badge--${c.type === 'PRIMARY KEY' ? 'pk' : c.type === 'UNIQUE' ? 'uq' : 'ck'}">${esc(c.type)}</span></td>
					<td>${esc(c.columns.join(', '))}</td>
					<td class="monospace small">${c.definition ? esc(c.definition) : '—'}</td>
				</tr>`).join('')
			: '<tr><td colspan="4" class="empty-cell">No constraints</td></tr>';

		// ── Вкладка Data (ленивая загрузка) ─────────────────────────────────
		// Данные загружаются при переходе на вкладку Data
		const hasData = data !== null;
		const dataRowsHtml = hasData
			? data!.rows.map((row: any) => `
				<tr>${fieldNames.map((f) => {
					const v = row[f];
					return v === null
						? '<td><span class="null-val">NULL</span></td>'
						: `<td title="${esc(String(v))}">${esc(String(v))}</td>`;
				}).join('')}</tr>`).join('')
			: '';

		// Headers for Data tab - make them sortable (use index for sorting)
		const headerHtml = fieldNames.map((f, i) => `<th class="sortable" data-col="${i}">${esc(f)} <span class="sort-icon"></span></th>`).join('');

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
<style>
	*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
	html, body {
		width: 100%; height: 100%;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size, 13px);
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		display: flex; flex-direction: column; overflow: hidden;
	}

	.header {
		display: flex; align-items: center; justify-content: space-between;
		padding: 6px 12px;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		border-bottom: 1px solid var(--vscode-panel-border);
		flex-shrink: 0; gap: 8px;
	}
	.header-left { display: flex; align-items: center; gap: 8px; }
	.header-title { font-size: 13px; font-weight: 600; }
	.header-meta {
		font-size: 11px; opacity: 0.55;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		padding: 1px 7px; border-radius: 10px;
	}
	.btn-open {
		display: flex; align-items: center; gap: 4px;
		padding: 3px 10px;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none; border-radius: 2px;
		font-family: var(--vscode-font-family); font-size: 11px; font-weight: 500;
		cursor: pointer; height: 22px; white-space: nowrap;
	}
	.btn-open:hover { background: var(--vscode-button-hoverBackground); }

	.tabs {
		display: flex;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		border-bottom: 1px solid var(--vscode-panel-border);
		flex-shrink: 0; padding: 0 4px;
	}
	.tab {
		padding: 6px 14px; font-size: 12px; font-weight: 500;
		cursor: pointer; border-bottom: 2px solid transparent;
		color: var(--vscode-foreground); opacity: 0.65;
		user-select: none; transition: opacity 0.12s; white-space: nowrap;
	}
	.tab:hover { opacity: 0.9; }
	.tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-textLink-foreground); }
	.tab-count {
		display: inline-block; margin-left: 5px; padding: 0 5px;
		background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
		border-radius: 8px; font-size: 10px; font-weight: 600; vertical-align: middle;
	}

	.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
	.tab-pane { display: none; flex: 1; overflow: hidden; flex-direction: column; }
	.tab-pane.active { display: flex; }
	#ddlEditor { flex: 1; }

	/* ── search toolbar ── */
	.data-toolbar {
		display: flex; align-items: center; gap: 6px; padding: 4px 8px;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		border-bottom: 1px solid var(--vscode-panel-border);
		flex-shrink: 0; height: 32px;
	}
	.search-wrap { position: relative; flex: 1; max-width: 240px; }
	.search-icon {
		position: absolute; left: 6px; top: 50%; transform: translateY(-50%);
		opacity: 0.45; font-size: 11px; pointer-events: none;
	}
	.search-input {
		width: 100%; padding: 3px 8px 3px 22px;
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		color: var(--vscode-input-foreground);
		font-family: var(--vscode-font-family); font-size: 12px;
		border-radius: 2px; outline: none; height: 22px;
	}
	.search-input:focus { border-color: var(--vscode-focusBorder); }
	.search-input::placeholder { color: var(--vscode-input-placeholderForeground); }
	.row-count-info { font-size: 11px; opacity: 0.5; margin-left: auto; }
	.limit-wrap { display: flex; align-items: center; margin-left: 8px; font-size: 11px; }
	.limit-wrap input { text-align: right; }

	/* ── table shared ── */
	.table-scroll { flex: 1; overflow: auto; }
	table { width: 100%; border-collapse: collapse; font-size: 12px; }
	thead { position: sticky; top: 0; z-index: 5; }
	th {
		padding: 4px 10px; text-align: left;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		color: var(--vscode-foreground); font-weight: 600; font-size: 11px;
		border-bottom: 2px solid var(--vscode-panel-border);
		border-right: 1px solid var(--vscode-panel-border);
		white-space: nowrap;
	}
	th.sortable { cursor: pointer; user-select: none; }
	th.sortable:hover { background: var(--vscode-list-hoverBackground); }
	th.sorted-asc .sort-icon::after { content: ' ▲'; font-size: 8px; }
	th.sorted-desc .sort-icon::after { content: ' ▼'; font-size: 8px; }
	td {
		padding: 4px 10px; height: 26px;
		border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.08));
		border-right: 1px solid var(--vscode-panel-border);
		max-width: 350px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
		vertical-align: middle;
	}
	tr:hover td { background: var(--vscode-list-hoverBackground); }
	.center { text-align: center; }
	.monospace { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
	.small { font-size: 10px; }
	.null-val { color: var(--vscode-debugTokenExpression-null, #808080); font-style: italic; }
	.empty-cell { text-align: center; opacity: 0.45; padding: 16px !important; font-style: italic; }

	/* ── columns tab specific ── */
	.col-name-cell { font-weight: 600; }
	.comment-cell { font-size: 11px; color: var(--vscode-descriptionForeground); max-width: 250px; white-space: normal; }

	/* ── badges ── */
	.badge {
		display: inline-block; padding: 1px 5px; border-radius: 3px;
		font-size: 9px; font-weight: 700; white-space: nowrap;
	}
	.badge--pk  { background: rgba(86,156,214,0.2); color: #569cd6; }
	.badge--uq  { background: rgba(220,220,170,0.2); color: #dcdcaa; }
	.badge--fk  { background: rgba(210,162,42,0.2); color: #d2a22a; }
	.badge--nn  { background: rgba(206,145,120,0.15); color: #ce9178; }
	.badge--ck  { background: rgba(206,145,120,0.2); color: #ce9178; }
	.badge--yes { background: rgba(78,201,176,0.2); color: #4ec9b0; }

	.fk-link {
		color: var(--vscode-textLink-foreground);
		cursor: pointer; text-decoration: none;
		font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
	}
	.fk-link:hover { text-decoration: underline; }

	.section-header {
		padding: 6px 10px; font-size: 11px; font-weight: 600; opacity: 0.7;
		background: var(--vscode-sideBar-background, var(--vscode-editorGroupHeader-tabsBackground));
		border-bottom: 1px solid var(--vscode-panel-border);
		text-transform: uppercase; letter-spacing: 0.05em;
	}

	/* pagination */
	.pagination {
		display: flex; align-items: center; gap: 5px; padding: 4px 10px;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		border-top: 1px solid var(--vscode-panel-border);
		flex-shrink: 0; font-size: 11px; height: 30px;
	}
	.page-btn {
		background: none; border: 1px solid var(--vscode-panel-border);
		color: var(--vscode-foreground); cursor: pointer;
		font-size: 11px; padding: 1px 7px; border-radius: 2px; line-height: 1.5;
	}
	.page-btn:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
	.page-btn:disabled { opacity: 0.3; cursor: default; }
	.page-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	.page-info { opacity: 0.55; margin-left: auto; }

	/* ── Add Column button ── */
	.btn-add-col {
		display: inline-flex; align-items: center; justify-content: center;
		width: 24px; height: 22px;
		padding: 0;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none; border-radius: 2px;
		font-family: var(--vscode-font-family); font-size: 14px; font-weight: 500;
		cursor: pointer; white-space: nowrap;
	}
	.btn-add-col:hover { background: var(--vscode-button-hoverBackground); }

	/* ── Column action buttons (delete, edit) ── */
	.btn-col-action {
		display: inline-flex; align-items: center; justify-content: center;
		width: 24px; height: 22px;
		padding: 0;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none; border-radius: 2px;
		font-family: var(--vscode-font-family); font-size: 12px; font-weight: 500;
		cursor: pointer; white-space: nowrap; margin-left: 4px;
	}
	.btn-col-action:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
	.btn-col-action:disabled { opacity: 0.4; cursor: default; }
	#deleteColBtn:hover:not(:disabled) { color: var(--vscode-errorForeground, #f14c4c); }
	#editColBtn:hover:not(:disabled) { color: var(--vscode-textLink-foreground, #3794ff); }

	/* ── Column row selection ── */
	#colBody tr { cursor: pointer; }
	#colBody tr.selected { background: var(--vscode-list-activeSelectionBackground); }
	#colBody tr:hover:not(.selected) { background: var(--vscode-list-hoverBackground); }

	/* ── Delete column button ── */
	.btn-delete-col {
		background: none; border: none; color: var(--vscode-errorForeground, #f14c4c);
		cursor: pointer; padding: 2px 6px; font-size: 12px; opacity: 0.5;
		border-radius: 3px;
	}
	.btn-delete-col:hover { opacity: 1; background: rgba(241, 76, 76, 0.15); }
	.actions-cell { text-align: center; width: 40px; }

	/* ── Type badges with colors ── */
	.type-badge {
		display: inline-block; padding: 1px 5px; border-radius: 3px;
		font-size: 10px; font-weight: 600; font-family: var(--vscode-editor-font-family, monospace);
	}
	.type-string   { background: rgba(86, 156, 214, 0.15); color: #569cd6; }
	.type-number   { background: rgba(181, 206, 168, 0.15); color: #b5cea8; }
	.type-datetime { background: rgba(206, 145, 120, 0.15); color: #ce9178; }
	.type-boolean  { background: rgba(220, 220, 170, 0.15); color: #dcdcaa; }
	.type-uuid     { background: rgba(197, 134, 192, 0.15); color: #c586c0; }
	.type-json     { background: rgba(78, 201, 176, 0.15); color: #4ec9b0; }
	.type-binary   { background: rgba(156, 220, 254, 0.15); color: #9cdcfe; }
	.type-other    { background: rgba(128, 128, 128, 0.15); color: #808080; }

	/* ── Modal ── */
	.modal-overlay {
		position: fixed; top: 0; left: 0; right: 0; bottom: 0;
		background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center;
		z-index: 1000;
	}
	.modal-content {
		background: var(--vscode-editor-background);
		border: 1px solid var(--vscode-panel-border);
		border-radius: 4px; min-width: 360px; max-width: 90%;
		box-shadow: 0 4px 16px rgba(0,0,0,0.3);
	}
	.modal-header {
		display: flex; align-items: center; justify-content: space-between;
		padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border);
	}
	.modal-title { font-weight: 600; font-size: 13px; }
	.modal-close {
		background: none; border: none; color: var(--vscode-foreground);
		cursor: pointer; font-size: 18px; padding: 0 4px; opacity: 0.6;
	}
	.modal-close:hover { opacity: 1; }
	.modal-body { padding: 14px; }
	.modal-footer {
		display: flex; justify-content: flex-end; gap: 8px;
		padding: 10px 14px; border-top: 1px solid var(--vscode-panel-border);
	}
	.form-group { margin-bottom: 12px; }
	.form-group:last-child { margin-bottom: 0; }
	.form-group label {
		display: block; font-size: 11px; font-weight: 600; margin-bottom: 4px;
		color: var(--vscode-foreground);
	}
	.form-input, .form-select {
		width: 100%; padding: 5px 8px;
		background: var(--vscode-input-background);
		border: 1px solid var(--vscode-input-border, transparent);
		color: var(--vscode-input-foreground);
		font-family: var(--vscode-font-family); font-size: 12px;
		border-radius: 2px;
	}
	.form-input:focus, .form-select:focus {
		border-color: var(--vscode-focusBorder); outline: none;
	}
	.btn-cancel {
		padding: 5px 12px; background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-secondaryBorder);
		border-radius: 2px; cursor: pointer; font-size: 12px;
	}
	.btn-cancel:hover { background: var(--vscode-button-hoverBackground); }
	.btn-confirm {
		padding: 5px 12px; background: var(--vscode-button-background);
		color: var(--vscode-button-foreground); border: none;
		border-radius: 2px; cursor: pointer; font-size: 12px;
	}
	.btn-confirm:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>

<div class="header">
	<div class="header-left">
		<span class="header-title">${esc(tableName)}</span>
		<span class="header-meta">schema: ${esc(schema)}</span>
		<span class="header-meta">${columnDetails.length} columns</span>
	</div>
	<button class="btn-open" id="openInResultsBtn">↗ Open in Query Results</button>
</div>

<div class="tabs">
	<div class="tab active" data-tab="columns">Columns <span class="tab-count">${columnDetails.length}</span></div>
	<div class="tab" data-tab="ddl">DDL</div>
	<div class="tab" data-tab="data">Data</div>
	<div class="tab" data-tab="indexes">Indexes <span class="tab-count">${indexes.length}</span></div>
	<div class="tab" data-tab="fk">Foreign Keys <span class="tab-count">${foreignKeys.length}</span></div>
	<div class="tab" data-tab="constraints">Constraints <span class="tab-count">${constraints.length}</span></div>
</div>

<div class="content">

	<!-- ── COLUMNS (первая вкладка) ── -->
	<div class="tab-pane active" id="columns-pane">
		<div class="data-toolbar">
			<button type="button" class="btn-add-col" id="addColBtn" title="Add column">+</button>
			<button type="button" class="btn-col-action" id="deleteColBtn" title="Delete selected column" disabled>−</button>
			<button type="button" class="btn-col-action" id="editColBtn" title="Edit selected column" disabled>✎</button>
			<div class="search-wrap">
				<span class="search-icon">⌕</span>
				<input class="search-input" id="colSearch" placeholder="Filter columns…" autocomplete="off">
			</div>
		</div>
		<div class="table-scroll">
			<table id="colTable">
				<thead>
					<tr>
						<th>Column</th>
						<th>Type</th>
						<th>Constraints</th>
						<th>Default</th>
						<th>References</th>
						<th>Comment</th>
						<th style="width:40px"></th>
					</tr>
				</thead>
				<tbody id="colBody">${columnsTabHtml}</tbody>
			</table>
		</div>
	</div>

	<!-- ── DDL ── -->
	<div class="tab-pane" id="ddl-pane">
		<div id="ddlEditor"></div>
	</div>

	<!-- ── DATA (ленивая загрузка) ── -->
	<div class="tab-pane" id="data-pane">
		<div class="data-toolbar">
			<div class="search-wrap">
				<span class="search-icon">⌕</span>
				<input class="search-input" id="dataSearch" placeholder="Search visible rows…" autocomplete="off">
			</div>
			<label class="limit-wrap">
				<span style="opacity:0.5;font-size:11px;">Limit:</span>
				<input type="text" class="search-input" id="dataLimit" value="1000" style="width:60px;margin-left:4px;text-align:right;">
			</label>
			<span class="row-count-info" id="rowCountInfo">Click to load data</span>
		</div>
		<div class="table-scroll" id="dataTableScroll">
			<table id="dataTable">
				<thead><tr>${headerHtml}</tr></thead>
				<tbody id="dataBody">${dataRowsHtml}</tbody>
			</table>
		</div>
		<div class="pagination" id="dataPagination" style="display: none;">
			<button class="page-btn" id="prevPage" disabled>‹</button>
			<span id="pageButtons"></span>
			<button class="page-btn" id="nextPage">›</button>
			<span class="page-info" id="paginationInfo">Page 1</span>
		</div>
	</div>

	<!-- ── INDEXES ── -->
	<div class="tab-pane" id="indexes-pane">
		<div class="table-scroll">
			<table>
				<thead><tr><th>Name</th><th>Columns</th><th>Type</th><th class="center">Unique</th><th class="center">Primary</th></tr></thead>
				<tbody>${indexesHtml}</tbody>
			</table>
		</div>
	</div>

	<!-- ── FOREIGN KEYS ── -->
	<div class="tab-pane" id="fk-pane">
		<div class="table-scroll">
			<div class="section-header">Outgoing (this table → other)</div>
			<table>
				<thead><tr><th>Constraint</th><th>Columns</th><th>References</th><th>Ref. Columns</th></tr></thead>
				<tbody>${fkHtml(outgoing, 'outgoing')}</tbody>
			</table>
			<div class="section-header" style="margin-top:1px">Incoming (other → this table)</div>
			<table>
				<thead><tr><th>Constraint</th><th>Ref. Columns</th><th>From Table</th><th>Columns</th></tr></thead>
				<tbody>${fkHtml(incoming, 'incoming')}</tbody>
			</table>
		</div>
	</div>

	<!-- ── CONSTRAINTS ── -->
	<div class="tab-pane" id="constraints-pane">
		<div class="table-scroll">
			<table>
				<thead><tr><th>Name</th><th>Type</th><th>Columns</th><th>Definition</th></tr></thead>
				<tbody>${constraintsHtml}</tbody>
			</table>
		</div>
	</div>

</div>

<script>
require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
const vscode = acquireVsCodeApi();

// ── Monaco theme with VS Code variables support ──
function getComputedStyleValue(variable) {
	try {
		return getComputedStyle(document.body).getPropertyValue(variable).trim();
	} catch (e) {
		return '';
	}
}

function defineVscodeTheme() {
	const isDark = document.body.classList.contains('vscode-dark') || 
	              document.body.classList.contains('vscode-high-contrast');
	
	const vscodeTheme = {
		base: isDark ? 'vs-dark' : 'vs',
		inherit: true,
		rules: [],
		colors: {
			'editor.background': getComputedStyleValue('--vscode-editor-background') || (isDark ? '#1e1e1e' : '#ffffff'),
			'editor.foreground': getComputedStyleValue('--vscode-editor-foreground') || (isDark ? '#d4d4d4' : '#000000'),
			'editor.lineHighlightBackground': getComputedStyleValue('--vscode-editorLineHighlightBackground') || (isDark ? '#264f78' : '#eeeeee'),
			'editor.selectionBackground': getComputedStyleValue('--vscode-editor.selectionBackground') || (isDark ? '#264f78' : '#add6ff'),
			'editorLineNumber.foreground': getComputedStyleValue('--vscode-editorLineNumber-foreground') || (isDark ? '#858585' : '#237893'),
			'editorCursor.foreground': getComputedStyleValue('--vscode-editorCursor-foreground') || (isDark ? '#aeafad' : '#000000'),
			'editor.inactiveSelectionBackground': getComputedStyleValue('--vscode-editor.inactiveSelectionBackground') || (isDark ? '#3a3d41' : '#e5ebf1'),
		},
	};
	
	// Handle high contrast
	if (document.body.classList.contains('vscode-high-contrast')) {
		vscodeTheme.base = 'hc-black';
		vscodeTheme.colors['editor.background'] = getComputedStyleValue('--vscode-editor-background') || '#000000';
		vscodeTheme.colors['editor.foreground'] = getComputedStyleValue('--vscode-editor-foreground') || '#ffffff';
	}
	
	monaco.editor.defineTheme('vscode-theme', vscodeTheme);
	return 'vscode-theme';
}

let editor;
const ddlContent = ${JSON.stringify(ddl)};

require(['vs/editor/editor.main'], () => {
	editor = monaco.editor.create(document.getElementById('ddlEditor'), {
		value: ddlContent, language: 'sql', theme: defineVscodeTheme(),
		minimap: { enabled: false }, fontSize: 13, readOnly: true,
		automaticLayout: true, scrollBeyondLastLine: false, wordWrap: 'on',
		tabSize: 2
	});
	new MutationObserver(() => monaco.editor.setTheme(defineVscodeTheme()))
		.observe(document.body, { attributes: true, attributeFilter: ['class'] });
});

// ── Tabs (с ленивой загрузкой данных) ──
let dataLoaded = false;
const currentSchema = "${esc(schema)}";
const currentTable = "${esc(tableName)}";

document.querySelectorAll('.tab').forEach(tab => {
	tab.addEventListener('click', () => {
		const name = tab.dataset.tab;
		document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
		document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById(name + '-pane').classList.add('active');
		if (name === 'ddl' && editor) setTimeout(() => editor.layout(), 50);
		
		// Ленивая загрузка данных при переходе на вкладку Data
		if (name === 'data' && !dataLoaded) {
			dataLoaded = true;
			loadPage(1);
		}
	});
});

// ── Open in Results ──
document.getElementById('openInResultsBtn').addEventListener('click', () => {
	vscode.postMessage({ command: 'openInResults' });
});

// ── FK links ──
document.querySelectorAll('.fk-link').forEach(link => {
	link.addEventListener('click', () => {
		vscode.postMessage({ command: 'openTable', schema: link.dataset.schema, table: link.dataset.table });
	});
});

// ── Column search ──
document.getElementById('colSearch').addEventListener('input', e => {
	const term = e.target.value.toLowerCase();
	document.querySelectorAll('#colBody tr').forEach(row => {
		row.style.display = term && !row.textContent.toLowerCase().includes(term) ? 'none' : '';
	});
});

// ── Data search ──
const dataSearch = document.getElementById('dataSearch');
if (dataSearch) {
	dataSearch.addEventListener('input', e => {
		const term = e.target.value.toLowerCase();
		document.querySelectorAll('#dataBody tr').forEach(row => {
			row.style.display = term && !row.textContent.toLowerCase().includes(term) ? 'none' : '';
		});
	});
}

// ── Pagination (динамические значения) ──
let PAGE_SIZE = 1000;
let TOTAL_COUNT = 0;
let TOTAL_PAGES = 1;
let currentPage = 1;
let hasMoreData = false;
let currentOrderBy = null;
let currentOrderDir = 'ASC';

function getPageRange(cur, total) {
	if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
	if (cur <= 4) return [1,2,3,4,5,'…',total];
	if (cur >= total - 3) return [1,'…',total-4,total-3,total-2,total-1,total];
	return [1,'…',cur-1,cur,cur+1,'…',total];
}

function renderPaginationButtons() {
	const container = document.getElementById('pageButtons');
	if (!container) return;
	container.innerHTML = '';
	getPageRange(currentPage, TOTAL_PAGES).forEach(p => {
		if (p === '…') {
			const s = document.createElement('span');
			s.textContent = '…'; s.style.cssText = 'padding:0 4px;opacity:0.4;font-size:11px';
			container.appendChild(s);
		} else {
			const b = document.createElement('button');
			b.className = 'page-btn' + (p === currentPage ? ' active' : '');
			b.textContent = p; b.onclick = () => loadPage(p);
			container.appendChild(b);
		}
	});
	const infoEl = document.getElementById('paginationInfo');
	if (infoEl) infoEl.textContent = 'Page ' + currentPage + (TOTAL_COUNT > 0 ? ' of ' + TOTAL_PAGES : '');
	const prevBtn = document.getElementById('prevPage');
	const nextBtn = document.getElementById('nextPage');
	if (prevBtn) prevBtn.disabled = currentPage === 1;
	if (nextBtn) nextBtn.disabled = currentPage >= TOTAL_PAGES && !hasMoreData;
}

let storedFieldNames = []; // Store actual field names from query result
let currentSortColumn = null; // Store column NAME for backend queries (different from currentOrderBy which is index)

function loadPage(page) {
	currentPage = page; renderPaginationButtons();
	const rowInfo = document.getElementById('rowCountInfo');
	if (rowInfo) rowInfo.textContent = 'Loading…';
	
	// Update PAGE_SIZE from input
	const limitInput = document.getElementById('dataLimit');
	if (limitInput) {
		PAGE_SIZE = parseInt(limitInput.value, 10) || 1000;
	}
	
	// Use currentSortColumn for ORDER BY (stored separately from index)
	if (currentSortColumn && storedFieldNames.includes(currentSortColumn)) {
		vscode.postMessage({ command: 'loadSortedPage', page, limit: PAGE_SIZE, orderBy: currentSortColumn, orderDir: currentOrderDir });
	} else {
		vscode.postMessage({ command: 'loadPage', page, limit: PAGE_SIZE });
	}
}

// ── Limit change handler ──
const limitInput = document.getElementById('dataLimit');
if (limitInput) {
	limitInput.addEventListener('change', () => {
		PAGE_SIZE = parseInt(limitInput.value, 10) || 1000;
		loadPage(1);
	});
}

const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');
if (prevBtn) prevBtn.onclick = () => { if (currentPage > 1) loadPage(currentPage - 1); };
if (nextBtn) nextBtn.onclick = () => { if (currentPage < TOTAL_PAGES || hasMoreData) loadPage(currentPage + 1); };

window.addEventListener('message', e => {
	const msg = e.data;
	if (msg.command === 'pageData') {
		const tbody = document.getElementById('dataBody');
		const fields = msg.fields;
		// Пустая таблица - показываем сообщение
		if (msg.rows.length === 0) {
			tbody.innerHTML = '<tr><td colspan="100%" class="empty-cell">No data</td></tr>';
			const rowInfo = document.getElementById('rowCountInfo');
			if (rowInfo) rowInfo.textContent = '0 rows';
			// Скрываем пагинацию
			const pag = document.getElementById('dataPagination');
			if (pag) pag.style.display = 'none';
			return;
		}
		tbody.innerHTML = msg.rows.map(row =>
			'<tr>' + fields.map(f => {
				const v = row[f];
				return v === null
					? '<td><span class="null-val">NULL</span></td>'
					: '<td title="' + escH(String(v)) + '">' + escH(String(v)) + '</td>';
			}).join('') + '</tr>'
		).join('');
		if (dataSearch) dataSearch.value = '';
		
		// Store actual field names from query result for sorting
		if (fields && fields.length > 0 && storedFieldNames.length === 0) {
			storedFieldNames = fields;
		}
		
		// Проверяем есть ли ещё данные
		hasMoreData = msg.rows.length >= PAGE_SIZE;
		
		if (hasMoreData) {
			// Если есть ещё данные, увеличиваем общее количество страниц
			TOTAL_PAGES = currentPage + 1;
			TOTAL_COUNT = currentPage * PAGE_SIZE;
		} else {
			// Если данных меньше чем pageSize, показываем общее количество
			TOTAL_PAGES = currentPage;
			TOTAL_COUNT = (currentPage - 1) * PAGE_SIZE + msg.rows.length;
		}
		
		const rowInfo = document.getElementById('rowCountInfo');
		if (rowInfo) {
			const start = (currentPage - 1) * PAGE_SIZE + 1;
			const end = (currentPage - 1) * PAGE_SIZE + msg.rows.length;
			rowInfo.textContent = start + '–' + end + (hasMoreData ? '+ rows' : ' rows');
		}
		
		// Показываем/скрываем пагинацию
		const pag = document.getElementById('dataPagination');
		if (pag) {
			pag.style.display = (TOTAL_PAGES > 1 || hasMoreData) ? 'flex' : 'none';
			renderPaginationButtons();
		}
		
		// Restore sort state from message
		if (msg.orderBy) {
			currentSortColumn = msg.orderBy;
			currentOrderDir = msg.orderDir || 'ASC';
			// Restore currentOrderBy (index) from currentSortColumn
			currentOrderBy = storedFieldNames.indexOf(msg.orderBy);
			document.querySelectorAll('#dataTable th.sortable').forEach(h => {
				h.classList.remove('sorted-asc', 'sorted-desc');
				if (h.dataset.col == currentOrderBy) {
					h.classList.add(currentOrderDir === 'ASC' ? 'sorted-asc' : 'sorted-desc');
				}
			});
		}
	}
});

// ── Sort click handler (event delegation) ──
document.addEventListener('click', (e) => {
	const th = e.target.closest('#dataTable th.sortable');
	if (!th) return;
	const colIndex = parseInt(th.dataset.col, 10);
	if (currentOrderBy === colIndex) {
		currentOrderDir = currentOrderDir === 'ASC' ? 'DESC' : 'ASC';
	} else {
		currentOrderBy = colIndex;
		currentOrderDir = 'ASC';
	}
	// Update currentSortColumn with the actual column name
	if (colIndex >= 0 && colIndex < storedFieldNames.length) {
		currentSortColumn = storedFieldNames[colIndex];
	}
	document.querySelectorAll('#dataTable th.sortable').forEach(h => h.classList.remove('sorted-asc', 'sorted-desc'));
	th.classList.add(currentOrderDir === 'ASC' ? 'sorted-asc' : 'sorted-desc');
	loadPage(1);
});

function escH(t) {
	const d = document.createElement('div'); d.textContent = t; return d.innerHTML;
}

// ── Modal for adding columns ───────────────────────────────────────────────
var modalHtml = '<div id="addColModal" class="modal-overlay" style="display:none;">' +
	'<div class="modal-content">' +
		'<div class="modal-header">' +
			'<span class="modal-title">Add New Column</span>' +
			'<button class="modal-close" id="closeModal">&times;</button>' +
		'</div>' +
		'<div class="modal-body">' +
			'<div class="form-group">' +
				'<label>Column Name</label>' +
				'<input type="text" id="newColName" class="form-input" placeholder="e.g., user_name">' +
			'</div>' +
			'<div class="form-group">' +
				'<label>Data Type</label>' +
				'<select id="newColType" class="form-select">' +
					'<option value="VARCHAR(255)">VARCHAR(255)</option>' +
					'<option value="INTEGER">INTEGER</option>' +
					'<option value="BIGINT">BIGINT</option>' +
					'<option value="TEXT">TEXT</option>' +
					'<option value="BOOLEAN">BOOLEAN</option>' +
					'<option value="DATE">DATE</option>' +
					'<option value="TIMESTAMP">TIMESTAMP</option>' +
					'<option value="NUMERIC">NUMERIC</option>' +
					'<option value="REAL">REAL</option>' +
					'<option value="UUID">UUID</option>' +
					'<option value="JSONB">JSONB</option>' +
					'<option value="BYTEA">BYTEA</option>' +
				'</select>' +
			'</div>' +
			'<div class="form-group">' +
				'<label><input type="checkbox" id="newColNotNull"> NOT NULL</label>' +
			'</div>' +
			'<div class="form-group">' +
				'<label>Default Value</label>' +
				'<input type="text" id="newColDefault" class="form-input" placeholder="e.g., 0 or default">' +
			'</div>' +
			'<div class="form-group">' +
				'<label>Comment</label>' +
				'<input type="text" id="newColComment" class="form-input" placeholder="Optional comment">' +
			'</div>' +
		'</div>' +
		'<div class="modal-footer">' +
			'<button type="button" class="btn-cancel" id="cancelAddCol">Cancel</button>' +
			'<button type="button" class="btn-confirm" id="confirmAddCol">Add Column</button>' +
		'</div>' +
	'</div>' +
'</div>';
document.body.insertAdjacentHTML('beforeend', modalHtml);

// Modal event handlers
document.getElementById('addColBtn').addEventListener('click', function() {
	document.getElementById('addColModal').style.display = 'flex';
	document.getElementById('newColName').focus();
});

document.getElementById('closeModal').addEventListener('click', function() {
	document.getElementById('addColModal').style.display = 'none';
});

document.getElementById('cancelAddCol').addEventListener('click', function() {
	document.getElementById('addColModal').style.display = 'none';
});

document.getElementById('confirmAddCol').addEventListener('click', function() {
	var colName = document.getElementById('newColName').value.trim();
	var colType = document.getElementById('newColType').value;
	var notNull = document.getElementById('newColNotNull').checked;
	var defaultValue = document.getElementById('newColDefault').value.trim();
	var comment = document.getElementById('newColComment').value.trim();

	if (!colName) {
		alert('Please enter a column name');
		return;
	}

	// Validate column name (PostgreSQL identifiers)
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(colName)) {
		alert('Invalid column name. Use only letters, numbers, and underscores, starting with a letter or underscore.');
		return;
	}

	vscode.postMessage({
		command: 'createColumn',
		columnName: colName,
		columnType: colType,
		notNull: notNull,
		defaultValue: defaultValue || null,
		comment: comment || null
	});

	document.getElementById('addColModal').style.display = 'none';
	// Clear form
	document.getElementById('newColName').value = '';
	document.getElementById('newColDefault').value = '';
	document.getElementById('newColComment').value = '';
	document.getElementById('newColNotNull').checked = false;
});

// Close modal on outside click
document.getElementById('addColModal').addEventListener('click', function(e) {
	if (e.target.id === 'addColModal') {
		document.getElementById('addColModal').style.display = 'none';
	}
});

// ── Column row selection ───────────────────────────────────────────────
let selectedColumnName = null;

document.getElementById('colBody').addEventListener('click', function(e) {
	// Skip if clicking on a button inside the row
	if (e.target.closest('.btn-delete-col')) return;
	
	// Check if clicking on a row
	var row = e.target.closest('tr[data-col-name]');
	if (!row) return;

	// Remove previous selection
	document.querySelectorAll('#colBody tr').forEach(function(r) {
		r.classList.remove('selected');
	});

	// Add selection to clicked row
	row.classList.add('selected');
	selectedColumnName = row.getAttribute('data-col-name');

	// Enable action buttons
	document.getElementById('deleteColBtn').disabled = false;
	document.getElementById('editColBtn').disabled = false;
});

// ── Delete selected column ────────────────────────────────────────────
document.getElementById('deleteColBtn').addEventListener('click', function() {
	if (!selectedColumnName) return;

	if (confirm('Are you sure you want to delete column "' + selectedColumnName + '"?\\n\\nThis will also delete all data in this column.')) {
		vscode.postMessage({
			command: 'deleteColumn',
			columnName: selectedColumnName
		});
	}
	// Clear selection after delete
	selectedColumnName = null;
	document.getElementById('deleteColBtn').disabled = true;
	document.getElementById('editColBtn').disabled = true;
});

// ── Edit selected column ───────────────────────────────────────────────
document.getElementById('editColBtn').addEventListener('click', function() {
	if (!selectedColumnName) return;

	vscode.window.showInputBox({
		prompt: 'Edit column "' + selectedColumnName + '" - Enter new name (or press Esc to cancel)',
		value: selectedColumnName
	}).then(function(newName) {
		if (newName && newName !== selectedColumnName) {
			// Rename column using ALTER TABLE ... RENAME COLUMN
			vscode.postMessage({
				command: 'renameColumn',
				oldColumnName: selectedColumnName,
				newColumnName: newName
			});
		}
	});
});

// Inline delete button - stop propagation to prevent row selection
document.querySelectorAll('.btn-delete-col').forEach(function(btn) {
	btn.addEventListener('click', function(e) {
		e.stopPropagation();
		var colName = this.getAttribute('data-col');
		if (!colName) return;

		if (confirm('Are you sure you want to delete column "' + colName + '"?\\n\\nThis will also delete all data in this column.')) {
			vscode.postMessage({
				command: 'deleteColumn',
				columnName: colName
			});
		}
	});
});
</script>
</body>
</html>`;
	}

	// ── HTML для функций и процедур ──────────────────────────────────────────

	private static getFunctionHtml(
		schema: string,
		functionName: string,
		ddl: string
	): string {
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
<style>
	*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
	html, body {
		width: 100%; height: 100%;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size, 13px);
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		display: flex; flex-direction: column; overflow: hidden;
	}

	.header {
		display: flex; align-items: center; justify-content: space-between;
		padding: 6px 12px;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		border-bottom: 1px solid var(--vscode-panel-border);
		flex-shrink: 0; gap: 8px;
	}
	.header-left { display: flex; align-items: center; gap: 8px; }
	.header-title { font-size: 13px; font-weight: 600; }
	.header-meta {
		font-size: 11px; opacity: 0.55;
		background: var(--vscode-badge-background);
		color: var(--vscode-badge-foreground);
		padding: 1px 7px; border-radius: 10px;
	}

	.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
	#ddlEditor { flex: 1; }
</style>
</head>
<body>
	<div class="header">
		<div class="header-left">
			<span class="header-title">${esc(functionName)}</span>
			<span class="header-meta">Function</span>
		</div>
	</div>
	<div class="content">
		<div id="ddlEditor"></div>
	</div>

	<script>
	require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });

	require(['vs/editor/editor.main'], function () {
		const ddl = ${JSON.stringify(ddl)};

		// Define custom theme that inherits from VS Code CSS variables
		function getComputedStyleValue(variable) {
			try {
				return getComputedStyle(document.body).getPropertyValue(variable).trim();
			} catch (e) {
				return '';
			}
		}

		const vscodeTheme = {
			base: 'vs',
			inherit: true,
			rules: [],
			colors: {
				'editor.background': getComputedStyleValue('--vscode-editor-background') || '#ffffff',
				'editor.foreground': getComputedStyleValue('--vscode-editor-foreground') || '#000000',
				'editor.lineHighlightBackground': getComputedStyleValue('--vscode-editorLineHighlightBackground') || '#eeeeee',
				'editor.selectionBackground': getComputedStyleValue('--vscode-editor.selectionBackground') || '#add6ff',
				'editorLineNumber.foreground': getComputedStyleValue('--vscode-editorLineNumber-foreground') || '#237893',
				'editorCursor.foreground': getComputedStyleValue('--vscode-editorCursor-foreground') || '#000000',
				'editor.inactiveSelectionBackground': getComputedStyleValue('--vscode-editor.inactiveSelectionBackground') || '#e5ebf1',
			},
		};

		// Check if dark mode
		const isDark = document.body.classList.contains('vscode-dark') || 
		              document.body.classList.contains('vscode-high-contrast');
		if (isDark) {
			vscodeTheme.base = 'vs-dark';
			vscodeTheme.colors['editor.background'] = getComputedStyleValue('--vscode-editor-background') || '#1e1e1e';
			vscodeTheme.colors['editor.foreground'] = getComputedStyleValue('--vscode-editor-foreground') || '#d4d4d4';
			vscodeTheme.colors['editor.lineHighlightBackground'] = getComputedStyleValue('--vscode-editorLineHighlightBackground') || '#264f78';
			vscodeTheme.colors['editor.selectionBackground'] = getComputedStyleValue('--vscode-editor.selectionBackground') || '#264f78';
			vscodeTheme.colors['editorLineNumber.foreground'] = getComputedStyleValue('--vscode-editorLineNumber-foreground') || '#858585';
			vscodeTheme.colors['editorCursor.foreground'] = getComputedStyleValue('--vscode-editorCursor-foreground') || '#aeafad';
			vscodeTheme.colors['editor.inactiveSelectionBackground'] = getComputedStyleValue('--vscode-editor.inactiveSelectionBackground') || '#3a3d41';
		}

		monaco.editor.defineTheme('vscode-theme', vscodeTheme);
		monaco.editor.setTheme('vscode-theme');

		const editor = monaco.editor.create(document.getElementById('ddlEditor'), {
			value: ddl,
			language: 'sql',
			theme: 'vscode-theme',
			readOnly: true,
			minimap: { enabled: false },
			fontSize: 13,
			tabSize: 2,
			automaticLayout: true,
			scrollBeyondLastLine: false,
			wordWrap: 'on',
		});

		// Adjust editor on resize
		window.addEventListener('resize', () => editor.layout());

		// Listen for theme changes
		const observer = new MutationObserver(() => {
			const newIsDark = document.body.classList.contains('vscode-dark') || 
			                 document.body.classList.contains('vscode-high-contrast');
			vscodeTheme.base = newIsDark ? 'vs-dark' : 'vs';
			vscodeTheme.colors['editor.background'] = getComputedStyleValue('--vscode-editor-background') || (newIsDark ? '#1e1e1e' : '#ffffff');
			vscodeTheme.colors['editor.foreground'] = getComputedStyleValue('--vscode-editor-foreground') || (newIsDark ? '#d4d4d4' : '#000000');
			vscodeTheme.colors['editor.lineHighlightBackground'] = getComputedStyleValue('--vscode-editorLineHighlightBackground') || (newIsDark ? '#264f78' : '#eeeeee');
			vscodeTheme.colors['editor.selectionBackground'] = getComputedStyleValue('--vscode-editor.selectionBackground') || (newIsDark ? '#264f78' : '#add6ff');
			vscodeTheme.colors['editorLineNumber.foreground'] = getComputedStyleValue('--vscode-editorLineNumber-foreground') || (newIsDark ? '#858585' : '#237893');
			vscodeTheme.colors['editorCursor.foreground'] = getComputedStyleValue('--vscode-editorCursor-foreground') || (newIsDark ? '#aeafad' : '#000000');
			vscodeTheme.colors['editor.inactiveSelectionBackground'] = getComputedStyleValue('--vscode-editor.inactiveSelectionBackground') || (newIsDark ? '#3a3d41' : '#e5ebf1');
			monaco.editor.defineTheme('vscode-theme', vscodeTheme);
			monaco.editor.setTheme('vscode-theme');
		});
		observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
	});
	</script>
</body>
</html>`;
	}
}