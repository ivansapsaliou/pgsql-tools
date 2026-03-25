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

// SVG icons for each object type — embedded as data URIs
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
	// One panel per unique object: key = schema.name:type
	private static panels: Map<string, vscode.WebviewPanel> = new Map();

	// Debounce timers to avoid opening on rapid tree navigation
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

		// If panel already open — just focus it, no debounce needed
		const existingPanel = this.panels.get(panelKey);
		if (existingPanel) {
			existingPanel.reveal(undefined, false);
			return;
		}

		// Cancel any pending open for same key
		const existingTimer = this.pendingOpen.get(panelKey);
		if (existingTimer) { clearTimeout(existingTimer); }

		// Debounce 150ms — prevents opening panel on accidental single clicks
		// while navigating the tree (expand/collapse fires selection events)
		const timer = setTimeout(async () => {
			this.pendingOpen.delete(panelKey);
			// Re-check: might have been created by another path
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
		const typeLabel: Record<string, string> = {
			table: 'Table', view: 'View', function: 'Function', procedure: 'Procedure'
		};
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

		// Set icon: light/dark pair
		panel.iconPath = {
			light: svgToUri(iconSet.light),
			dark:  svgToUri(iconSet.dark),
		};

		this.panels.set(panelKey, panel);
		panel.onDidDispose(() => this.panels.delete(panelKey));

		// ── Message handler ────────────────────────────────────────
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
						const orderBy = message.orderBy ? ` ORDER BY "${message.orderBy}" ${message.orderDir || 'ASC'}` : '';
						const result = await queryExecutor.executeQuery(
							`SELECT * FROM "${schema}"."${objectName}"${orderBy} LIMIT ${pageSize} OFFSET ${offset}`
						);
						panel.webview.postMessage({
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

				case 'deleteColumn': {
					try {
						await queryExecutor.executeQuery(
							`ALTER TABLE "${schema}"."${objectName}" DROP COLUMN "${message.columnName}"`
						);
						vscode.window.showInformationMessage(`Column "${message.columnName}" deleted`);
						this._refresh(context, panelKey, schema, objectName, objectType, queryExecutor, connectionManager, resultsViewProvider);
					} catch (err) {
						vscode.window.showErrorMessage(`Failed to delete column: ${err}`);
					}
					break;
				}

				// Rename is triggered from webview; actual input box shown in extension host
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

		// Show loading immediately
		panel.webview.html = this._loadingHtml(title, objectType);

		// Load data
		try {
			await this._loadAndRender(panel, panelKey, schema, objectName, objectType, queryExecutor);
		} catch (err) {
			vscode.window.showErrorMessage(`Failed to load object details: ${err}`);
			panel.dispose();
		}
	}

	/** Refresh: dispose existing panel then reopen */
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
		if (p) { p.dispose(); } // onDispose removes from map
		// Open fresh after a tick
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

	// ── Data loading ────────────────────────────────────────────────────────

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

	// ── Loading HTML ────────────────────────────────────────────────────────

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

	// ── Code-only HTML (functions/procedures) ────────────────────────────────

	private static _codeHtml(schema: string, name: string, ddl: string, typeLabel: string): string {
		// KEY FIX: don't override token colors — just use base theme. Only set background/cursor.
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
#monacoEditor{flex:1}
</style></head><body>
<div class="header">
	<span class="header-title">${esc(name)}</span>
	<span class="badge">${esc(typeLabel)}</span>
	<span class="badge">schema: ${esc(schema)}</span>
</div>
<div class="content"><div id="monacoEditor"></div></div>
<script>
require.config({paths:{vs:'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs'}});
require(['vs/editor/editor.main'],function(){
	// Detect VS Code theme kind — only set background, let Monaco handle token colors
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
			// Only override chrome colors, NOT token colors — inherit handles syntax
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
	const editor = monaco.editor.create(document.getElementById('monacoEditor'),{
		value:${JSON.stringify(ddl)},
		language:'sql',
		theme:'vsc-match',
		readOnly:true,
		minimap:{enabled:false},
		fontSize:13,
		fontFamily:getVar('--vscode-editor-font-family') || 'Consolas, monospace',
		automaticLayout:true,
		scrollBeyondLastLine:false,
		wordWrap:'on',
		tabSize:2,
		renderWhitespace:'none',
		lineNumbers:'on',
	});
	new MutationObserver(applyTheme).observe(document.body,{attributes:true,attributeFilter:['class']});
});
</script></body></html>`;
	}

	// ── Table/View HTML ──────────────────────────────────────────────────────

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
			return `<tr data-col-name="${esc(col.col)}">
				<td class="mono col-name">${esc(col.col)}</td>
				<td class="mono"><span class="type-badge ${ft.class}">${ft.display}</span></td>
				<td>${badges.join(' ')}</td>
				<td class="mono small">${col.col_default ? esc(col.col_default) : '<span class="dim">—</span>'}</td>
				<td class="mono small">${fkRef}</td>
				<td class="comment">${col.col_comment ? esc(col.col_comment) : '<span class="dim">—</span>'}</td>
				<td class="act-cell">
					<button class="btn-inline-del" data-col="${esc(col.col)}" title="Delete column">✕</button>
				</td>
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

		// ── Constraints tab ──
		const constraintsHtml = constraints.length
			? constraints.map(c => `<tr>
				<td class="mono">${esc(c.name)}</td>
				<td><span class="badge badge--${c.type === 'PRIMARY KEY' ? 'pk' : c.type === 'UNIQUE' ? 'uq' : 'ck'}">${esc(c.type)}</span></td>
				<td>${esc(c.columns.join(', '))}</td>
				<td class="mono small">${c.definition ? esc(c.definition) : '—'}</td>
			</tr>`).join('')
			: '<tr><td colspan="4" class="empty">No constraints</td></tr>';

		// ── Data tab header ──
		const dataHeaderHtml = fieldNames.map((f, i) =>
			`<th class="sortable" data-col="${i}">${esc(f)} <span class="sort-icon"></span></th>`
		).join('');

		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);
	background:var(--vscode-editor-background);color:var(--vscode-foreground);
	display:flex;flex-direction:column;overflow:hidden}

/* ── header ── */
.header{display:flex;align-items:center;justify-content:space-between;padding:6px 12px;
	background:var(--vscode-editorGroupHeader-tabsBackground);
	border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;gap:8px}
.header-left{display:flex;align-items:center;gap:8px}
.header-title{font-size:13px;font-weight:600}
.badge-meta{font-size:11px;opacity:.55;background:var(--vscode-badge-background);
	color:var(--vscode-badge-foreground);padding:1px 7px;border-radius:10px}
.btn-open{display:flex;align-items:center;gap:4px;padding:3px 10px;
	background:var(--vscode-button-background);color:var(--vscode-button-foreground);
	border:none;border-radius:2px;font-family:inherit;font-size:11px;cursor:pointer;height:22px}
.btn-open:hover{background:var(--vscode-button-hoverBackground)}

/* ── tabs ── */
.tabs{display:flex;background:var(--vscode-editorGroupHeader-tabsBackground);
	border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;padding:0 4px}
.tab{padding:6px 14px;font-size:12px;font-weight:500;cursor:pointer;
	border-bottom:2px solid transparent;color:var(--vscode-foreground);opacity:.65;user-select:none}
.tab:hover{opacity:.9}
.tab.active{opacity:1;border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-textLink-foreground)}
.tab-count{display:inline-block;margin-left:4px;padding:0 5px;
	background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);
	border-radius:8px;font-size:10px;font-weight:600;vertical-align:middle}

