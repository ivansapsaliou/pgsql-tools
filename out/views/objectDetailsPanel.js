"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObjectDetailsPanel = void 0;
const vscode = __importStar(require("vscode"));
class ObjectDetailsPanel {
    static async show(context, schema, objectName, objectType, queryExecutor, connectionManager, resultsViewProvider) {
        if (this.currentPanel) {
            this.currentPanel.reveal(vscode.ViewColumn.One);
        }
        else {
            this.currentPanel = vscode.window.createWebviewPanel('pgsqlObjectDetails', objectName, vscode.ViewColumn.One, { enableScripts: true });
            this.currentPanel.onDidDispose(() => {
                this.currentPanel = undefined;
            });
        }
        this.currentSchema = schema;
        this.currentTable = objectName;
        this.currentPanel.title = objectName;
        // Handle messages from webview
        this.currentPanel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'openInResults' && resultsViewProvider) {
                try {
                    const result = await queryExecutor.executeQuery(`SELECT * FROM "${schema}"."${objectName}" LIMIT 1000`);
                    await resultsViewProvider.show({
                        rows: result.rows,
                        columns: result.fields?.map((f) => f.name) || [],
                        rowCount: result.rowCount || 0,
                        originalRows: JSON.parse(JSON.stringify(result.rows)),
                        schema,
                        tableName: objectName
                    }, queryExecutor, connectionManager);
                }
                catch (error) {
                    vscode.window.showErrorMessage(`Failed to open in results: ${error}`);
                }
            }
            else if (message.command === 'openTable') {
                // Navigate to another table (from FK click)
                await ObjectDetailsPanel.show(context, message.schema, message.table, 'table', queryExecutor, connectionManager, resultsViewProvider);
            }
            else if (message.command === 'loadPage') {
                // Pagination: load a new page of data
                try {
                    const pageSize = 100;
                    const offset = (message.page - 1) * pageSize;
                    const result = await queryExecutor.getTableData(schema, objectName, pageSize, offset);
                    this.currentPanel?.webview.postMessage({
                        command: 'pageData',
                        rows: result.rows,
                        fields: result.fields?.map((f) => f.name) || [],
                        page: message.page
                    });
                }
                catch (error) {
                    vscode.window.showErrorMessage(`Failed to load page: ${error}`);
                }
            }
        });
        try {
            if (objectType === 'table') {
                // Load all data in parallel
                const [ddl, data, totalCount, indexes, foreignKeys, constraints] = await Promise.all([
                    queryExecutor.getTableDDL(schema, objectName),
                    queryExecutor.getTableData(schema, objectName, 100, 0),
                    queryExecutor.getTableRowCount(schema, objectName),
                    queryExecutor.getIndexes(schema, objectName),
                    queryExecutor.getForeignKeys(schema, objectName),
                    queryExecutor.getConstraints(schema, objectName)
                ]);
                this.currentPanel.webview.html = this.getHtml(schema, objectName, ddl, data, totalCount, indexes, foreignKeys, constraints);
            }
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to load object details: ${error}`);
        }
    }
    static getHtml(schema, tableName, ddl, data, totalCount, indexes, foreignKeys, constraints) {
        const fieldNames = data.fields?.map((f) => f.name) || [];
        const pageSize = 100;
        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
        const indexesHtml = indexes.length > 0
            ? indexes.map(idx => `
				<tr>
					<td class="monospace">${this.escapeHtml(idx.name)}</td>
					<td>${this.escapeHtml(idx.columns.join(', '))}</td>
					<td>${idx.type}</td>
					<td class="center">${idx.unique ? '<span class="badge badge--yes">✓</span>' : '—'}</td>
					<td class="center">${idx.primary ? '<span class="badge badge--pk">PK</span>' : '—'}</td>
				</tr>`).join('')
            : '<tr><td colspan="5" class="empty-cell">No indexes</td></tr>';
        const outgoing = foreignKeys.filter(fk => fk.direction === 'outgoing');
        const incoming = foreignKeys.filter(fk => fk.direction === 'incoming');
        const fkHtml = (fks, dir) => fks.length > 0
            ? fks.map(fk => `
				<tr>
					<td class="monospace">${this.escapeHtml(fk.constraintName)}</td>
					<td>${this.escapeHtml(fk.columns.join(', '))}</td>
					<td>
						<a class="fk-link" data-schema="${this.escapeHtml(fk.foreignSchema)}" data-table="${this.escapeHtml(fk.foreignTable)}">
							${this.escapeHtml(fk.foreignSchema)}.${this.escapeHtml(fk.foreignTable)}
						</a>
					</td>
					<td>${this.escapeHtml(fk.foreignColumns.join(', '))}</td>
				</tr>`).join('')
            : `<tr><td colspan="4" class="empty-cell">No ${dir} foreign keys</td></tr>`;
        const constraintsHtml = constraints.length > 0
            ? constraints.map(c => `
				<tr>
					<td class="monospace">${this.escapeHtml(c.name)}</td>
					<td><span class="badge badge--${c.type === 'PRIMARY KEY' ? 'pk' : c.type === 'UNIQUE' ? 'uq' : 'ck'}">${this.escapeHtml(c.type)}</span></td>
					<td>${this.escapeHtml(c.columns.join(', '))}</td>
					<td class="monospace small">${c.definition ? this.escapeHtml(c.definition) : '—'}</td>
				</tr>`).join('')
            : '<tr><td colspan="4" class="empty-cell">No constraints</td></tr>';
        // Initial data rows
        const dataRowsHtml = data.rows.map((row) => `
			<tr>
				${fieldNames.map(f => {
            const v = row[f];
            return v === null
                ? '<td><span class="null-val">NULL</span></td>'
                : `<td title="${this.escapeHtml(String(v))}">${this.escapeHtml(String(v))}</td>`;
        }).join('')}
			</tr>`).join('');
        const headerHtml = fieldNames.map(f => `<th>${this.escapeHtml(f)}</th>`).join('');
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
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}

		/* ── HEADER ── */
		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 6px 12px;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
			gap: 8px;
		}

		.header-left { display: flex; align-items: center; gap: 8px; }

		.header-title { font-size: 13px; font-weight: 600; }

		.header-meta {
			font-size: 11px;
			opacity: 0.55;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			padding: 1px 7px;
			border-radius: 10px;
		}

		.btn-open {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 3px 10px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 2px;
			font-family: var(--vscode-font-family);
			font-size: 11px;
			font-weight: 500;
			cursor: pointer;
			height: 22px;
			white-space: nowrap;
		}
		.btn-open:hover { background: var(--vscode-button-hoverBackground); }

		/* ── TABS ── */
		.tabs {
			display: flex;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
			padding: 0 4px;
		}

		.tab {
			padding: 6px 14px;
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
			border-bottom: 2px solid transparent;
			color: var(--vscode-foreground);
			opacity: 0.65;
			user-select: none;
			transition: opacity 0.12s;
			white-space: nowrap;
		}
		.tab:hover { opacity: 0.9; }
		.tab.active {
			opacity: 1;
			border-bottom-color: var(--vscode-focusBorder);
			color: var(--vscode-textLink-foreground);
		}

		.tab-count {
			display: inline-block;
			margin-left: 5px;
			padding: 0 5px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			border-radius: 8px;
			font-size: 10px;
			font-weight: 600;
			vertical-align: middle;
		}

		/* ── CONTENT ── */
		.content {
			flex: 1;
			overflow: hidden;
			display: flex;
			flex-direction: column;
		}

		.tab-pane {
			display: none;
			flex: 1;
			overflow: hidden;
			flex-direction: column;
		}
		.tab-pane.active { display: flex; }

		/* ── DDL ── */
		#ddlEditor { flex: 1; }

		/* ── DATA TAB TOOLBAR ── */
		.data-toolbar {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
			height: 32px;
		}

		.search-wrap {
			position: relative;
			flex: 1;
			max-width: 220px;
		}
		.search-icon {
			position: absolute;
			left: 6px;
			top: 50%;
			transform: translateY(-50%);
			opacity: 0.45;
			font-size: 11px;
			pointer-events: none;
		}
		.search-input {
			width: 100%;
			padding: 3px 8px 3px 22px;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, transparent);
			color: var(--vscode-input-foreground);
			font-family: var(--vscode-font-family);
			font-size: 12px;
			border-radius: 2px;
			outline: none;
			height: 22px;
		}
		.search-input:focus { border-color: var(--vscode-focusBorder); }
		.search-input::placeholder { color: var(--vscode-input-placeholderForeground); }

		.row-count-info {
			font-size: 11px;
			opacity: 0.5;
			margin-left: auto;
		}

		/* ── TABLE SHARED ── */
		.table-scroll {
			flex: 1;
			overflow: auto;
		}

		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}

		thead {
			position: sticky;
			top: 0;
			z-index: 5;
		}

		th {
			padding: 4px 10px;
			text-align: left;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			color: var(--vscode-foreground);
			font-weight: 600;
			font-size: 11px;
			border-bottom: 2px solid var(--vscode-panel-border);
			border-right: 1px solid var(--vscode-panel-border);
			white-space: nowrap;
		}

		td {
			padding: 3px 10px;
			height: 24px;
			border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.08));
			border-right: 1px solid var(--vscode-panel-border);
			max-width: 320px;
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
			vertical-align: middle;
		}

		tr:hover td { background: var(--vscode-list-hoverBackground); }

		.center { text-align: center; }

		.monospace {
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 11px;
		}

		.small { font-size: 10px; }

		.null-val {
			color: var(--vscode-debugTokenExpression-null, #808080);
			font-style: italic;
		}

		.empty-cell {
			text-align: center;
			opacity: 0.45;
			padding: 16px !important;
			font-style: italic;
		}

		/* ── BADGES ── */
		.badge {
			display: inline-block;
			padding: 1px 6px;
			border-radius: 3px;
			font-size: 10px;
			font-weight: 600;
		}
		.badge--pk { background: rgba(86,156,214,0.2); color: #569cd6; }
		.badge--yes { background: rgba(78,201,176,0.2); color: #4ec9b0; }
		.badge--uq { background: rgba(220,220,170,0.2); color: #dcdcaa; }
		.badge--ck { background: rgba(206,145,120,0.2); color: #ce9178; }

		/* ── FK LINK ── */
		.fk-link {
			color: var(--vscode-textLink-foreground);
			cursor: pointer;
			text-decoration: none;
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 11px;
		}
		.fk-link:hover { text-decoration: underline; }

		/* ── SECTION HEADER (inside FK tab) ── */
		.section-header {
			padding: 6px 10px;
			font-size: 11px;
			font-weight: 600;
			opacity: 0.7;
			background: var(--vscode-sideBar-background, var(--vscode-editorGroupHeader-tabsBackground));
			border-bottom: 1px solid var(--vscode-panel-border);
			text-transform: uppercase;
			letter-spacing: 0.05em;
		}

		/* ── PAGINATION ── */
		.pagination {
			display: flex;
			align-items: center;
			gap: 5px;
			padding: 4px 10px;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			border-top: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
			font-size: 11px;
			height: 30px;
		}
		.page-btn {
			background: none;
			border: 1px solid var(--vscode-panel-border);
			color: var(--vscode-foreground);
			cursor: pointer;
			font-size: 11px;
			padding: 1px 7px;
			border-radius: 2px;
			line-height: 1.5;
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
			<span class="header-title">${this.escapeHtml(tableName)}</span>
			<span class="header-meta">schema: ${this.escapeHtml(schema)}</span>
			<span class="header-meta">${totalCount.toLocaleString()} rows</span>
		</div>
		<button class="btn-open" id="openInResultsBtn">↗ Open in Query Results</button>
	</div>

	<div class="tabs">
		<div class="tab active" data-tab="ddl">DDL</div>
		<div class="tab" data-tab="data">Data</div>
		<div class="tab" data-tab="indexes">Indexes <span class="tab-count">${indexes.length}</span></div>
		<div class="tab" data-tab="fk">Foreign Keys <span class="tab-count">${foreignKeys.length}</span></div>
		<div class="tab" data-tab="constraints">Constraints <span class="tab-count">${constraints.length}</span></div>
	</div>

	<div class="content">

		<!-- DDL -->
		<div class="tab-pane active" id="ddl-pane">
			<div id="ddlEditor"></div>
		</div>

		<!-- DATA -->
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

		<!-- INDEXES -->
		<div class="tab-pane" id="indexes-pane">
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th>Columns</th>
							<th>Type</th>
							<th class="center">Unique</th>
							<th class="center">Primary</th>
						</tr>
					</thead>
					<tbody>${indexesHtml}</tbody>
				</table>
			</div>
		</div>

		<!-- FOREIGN KEYS -->
		<div class="tab-pane" id="fk-pane">
			<div class="table-scroll">
				<div class="section-header">Outgoing (this table → other)</div>
				<table>
					<thead>
						<tr>
							<th>Constraint</th>
							<th>Columns</th>
							<th>References</th>
							<th>Referenced Columns</th>
						</tr>
					</thead>
					<tbody>${fkHtml(outgoing, 'outgoing')}</tbody>
				</table>
				<div class="section-header" style="margin-top:1px">Incoming (other → this table)</div>
				<table>
					<thead>
						<tr>
							<th>Constraint</th>
							<th>Referenced Columns</th>
							<th>From Table</th>
							<th>Columns</th>
						</tr>
					</thead>
					<tbody>${fkHtml(incoming, 'incoming')}</tbody>
				</table>
			</div>
		</div>

		<!-- CONSTRAINTS -->
		<div class="tab-pane" id="constraints-pane">
			<div class="table-scroll">
				<table>
					<thead>
						<tr>
							<th>Name</th>
							<th>Type</th>
							<th>Columns</th>
							<th>Definition</th>
						</tr>
					</thead>
					<tbody>${constraintsHtml}</tbody>
				</table>
			</div>
		</div>

	</div>

	<script>
		require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });

		const vscode = acquireVsCodeApi();

		// Monaco theme detection
		function getMonacoTheme() {
			if (document.body.classList.contains('vscode-light')) return 'vs';
			if (document.body.classList.contains('vscode-high-contrast')) return 'hc-black';
			return 'vs-dark';
		}

		let editor;
		const ddlContent = ${JSON.stringify(ddl)};

		require(['vs/editor/editor.main'], () => {
			editor = monaco.editor.create(document.getElementById('ddlEditor'), {
				value: ddlContent,
				language: 'sql',
				theme: getMonacoTheme(),
				minimap: { enabled: false },
				fontSize: 13,
				readOnly: true,
				automaticLayout: true,
				scrollBeyondLastLine: false,
				wordWrap: 'on'
			});

			// Watch for theme changes
			const observer = new MutationObserver(() => {
				monaco.editor.setTheme(getMonacoTheme());
			});
			observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		});

		// ── TAB SWITCHING ──
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

		// ── OPEN IN RESULTS ──
		document.getElementById('openInResultsBtn').addEventListener('click', () => {
			vscode.postMessage({ command: 'openInResults' });
		});

		// ── FK LINKS ──
		document.querySelectorAll('.fk-link').forEach(link => {
			link.addEventListener('click', () => {
				vscode.postMessage({
					command: 'openTable',
					schema: link.dataset.schema,
					table: link.dataset.table
				});
			});
		});

		// ── DATA SEARCH ──
		const dataSearch = document.getElementById('dataSearch');
		if (dataSearch) {
			dataSearch.addEventListener('input', e => {
				const term = e.target.value.toLowerCase();
				document.querySelectorAll('#dataBody tr').forEach(row => {
					row.style.display = term && !row.textContent.toLowerCase().includes(term) ? 'none' : '';
				});
			});
		}

		// ── PAGINATION ──
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
					s.textContent = '…';
					s.style.cssText = 'padding:0 4px;opacity:0.4;font-size:11px';
					container.appendChild(s);
				} else {
					const b = document.createElement('button');
					b.className = 'page-btn' + (p === currentPage ? ' active' : '');
					b.textContent = p;
					b.onclick = () => loadPage(p);
					container.appendChild(b);
				}
			});
			document.getElementById('paginationInfo').textContent = 'Page ' + currentPage + ' of ' + TOTAL_PAGES;
			document.getElementById('prevPage').disabled = currentPage === 1;
			document.getElementById('nextPage').disabled = currentPage === TOTAL_PAGES;
		}

		function loadPage(page) {
			currentPage = page;
			renderPaginationButtons();
			document.getElementById('rowCountInfo').textContent = 'Loading…';
			vscode.postMessage({ command: 'loadPage', page });
		}

		const prevBtn = document.getElementById('prevPage');
		const nextBtn = document.getElementById('nextPage');
		if (prevBtn) prevBtn.onclick = () => { if (currentPage > 1) loadPage(currentPage - 1); };
		if (nextBtn) nextBtn.onclick = () => { if (currentPage < TOTAL_PAGES) loadPage(currentPage + 1); };

		if (TOTAL_PAGES > 1) renderPaginationButtons();

		// ── MESSAGES FROM EXTENSION ──
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
							: '<td title="' + escHtml(String(v)) + '">' + escHtml(String(v)) + '</td>';
					}).join('') + '</tr>'
				).join('');

				// Clear search on page change
				if (dataSearch) dataSearch.value = '';

				const start = (msg.page - 1) * PAGE_SIZE + 1;
				const end = Math.min(msg.page * PAGE_SIZE, TOTAL_COUNT);
				document.getElementById('rowCountInfo').textContent = start + '–' + end + ' of ' + TOTAL_COUNT.toLocaleString() + ' rows';
			}
		});

		function escHtml(t) {
			const d = document.createElement('div');
			d.textContent = t;
			return d.innerHTML;
		}
	</script>
</body>
</html>`;
    }
    static escapeHtml(text) {
        const map = {
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
}
exports.ObjectDetailsPanel = ObjectDetailsPanel;
ObjectDetailsPanel.currentSchema = '';
ObjectDetailsPanel.currentTable = '';
//# sourceMappingURL=objectDetailsPanel.js.map