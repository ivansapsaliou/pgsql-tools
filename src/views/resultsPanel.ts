import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';

export interface QueryResultData {
	rows: any[];
	columns: string[];
	rowCount: number;
	originalRows: any[];
	schema?: string;
	tableName?: string;
}

export interface RichContent {
	type: 'html' | 'json' | 'erd';
	title: string;
	content: string;
}

export class ResultsViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'pgsqlResults';
	private _view?: vscode.WebviewView;
	private currentResults?: QueryResultData;
	private queryExecutor?: QueryExecutor;
	private connectionManager?: ConnectionManager;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
		};

		webviewView.webview.onDidReceiveMessage(async (message) => {
			if (message.command === 'exportCSV') {
				this.exportToCSV();
			} else if (message.command === 'exportJSON') {
				this.exportToJSON();
			}
		});

		this.updateUI();
	}

	public async show(
		results: QueryResultData,
		queryExecutor?: QueryExecutor,
		connectionManager?: ConnectionManager
	) {
		this.currentResults = results;
		this.queryExecutor = queryExecutor;
		this.connectionManager = connectionManager;

		await vscode.commands.executeCommand('pgsqlResults.focus');
		this.updateUI();
	}

	public async showRichContent(payload: RichContent): Promise<void> {
		await vscode.commands.executeCommand('pgsqlResults.focus');
		if (!this._view) return;
		this._view.webview.html = this.getRichHtml(payload);
	}

	private updateUI() {
		if (!this._view || !this.currentResults) return;
		this._view.webview.html = this.getHtml(this.currentResults);
	}

	private exportToCSV() {
		if (!this.currentResults) return;
		const { columns, rows } = this.currentResults;
		const csv = [
			columns.map(c => `"${c}"`).join(','),
			...rows.map(row =>
				columns.map(col => {
					const value = row[col];
					if (value === null) return '""';
					const str = String(value).replace(/"/g, '""');
					return `"${str}"`;
				}).join(',')
			)
		].join('\n');
		this.saveToFile(csv, 'query-results.csv');
	}

	private exportToJSON() {
		if (!this.currentResults) return;
		const json = JSON.stringify(this.currentResults.rows, null, 2);
		this.saveToFile(json, 'query-results.json');
	}

	private async saveToFile(content: string, filename: string) {
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file(filename),
			filters: { 'All Files': ['*'] }
		});
		if (uri) {
			const encoder = new TextEncoder();
			await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
			vscode.window.showInformationMessage(`File saved: ${filename}`);
		}
	}

	private getHtml(results: QueryResultData): string {
		const { columns, rows, rowCount } = results;

		const tableRowsHtml = rows.map((row, rowIndex) => {
			const cells = columns.map(col => {
				const value = row[col];
				const isNull = value === null;
				const displayValue = isNull ? 'NULL' : String(value);
				return `<td class="${isNull ? 'cell--null' : ''}" title="${this.escapeHtml(displayValue)}">
					${isNull ? '<span class="null-val">NULL</span>' : this.escapeHtml(displayValue)}
				</td>`;
			}).join('');
			return `<tr data-row-index="${rowIndex}"><td class="row-num">${rowIndex + 1}</td>${cells}</tr>`;
		}).join('');

		const headerHtml = columns.map(col =>
			`<th class="sortable" data-column="${col}"><span class="th-label">${this.escapeHtml(col)}</span><span class="sort-icon"></span></th>`
		).join('');

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
	*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

	html, body {
		width: 100%; height: 100%;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		background: var(--vscode-panel-background);
		color: var(--vscode-foreground);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 8px;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		border-bottom: 1px solid var(--vscode-panel-border);
		flex-shrink: 0;
		height: 35px;
	}

	.search-wrap {
		position: relative;
		flex: 1;
		max-width: 240px;
	}

	.search-icon {
		position: absolute;
		left: 6px;
		top: 50%;
		transform: translateY(-50%);
		opacity: 0.5;
		pointer-events: none;
		font-size: 11px;
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

	.divider {
		width: 1px;
		height: 16px;
		background: var(--vscode-panel-border);
		flex-shrink: 0;
	}

	.btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		background: var(--vscode-button-secondaryBackground);
		color: var(--vscode-button-secondaryForeground);
		border: none;
		border-radius: 2px;
		cursor: pointer;
		font-family: var(--vscode-font-family);
		font-size: 11px;
		height: 22px;
		white-space: nowrap;
	}
	.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

	.row-meta {
		font-size: 11px;
		opacity: 0.5;
		margin-left: auto;
		white-space: nowrap;
	}

	.table-wrap {
		flex: 1;
		overflow: auto;
		position: relative;
	}

	table {
		width: max-content;
		min-width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}

	thead { position: sticky; top: 0; z-index: 10; }

	th {
		padding: 0 8px;
		height: 26px;
		text-align: left;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		color: var(--vscode-foreground);
		font-weight: 600;
		font-size: 11px;
		border-right: 1px solid var(--vscode-panel-border);
		border-bottom: 2px solid var(--vscode-panel-border);
		white-space: nowrap;
		cursor: pointer;
		user-select: none;
	}
	th:hover { background: var(--vscode-list-hoverBackground); }
	th.sorted { color: var(--vscode-textLink-foreground); }
	th .th-label { vertical-align: middle; }
	th .sort-icon { margin-left: 4px; font-size: 9px; opacity: 0.5; }
	th.sorted .sort-icon { opacity: 1; }

	th.row-num-col, td.row-num {
		width: 40px;
		min-width: 40px;
		text-align: right;
		color: var(--vscode-editorLineNumber-foreground);
		font-size: 10px;
		border-right: 2px solid var(--vscode-panel-border);
		padding-right: 6px;
		cursor: default;
		user-select: none;
		background: var(--vscode-editorGutter-background, var(--vscode-editorGroupHeader-tabsBackground));
	}

	td {
		padding: 2px 8px;
		height: 22px;
		border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, rgba(255,255,255,0.04));
		border-right: 1px solid var(--vscode-panel-border);
		max-width: 320px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		vertical-align: middle;
		font-size: 12px;
	}

	tr:hover td { background: var(--vscode-list-hoverBackground); }
	tr:hover td.row-num { background: var(--vscode-list-hoverBackground); }
	tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }

	.cell--null .null-val, .null-val {
		color: var(--vscode-debugTokenExpression-null, #808080);
		font-style: italic;
	}

	/* ── CONTEXT MENU ── */
	.ctx-menu {
		position: fixed;
		background: var(--vscode-menu-background);
		border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
		border-radius: 2px;
		box-shadow: 0 4px 16px rgba(0,0,0,0.4);
		z-index: 1000;
		min-width: 160px;
		padding: 2px 0;
		display: none;
	}
	.ctx-menu.visible { display: block; }
	.ctx-item {
		padding: 5px 12px;
		font-size: 12px;
		cursor: pointer;
		color: var(--vscode-menu-foreground);
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.ctx-item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
	.ctx-sep { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 2px 0; }

	/* ── PAGINATION ── */
	.pagination {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		border-top: 1px solid var(--vscode-panel-border);
		flex-shrink: 0;
		font-size: 11px;
		height: 28px;
	}
	.page-btn {
		background: none;
		border: 1px solid var(--vscode-panel-border);
		color: var(--vscode-foreground);
		cursor: pointer;
		font-size: 11px;
		padding: 1px 7px;
		border-radius: 2px;
		line-height: 1.4;
	}
	.page-btn:hover:not(:disabled) { background: var(--vscode-list-hoverBackground); }
	.page-btn:disabled { opacity: 0.35; cursor: default; }
	.page-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	.page-info { opacity: 0.7; margin-left: auto; }

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 8px;
		opacity: 0.5;
		font-size: 12px;
	}
	.empty-icon { font-size: 28px; }
</style>
</head>
<body>

<div class="toolbar">
	<div class="search-wrap">
		<span class="search-icon">⌕</span>
		<input class="search-input" id="searchInput" placeholder="Search rows…" autocomplete="off" spellcheck="false">
	</div>
	<div class="divider"></div>
	<button class="btn" id="exportCsvBtn">↓ CSV</button>
	<button class="btn" id="exportJsonBtn">↓ JSON</button>
	<span class="row-meta">${rowCount} rows · ${columns.length} cols</span>
</div>

<div class="table-wrap" id="tableWrap">
	${rowCount > 0 ? `
	<table id="mainTable">
		<thead>
			<tr>
				<th class="row-num-col">#</th>
				${headerHtml}
			</tr>
		</thead>
		<tbody id="tbody">
			${tableRowsHtml}
		</tbody>
	</table>
	` : `
	<div class="empty-state">
		<div class="empty-icon">◫</div>
		<div>No rows returned</div>
	</div>
	`}
</div>

<div class="pagination" id="pagination" style="display:none">
	<button class="page-btn" id="prevBtn">‹</button>
	<span id="pageButtons"></span>
	<button class="page-btn" id="nextBtn">›</button>
	<span class="page-info" id="pageInfo"></span>
</div>

<!-- Context menu -->
<div class="ctx-menu" id="ctxMenu">
	<div class="ctx-item" id="ctxCopyCell">⎘ Copy cell</div>
	<div class="ctx-item" id="ctxCopyRow">⎘ Copy row (TSV)</div>
	<div class="ctx-sep"></div>
	<div class="ctx-item" id="ctxCopyJson">{ } Copy row (JSON)</div>
	<div class="ctx-sep"></div>
	<div class="ctx-item" id="ctxExportCsv">↓ Export as CSV</div>
	<div class="ctx-item" id="ctxExportJson">↓ Export as JSON</div>
</div>

<script>
const vscode = acquireVsCodeApi();

// ── PAGINATION ──────────────────────────────────────────────────
const PAGE_SIZE = 100;
let allRows = Array.from(document.querySelectorAll('#tbody tr'));
let filteredRows = [...allRows];
let currentPage = 1;

function totalPages() { return Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE)); }