/* ── layout ── */
.content{flex:1;overflow:hidden;display:flex;flex-direction:column}
.tab-pane{display:none;flex:1;overflow:hidden;flex-direction:column}
.tab-pane.active{display:flex}
#ddlEditor{flex:1}

/* ── toolbar ── */
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

/* ── col action buttons ── */
.btn-act{display:inline-flex;align-items:center;justify-content:center;
	width:24px;height:22px;padding:0;background:var(--vscode-button-background);
	color:var(--vscode-button-foreground);border:none;border-radius:2px;font-size:13px;cursor:pointer}
.btn-act:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.btn-act:disabled{opacity:.35;cursor:default}
.btn-act.danger:hover:not(:disabled){color:var(--vscode-errorForeground,#f14c4c)}

/* ── table shared ── */
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
.act-cell{text-align:center;width:36px}

/* ── badges ── */
.badge{display:inline-block;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700}
.badge--pk{background:rgba(86,156,214,.2);color:#569cd6}
.badge--uq{background:rgba(220,220,170,.2);color:#dcdcaa}
.badge--fk{background:rgba(210,162,42,.2);color:#d2a22a}
.badge--nn{background:rgba(206,145,120,.15);color:#ce9178}
.badge--ck{background:rgba(206,145,120,.2);color:#ce9178}
.badge--yes{background:rgba(78,201,176,.2);color:#4ec9b0}

/* ── fk link ── */
.fk-link{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:none;
	font-family:var(--vscode-editor-font-family,monospace);font-size:11px}
.fk-link:hover{text-decoration:underline}

/* ── type badges ── */
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

/* ── inline delete ── */
.btn-inline-del{background:none;border:none;color:var(--vscode-errorForeground,#f14c4c);
	cursor:pointer;padding:2px 5px;font-size:11px;opacity:.4;border-radius:3px}
.btn-inline-del:hover{opacity:1;background:rgba(241,76,76,.15)}

/* ── section header ── */
.sec-h{padding:5px 10px;font-size:10px;font-weight:700;opacity:.6;
	background:var(--vscode-sideBar-background,var(--vscode-editorGroupHeader-tabsBackground));
	border-bottom:1px solid var(--vscode-panel-border);text-transform:uppercase;letter-spacing:.06em}

/* ── pagination ── */
.pag{display:flex;align-items:center;gap:5px;padding:4px 10px;
	background:var(--vscode-editorGroupHeader-tabsBackground);
	border-top:1px solid var(--vscode-panel-border);flex-shrink:0;font-size:11px;height:30px}
.pbtn{background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);
	cursor:pointer;font-size:11px;padding:1px 7px;border-radius:2px}
.pbtn:hover:not(:disabled){background:var(--vscode-list-hoverBackground)}
.pbtn:disabled{opacity:.3;cursor:default}
.pbtn.active{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.pinfo{opacity:.5;margin-left:auto}

/* ── modal ── */
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

<div class="header">
	<div class="header-left">
		<span class="header-title">${esc(tableName)}</span>
		<span class="badge-meta">schema: ${esc(schema)}</span>
		<span class="badge-meta">${columnDetails.length} columns</span>
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

<!-- ── COLUMNS ── -->
<div class="tab-pane active" id="columns-pane">
	<div class="toolbar">
		<button class="btn-act" id="addColBtn" title="Add column">+</button>
		<button class="btn-act danger" id="deleteColBtn" disabled title="Delete selected">−</button>
		<button class="btn-act" id="editColBtn" disabled title="Rename selected">✎</button>
		<div class="sw"><span class="si">⌕</span>
			<input class="sinput" id="colSearch" placeholder="Filter columns…" autocomplete="off">
		</div>
	</div>
	<div class="tscroll">
		<table><thead><tr>
			<th>Column</th><th>Type</th><th>Flags</th><th>Default</th><th>References</th><th>Comment</th><th style="width:36px"></th>
		</tr></thead>
		<tbody id="colBody">${columnsTabHtml}</tbody></table>
	</div>
</div>

<!-- ── DDL ── -->
<div class="tab-pane" id="ddl-pane">
	<div id="ddlEditor"></div>
</div>

<!-- ── DATA ── -->
<div class="tab-pane" id="data-pane">
	<div class="toolbar">
		<div class="sw"><span class="si">⌕</span>
			<input class="sinput" id="dataSearch" placeholder="Search visible rows…" autocomplete="off">
		</div>
		<label style="display:flex;align-items:center;gap:4px;font-size:11px;flex-shrink:0">
			<span style="opacity:.5">Limit:</span>
			<input type="text" class="sinput" id="dataLimit" value="1000" style="width:60px;text-align:right;padding-left:8px">
		</label>
		<span class="row-info" id="rowInfo">—</span>
	</div>
	<div class="tscroll">
		<table id="dataTable">
			<thead><tr>${dataHeaderHtml}</tr></thead>
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

<!-- ── FK ── -->
<div class="tab-pane" id="fk-pane">
	<div class="tscroll">
		<div class="sec-h">Outgoing (this → other)</div>
		<table><thead><tr><th>Constraint</th><th>Columns</th><th>References</th><th>Ref. Columns</th></tr></thead>
		<tbody>${fkRows(outgoing, 'outgoing')}</tbody></table>
		<div class="sec-h" style="margin-top:1px">Incoming (other → this)</div>
		<table><thead><tr><th>Constraint</th><th>Ref. Columns</th><th>From Table</th><th>Columns</th></tr></thead>
		<tbody>${fkRows(incoming, 'incoming')}</tbody></table>
	</div>
</div>

<!-- ── CONSTRAINTS ── -->
<div class="tab-pane" id="constraints-pane">
	<div class="tscroll"><table>
		<thead><tr><th>Name</th><th>Type</th><th>Columns</th><th>Definition</th></tr></thead>
		<tbody>${constraintsHtml}</tbody>
	</table></div>
</div>

</div><!-- /content -->

<!-- Add column modal -->
<div id="addModal" class="modal-ov" style="display:none">
	<div class="modal">
		<div class="modal-hd"><span class="modal-title">Add Column</span><button class="modal-x" id="closeModal">&times;</button></div>
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

<script>
require.config({paths:{vs:'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs'}});
const vscode = acquireVsCodeApi();

// ── Monaco: match VS Code syntax highlighting exactly ─────────
function getVar(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim();}

function applyTheme(){
	const dark = document.body.classList.contains('vscode-dark')||document.body.classList.contains('vscode-high-contrast');
	const hc   = document.body.classList.contains('vscode-high-contrast');
	const base = hc ? 'hc-black' : (dark ? 'vs-dark' : 'vs');
	const colors = {};
	const bg  = getVar('--vscode-editor-background');
	const fg  = getVar('--vscode-editor-foreground');
	const ln  = getVar('--vscode-editorLineNumber-foreground');
	const cur = getVar('--vscode-editorCursor-foreground');
	const sel = getVar('--vscode-editor-selectionBackground');
	if(bg)  colors['editor.background'] = bg;
	if(fg)  colors['editor.foreground'] = fg;
	if(ln)  colors['editorLineNumber.foreground'] = ln;
	if(cur) colors['editorCursor.foreground'] = cur;
	if(sel) colors['editor.selectionBackground'] = sel;
	// inherit:true means Monaco keeps all its own syntax token colors
	// We only patch the chrome/background — this is what makes it match the Query Editor
	monaco.editor.defineTheme('vsc',{base,inherit:true,rules:[],colors});
	monaco.editor.setTheme('vsc');
}

let ddlEditor;
require(['vs/editor/editor.main'],()=>{
	applyTheme();
	ddlEditor = monaco.editor.create(document.getElementById('ddlEditor'),{
		value: ${JSON.stringify(ddl)},
		language:'sql',
		theme:'vsc',
		readOnly:true,
		minimap:{enabled:false},
		fontSize:13,
		fontFamily: getVar('--vscode-editor-font-family') || 'Consolas, monospace',
		automaticLayout:true,
		scrollBeyondLastLine:false,
		wordWrap:'on',
		tabSize:2,
		lineNumbers:'on',
		renderLineHighlight:'line',
	});
	new MutationObserver(applyTheme).observe(document.body,{attributes:true,attributeFilter:['class']});
});

// ── Tabs ─────────────────────────────────────────────────────
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

// ── Open in results ───────────────────────────────────────────
document.getElementById('openInResultsBtn').onclick=()=>vscode.postMessage({command:'openInResults'});

// ── FK links ──────────────────────────────────────────────────
document.addEventListener('click',e=>{
	const a=e.target.closest('.fk-link');
	if(a){ vscode.postMessage({command:'openTable',schema:a.dataset.schema,table:a.dataset.table}); }
});

// ── Column search ─────────────────────────────────────────────
document.getElementById('colSearch').addEventListener('input',e=>{
	const q=e.target.value.toLowerCase();
	document.querySelectorAll('#colBody tr').forEach(r=>{
		r.style.display=q&&!r.textContent.toLowerCase().includes(q)?'none':'';
	});
});

// ── Column row selection ──────────────────────────────────────
let selCol = null;

// Single delegated handler for colBody — avoids double-registration bugs
document.getElementById('colBody').addEventListener('click',function(e){
	// ── Inline delete button ──
	const delBtn = e.target.closest('.btn-inline-del');
	if(delBtn){
		e.stopPropagation();
		const col = delBtn.getAttribute('data-col');
		if(col && confirm('Delete column "'+col+'"?\\n\\nAll data in this column will be lost.')){
			vscode.postMessage({command:'deleteColumn',columnName:col});
		}
		return;
	}
	// ── Row selection ──
	const row = e.target.closest('tr[data-col-name]');
	if(!row){ return; }
	document.querySelectorAll('#colBody tr').forEach(r=>r.classList.remove('sel'));
	row.classList.add('sel');
	selCol = row.getAttribute('data-col-name');
	document.getElementById('deleteColBtn').disabled = false;
	document.getElementById('editColBtn').disabled   = false;
});

document.getElementById('deleteColBtn').addEventListener('click',function(){
	if(!selCol){ return; }
	if(confirm('Delete column "'+selCol+'"?\\n\\nAll data in this column will be lost.')){
		vscode.postMessage({command:'deleteColumn',columnName:selCol});
	}
	selCol=null;
	this.disabled=true;
	document.getElementById('editColBtn').disabled=true;
});

document.getElementById('editColBtn').addEventListener('click',function(){
	if(!selCol){ return; }
	// Rename goes through extension host (can't use vscode.window in webview)
	vscode.postMessage({command:'promptRenameColumn',columnName:selCol});
});

// ── Add column modal ──────────────────────────────────────────
document.getElementById('addColBtn').onclick=()=>{
	document.getElementById('addModal').style.display='flex';
	document.getElementById('nc-name').focus();
};
function closeModal(){document.getElementById('addModal').style.display='none';}
document.getElementById('closeModal').onclick=closeModal;
document.getElementById('cancelModal').onclick=closeModal;
document.getElementById('addModal').addEventListener('click',e=>{if(e.target.id==='addModal')closeModal();});
document.getElementById('confirmModal').onclick=()=>{
	const name = document.getElementById('nc-name').value.trim();
	if(!name){alert('Please enter a column name.');return;}
	if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)){alert('Invalid identifier.');return;}
	vscode.postMessage({
		command:'createColumn',
		columnName:name,
		columnType:document.getElementById('nc-type').value,
		notNull:document.getElementById('nc-notnull').checked,
		defaultValue:document.getElementById('nc-default').value.trim()||null,
		comment:document.getElementById('nc-comment').value.trim()||null,
	});
	closeModal();
	document.getElementById('nc-name').value='';
	document.getElementById('nc-default').value='';
	document.getElementById('nc-comment').value='';
	document.getElementById('nc-notnull').checked=false;
};

// ── Data search ───────────────────────────────────────────────
document.getElementById('dataSearch').addEventListener('input',e=>{
	const q=e.target.value.toLowerCase();
	document.querySelectorAll('#dataBody tr').forEach(r=>{
		r.style.display=q&&!r.textContent.toLowerCase().includes(q)?'none':'';
	});
});

// ── Pagination & data loading ─────────────────────────────────
let PAGE_SIZE=1000, CUR=1, TOTAL_PAGES=1, HAS_MORE=false;
let SORT_COL=null, SORT_DIR='ASC', SORT_IDX=null, FIELDS=[];

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
	PAGE_SIZE=parseInt(document.getElementById('dataLimit').value,10)||1000;
	if(SORT_COL && FIELDS.includes(SORT_COL)){
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
	if(SORT_IDX===idx){SORT_DIR=SORT_DIR==='ASC'?'DESC':'ASC';}
	else{SORT_IDX=idx;SORT_DIR='ASC';}
	SORT_COL=FIELDS[idx]||null;
	document.querySelectorAll('#dataTable th.sortable').forEach(h=>h.classList.remove('sorted-asc','sorted-desc'));
	th.classList.add(SORT_DIR==='ASC'?'sorted-asc':'sorted-desc');
	loadPage(1);
});

// Receive data
window.addEventListener('message',e=>{
	const msg=e.data;
	if(msg.command!=='pageData'){return;}
	const tbody=document.getElementById('dataBody');
	const fields=msg.fields;
	if(fields.length>0&&FIELDS.length===0){FIELDS=fields;}
	if(!msg.rows.length){
		tbody.innerHTML='<tr><td colspan="100%" class="empty">No data</td></tr>';
		document.getElementById('rowInfo').textContent='0 rows';
		document.getElementById('dataPag').style.display='none';
		return;
	}
	tbody.innerHTML=msg.rows.map(row=>'<tr>'+fields.map(f=>{
		const v=row[f];
		return v===null?'<td><span class="null-val">NULL</span></td>':'<td title="'+escH(String(v))+'">'+escH(String(v))+'</td>';
	}).join('')+'</tr>').join('');
	HAS_MORE=msg.rows.length>=PAGE_SIZE;
	TOTAL_PAGES=HAS_MORE?CUR+1:CUR;
	const s=(CUR-1)*PAGE_SIZE+1, en=(CUR-1)*PAGE_SIZE+msg.rows.length;
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
});

function escH(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML;}
</script></body></html>`;
	}
}