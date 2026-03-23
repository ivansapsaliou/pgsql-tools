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
			} else if (message.command === 'loadPage') {
				try {
					const pageSize = 100;
					const offset = (message.page - 1) * pageSize;
					const result = await queryExecutor.getTableData(schema, objectName, pageSize, offset);
					this.currentPanel?.webview.postMessage({
						command: 'pageData',
						rows: result.rows,
						fields: result.fields?.map((f: any) => f.name) || [],
						page: message.page,
					});
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to load page: ${err}`);
				}
			}
		});

		try {
			if (objectType === 'table') {
				const [ddl, data, totalCount, indexes, foreignKeys, constraints, columnDetails] =
					await Promise.all([
						queryExecutor.getTableDDL(schema, objectName),
						queryExecutor.getTableData(schema, objectName, 100, 0),
						queryExecutor.getTableRowCount(schema, objectName),
						queryExecutor.getIndexes(schema, objectName),
						queryExecutor.getForeignKeys(schema, objectName),
						queryExecutor.getConstraints(schema, objectName),
						this.fetchColumnDetails(queryExecutor, schema, objectName),
					]);

				this.currentPanel.webview.html = this.getHtml(
					schema, objectName, ddl, data, totalCount,
					indexes, foreignKeys, constraints, columnDetails
				);
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

	// ── HTML ──────────────────────────────────────────────────────────────────

	private static getHtml(
		schema: string,
		tableName: string,
		ddl: string,
		data: QueryResult,
		totalCount: number,
		indexes: IndexInfo[],
		foreignKeys: ForeignKeyInfo[],
		constraints: ConstraintInfo[],
		columnDetails: ColumnDetail[]
	): string {
		const fieldNames = data.fields?.map((f: any) => f.name) || [];
		const pageSize = 100;
		const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

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

			return `<tr>
				<td class="monospace col-name-cell">${esc(col.col)}</td>
				<td class="monospace">${esc(col.col_type)}</td>
				<td>${badges.join(' ')}</td>
				<td class="monospace small">${col.col_default ? esc(col.col_default) : '<span style="opacity:0.4">—</span>'}</td>
				<td class="monospace small">${fkRef}</td>
				<td class="comment-cell">${col.col_comment ? esc(col.col_comment) : '<span style="opacity:0.35">—</span>'}</td>
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

		// ── Вкладка Data ──────────────────────────────────────────────────────
		const dataRowsHtml = data.rows.map((row: any) => `
			<tr>${fieldNames.map((f) => {
				const v = row[f];
				return v === null
					? '<td><span class="null-val">NULL</span></td>'
					: `<td title="${esc(String(v))}">${esc(String(v))}</td>`;
			}).join('')}</tr>`).join('');

		const headerHtml = fieldNames.map((f) => `<th>${esc(f)}</th>`).join('');

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
</style>
</head>
<body>

<div class="header">
	<div class="header-left">
		<span class="header-title">${esc(tableName)}</span>
		<span class="header-meta">schema: ${esc(schema)}</span>
		<span class="header-meta">${totalCount.toLocaleString()} rows</span>
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

	<!-- ── DATA ── -->
	<div class="tab-pane" id="data-pane">
		<div class="data-toolbar">
			<div class="search-wrap">
				<span class="search-icon">⌕</span>
				<input class="search-input" id="dataSearch" placeholder="Search visible rows…" autocomplete="off">
			</div>
			<span class="row-count-info" id="rowCountInfo">
				${Math.min(100, totalCount)} of ${totalCount.toLocaleString()} rows
			</span>
		</div>
		<div class="table-scroll" id="dataTableScroll">
			<table id="dataTable">
				<thead><tr>${headerHtml}</tr></thead>
				<tbody id="dataBody">${dataRowsHtml}</tbody>
			</table>
		</div>
		${totalPages > 1 ? `
		<div class="pagination" id="dataPagination">
			<button class="page-btn" id="prevPage" disabled>‹</button>
			<span id="pageButtons"></span>
			<button class="page-btn" id="nextPage" ${totalPages === 1 ? 'disabled' : ''}>›</button>
			<span class="page-info" id="paginationInfo">Page 1 of ${totalPages}</span>
		</div>` : ''}
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

// ── Monaco theme ──
function monacoTheme() {
	if (document.body.classList.contains('vscode-light')) return 'vs';
	if (document.body.classList.contains('vscode-high-contrast')) return 'hc-black';
	return 'vs-dark';
}

let editor;
const ddlContent = ${JSON.stringify(ddl)};

require(['vs/editor/editor.main'], () => {
	editor = monaco.editor.create(document.getElementById('ddlEditor'), {
		value: ddlContent, language: 'sql', theme: monacoTheme(),
		minimap: { enabled: false }, fontSize: 13, readOnly: true,
		automaticLayout: true, scrollBeyondLastLine: false, wordWrap: 'on'
	});
	new MutationObserver(() => monaco.editor.setTheme(monacoTheme()))
		.observe(document.body, { attributes: true, attributeFilter: ['class'] });
});

// ── Tabs ──
document.querySelectorAll('.tab').forEach(tab => {
	tab.addEventListener('click', () => {
		const name = tab.dataset.tab;
		document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
		document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById(name + '-pane').classList.add('active');
		if (name === 'ddl' && editor) setTimeout(() => editor.layout(), 50);
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

// ── Pagination ──
const PAGE_SIZE = 100;
const TOTAL_COUNT = ${totalCount};
const TOTAL_PAGES = ${totalPages};
let currentPage = 1;

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
	document.getElementById('paginationInfo').textContent = 'Page ' + currentPage + ' of ' + TOTAL_PAGES;
	document.getElementById('prevPage').disabled = currentPage === 1;
	document.getElementById('nextPage').disabled = currentPage === TOTAL_PAGES;
}

function loadPage(page) {
	currentPage = page; renderPaginationButtons();
	document.getElementById('rowCountInfo').textContent = 'Loading…';
	vscode.postMessage({ command: 'loadPage', page });
}

const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');
if (prevBtn) prevBtn.onclick = () => { if (currentPage > 1) loadPage(currentPage - 1); };
if (nextBtn) nextBtn.onclick = () => { if (currentPage < TOTAL_PAGES) loadPage(currentPage + 1); };
if (TOTAL_PAGES > 1) renderPaginationButtons();

window.addEventListener('message', e => {
	const msg = e.data;
	if (msg.command === 'pageData') {
		const tbody = document.getElementById('dataBody');
		const fields = msg.fields;
		tbody.innerHTML = msg.rows.map(row =>
			'<tr>' + fields.map(f => {
				const v = row[f];
				return v === null
					? '<td><span class="null-val">NULL</span></td>'
					: '<td title="' + escH(String(v)) + '">' + escH(String(v)) + '</td>';
			}).join('') + '</tr>'
		).join('');
		if (dataSearch) dataSearch.value = '';
		const start = (msg.page - 1) * PAGE_SIZE + 1;
		const end = Math.min(msg.page * PAGE_SIZE, TOTAL_COUNT);
		document.getElementById('rowCountInfo').textContent = start + '–' + end + ' of ' + TOTAL_COUNT.toLocaleString() + ' rows';
	}
});

function escH(t) {
	const d = document.createElement('div'); d.textContent = t; return d.innerHTML;
}
</script>
</body>
</html>`;
	}
}