function renderPage() {
	const tp = totalPages();
	const start = (currentPage - 1) * PAGE_SIZE;
	const end = start + PAGE_SIZE;

	allRows.forEach(r => r.style.display = 'none');
	filteredRows.slice(start, end).forEach(r => r.style.display = '');

	const pag = document.getElementById('pagination');
	if (filteredRows.length > PAGE_SIZE) {
		pag.style.display = 'flex';
		document.getElementById('prevBtn').disabled = currentPage === 1;
		document.getElementById('nextBtn').disabled = currentPage === tp;
		document.getElementById('pageInfo').textContent =
			\`\${start + 1}–\${Math.min(end, filteredRows.length)} of \${filteredRows.length}\`;

		const container = document.getElementById('pageButtons');
		container.innerHTML = '';
		getPageRange(currentPage, tp).forEach(p => {
			if (p === '…') {
				const s = document.createElement('span');
				s.textContent = '…';
				s.style.cssText = 'padding:0 4px;opacity:0.4;font-size:11px';
				container.appendChild(s);
			} else {
				const b = document.createElement('button');
				b.className = 'page-btn' + (p === currentPage ? ' active' : '');
				b.textContent = p;
				b.onclick = () => { currentPage = p; renderPage(); };
				container.appendChild(b);
			}
		});
	} else {
		pag.style.display = 'none';
	}
}

function getPageRange(cur, total) {
	if (total <= 7) return Array.from({length: total}, (_, i) => i + 1);
	if (cur <= 4) return [1,2,3,4,5,'…',total];
	if (cur >= total - 3) return [1,'…',total-4,total-3,total-2,total-1,total];
	return [1,'…',cur-1,cur,cur+1,'…',total];
}

document.getElementById('prevBtn').onclick = () => { if (currentPage > 1) { currentPage--; renderPage(); } };
document.getElementById('nextBtn').onclick = () => { if (currentPage < totalPages()) { currentPage++; renderPage(); } };

// ── SEARCH ─────────────────────────────────────────────────────
document.getElementById('searchInput').addEventListener('input', e => {
	const term = e.target.value.toLowerCase();
	filteredRows = term
		? allRows.filter(r => r.innerText.toLowerCase().includes(term))
		: [...allRows];
	currentPage = 1;
	renderPage();
});

// ── SORTING ────────────────────────────────────────────────────
let sortCol = null, sortAsc = true;

document.querySelectorAll('th.sortable').forEach(th => {
	th.addEventListener('click', () => {
		const col = th.dataset.column;
		if (sortCol === col) { sortAsc = !sortAsc; }
		else { sortCol = col; sortAsc = true; }

		document.querySelectorAll('th.sortable').forEach(h => {
			h.classList.remove('sorted');
			h.querySelector('.sort-icon').textContent = '';
		});
		th.classList.add('sorted');
		th.querySelector('.sort-icon').textContent = sortAsc ? '▲' : '▼';

		allRows.sort((a, b) => {
			const colIdx = Array.from(th.parentElement.querySelectorAll('th')).indexOf(th);
			const aC = a.querySelectorAll('td')[colIdx];
			const bC = b.querySelectorAll('td')[colIdx];
			const av = aC ? aC.textContent.trim() : '';
			const bv = bC ? bC.textContent.trim() : '';
			const an = parseFloat(av), bn = parseFloat(bv);
			if (!isNaN(an) && !isNaN(bn)) return sortAsc ? an - bn : bn - an;
			return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
		});

		const tbody = document.getElementById('tbody');
		allRows.forEach(r => tbody.appendChild(r));

		const term = document.getElementById('searchInput').value.toLowerCase();
		filteredRows = term ? allRows.filter(r => r.innerText.toLowerCase().includes(term)) : [...allRows];
		renderPage();
	});
});

// ── ROW SELECTION ──────────────────────────────────────────────
let selectedRow = null;
document.getElementById('tableWrap')?.addEventListener('click', e => {
	const row = e.target.closest('tr');
	if (!row || row.tagName !== 'TR' || row.parentElement?.tagName === 'THEAD') return;
	if (selectedRow) selectedRow.classList.remove('selected');
	selectedRow = row;
	row.classList.add('selected');
});

// ── CONTEXT MENU ───────────────────────────────────────────────
const ctxMenu = document.getElementById('ctxMenu');
let ctxTarget = null;

document.getElementById('tableWrap')?.addEventListener('contextmenu', e => {
	const cell = e.target.closest('td:not(.row-num)');
	if (!cell) return;
	e.preventDefault();
	ctxTarget = cell;
	const row = cell.closest('tr');
	if (selectedRow) selectedRow.classList.remove('selected');
	selectedRow = row;
	if (row) row.classList.add('selected');
	ctxMenu.style.left = e.clientX + 'px';
	ctxMenu.style.top = e.clientY + 'px';
	ctxMenu.classList.add('visible');
});

document.addEventListener('click', () => ctxMenu.classList.remove('visible'));
document.addEventListener('keydown', e => { if (e.key === 'Escape') ctxMenu.classList.remove('visible'); });

document.getElementById('ctxCopyCell').onclick = () => {
	if (ctxTarget) navigator.clipboard.writeText(ctxTarget.textContent.trim());
};
document.getElementById('ctxCopyRow').onclick = () => {
	if (!selectedRow) return;
	const cells = Array.from(selectedRow.querySelectorAll('td:not(.row-num)'));
	navigator.clipboard.writeText(cells.map(c => c.textContent.trim()).join('\t'));
};
document.getElementById('ctxCopyJson').onclick = () => {
	if (!selectedRow) return;
	const ths = Array.from(document.querySelectorAll('#mainTable thead th.sortable'));
	const cells = Array.from(selectedRow.querySelectorAll('td:not(.row-num)'));
	const obj = {};
	ths.forEach((th, i) => { if (cells[i]) obj[th.dataset.column] = cells[i].textContent.trim(); });
	navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
};
document.getElementById('ctxExportCsv').onclick = () => vscode.postMessage({ command: 'exportCSV' });
document.getElementById('ctxExportJson').onclick = () => vscode.postMessage({ command: 'exportJSON' });

// Toolbar export buttons
document.getElementById('exportCsvBtn').onclick = () => vscode.postMessage({ command: 'exportCSV' });
document.getElementById('exportJsonBtn').onclick = () => vscode.postMessage({ command: 'exportJSON' });

// ── KEYBOARD ───────────────────────────────────────────────────
document.addEventListener('keydown', e => {
	if (!selectedRow) return;
	if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		e.preventDefault();
		const rows = filteredRows.filter(r => r.style.display !== 'none');
		const idx = rows.indexOf(selectedRow);
		const next = e.key === 'ArrowDown' ? rows[idx + 1] : rows[idx - 1];
		if (next) {
			selectedRow.classList.remove('selected');
			next.classList.add('selected');
			selectedRow = next;
			next.scrollIntoView({ block: 'nearest' });
		}
	}
	if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedRow) {
		const cells = Array.from(selectedRow.querySelectorAll('td:not(.row-num)'));
		navigator.clipboard.writeText(cells.map(c => c.textContent.trim()).join('\t'));
	}
});

renderPage();
</script>
</body>
</html>`;
	}

	private getRichHtml(payload: RichContent): string {
		const { type, title, content } = payload;

		let bodyContent = '';

		if (type === 'json') {
			let prettyJson = content;
			try { prettyJson = JSON.stringify(JSON.parse(content), null, 2); } catch { /* use as-is */ }
			bodyContent = `
				<div class="rich-toolbar">
					<span class="rich-title">${this.escapeHtml(title)}</span>
					<button class="btn" onclick="copyContent()">Copy</button>
				</div>
				<div class="json-wrap">
					<pre id="jsonContent" class="json-content">${this.escapeHtml(prettyJson)}</pre>
				</div>
				<script>
					function copyContent() {
						navigator.clipboard.writeText(document.getElementById('jsonContent').textContent || '').catch(()=>{});
					}
				<\/script>`;
		} else if (type === 'erd') {
			bodyContent = `
				<div class="rich-toolbar">
					<span class="rich-title">${this.escapeHtml(title)}</span>
					<button class="btn" onclick="copyMermaid()">Copy Mermaid</button>
				</div>
				${content}
				<script>
					function copyMermaid() {
						const el = document.getElementById('mermaidCode');
						if (el) navigator.clipboard.writeText(el.textContent || '').catch(()=>{});
					}
				<\/script>`;
		} else {
			bodyContent = `
				<div class="rich-toolbar">
					<span class="rich-title">${this.escapeHtml(title)}</span>
				</div>
				${content}`;
		}

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
	*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
	html, body {
		width: 100%; height: 100%;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		background: var(--vscode-panel-background);
		color: var(--vscode-foreground);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.rich-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		border-bottom: 1px solid var(--vscode-panel-border);
		flex-shrink: 0;
		height: 35px;
	}
	.rich-title { font-weight: 600; font-size: 12px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.btn {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none; padding: 3px 8px; font-size: 11px; cursor: pointer; border-radius: 2px; white-space: nowrap;
	}
	.btn:hover { background: var(--vscode-button-hoverBackground); }
	.json-wrap { flex: 1; overflow: auto; padding: 8px; }
	.json-content { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
	.rich-body { flex: 1; overflow: auto; padding: 8px 12px; }
	.diff-section { margin-bottom: 16px; }
	.diff-section h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 6px 0 4px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 6px; }
	.diff-table { width: 100%; border-collapse: collapse; font-size: 12px; }
	.diff-table th { background: var(--vscode-editorGroupHeader-tabsBackground); padding: 4px 8px; text-align: left; font-weight: 600; border: 1px solid var(--vscode-panel-border); }
	.diff-table td { padding: 3px 8px; border: 1px solid var(--vscode-panel-border); vertical-align: top; word-break: break-word; }
	.diff-added { background: rgba(87,171,90,0.12); color: var(--vscode-gitDecoration-addedResourceForeground, #57ab5a); }
	.diff-removed { background: rgba(229,83,75,0.12); color: var(--vscode-gitDecoration-deletedResourceForeground, #e5534b); }
	.diff-changed { background: rgba(210,153,34,0.12); color: var(--vscode-gitDecoration-modifiedResourceForeground, #d2a22a); }
	.diff-detail-row td { padding: 0 !important; background: var(--vscode-editor-background); }
	.diff-detail-inner { max-height: 400px; overflow: auto; padding: 8px; }
	.diff-code { margin: 0; padding: 4px; font-size: 11px; overflow-x: auto; background: var(--vscode-editor-background); border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); line-height: 1.4; max-height: 350px; overflow-y: auto; }
	.diff-line { padding: 1px 4px; }
	.diff-line-added { background: var(--vscode-diffEditor-insertedTextBackground, #ddffdd); display: block; }
	.diff-line-removed { background: var(--vscode-diffEditor-removedTextBackground, #ffdddd); display: block; }
	.line-added { background: var(--vscode-diffEditor-insertedTextBackground, #ddffdd); }
	.line-removed { background: var(--vscode-diffEditor-removedTextBackground, #ffdddd); }
	.empty-state { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
${bodyContent}
</body>
</html>`;
	}

	private escapeHtml(text: string): string {
		const map: { [key: string]: string } = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
		return text.replace(/[&<>"']/g, m => map[m]);
	}
}