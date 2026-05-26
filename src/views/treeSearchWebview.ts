import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	TREE_SEARCH_KIND_ICONS,
	TREE_SEARCH_OBJECT_KINDS,
	type TreeSearchObjectKind,
	type TreeSearchWebviewState,
} from '../search/treeSearchSettings';

export interface TreeSearchWebviewDeps {
	getWebviewState: () => Promise<TreeSearchWebviewState>;
	onFilterChange: (term: string) => void | Promise<void>;
	onToggleObjectType: (kind: TreeSearchObjectKind, enabled: boolean) => void | Promise<void>;
	onToggleSettings: () => void | Promise<void>;
	onToggleSchema: (schema: string, enabled: boolean) => void | Promise<void>;
	onSetAllSchemas: (enabled: boolean) => void | Promise<void>;
}

export class TreeSearchWebviewProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'pgsqlTreeSearch';

	/** Шрифт в resources/fonts (VSIX); fallback — node_modules при F5 без copy:codicons. */
	static resolveCodiconsRoot(extensionUri: vscode.Uri): vscode.Uri {
		const bundledDir = path.join(extensionUri.fsPath, 'resources', 'fonts');
		if (fs.existsSync(path.join(bundledDir, 'codicon.ttf'))) {
			return vscode.Uri.file(bundledDir);
		}
		return vscode.Uri.joinPath(
			extensionUri,
			'node_modules',
			'@vscode',
			'codicons',
			'dist'
		);
	}

	private view?: vscode.WebviewView;

	constructor(
		private extensionUri: vscode.Uri,
		private deps: TreeSearchWebviewDeps
	) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this.view = webviewView;
		const codiconsRoot = TreeSearchWebviewProvider.resolveCodiconsRoot(this.extensionUri);
		const codiconFont = webviewView.webview.asWebviewUri(
			vscode.Uri.joinPath(codiconsRoot, 'codicon.ttf')
		);
		const cspSource = webviewView.webview.cspSource;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [codiconsRoot],
		};
		webviewView.webview.html = this.getHtml(codiconFont, cspSource);

		webviewView.webview.onDidReceiveMessage(async (message) => {
			switch (message.type) {
				case 'filter':
					await this.deps.onFilterChange(String(message.value ?? ''));
					break;
				case 'clear':
					await this.deps.onFilterChange('');
					break;
				case 'toggleType':
					await this.deps.onToggleObjectType(
						message.kind as TreeSearchObjectKind,
						!!message.enabled
					);
					break;
				case 'toggleSettings':
					await this.deps.onToggleSettings();
					break;
				case 'toggleSchema':
					await this.deps.onToggleSchema(String(message.schema ?? ''), !!message.enabled);
					break;
				case 'allSchemas':
					await this.deps.onSetAllSchemas(!!message.enabled);
					break;
			}
		});

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				void this.pushState();
			}
		});

		void this.pushState();
	}

	setFilterValue(value: string): void {
		void this.pushState(value);
	}

	async refreshState(): Promise<void> {
		await this.pushState();
	}

	focusInput(): void {
		this.view?.webview.postMessage({ type: 'focus' });
	}

	private async pushState(filterOverride?: string): Promise<void> {
		if (!this.view) {
			return;
		}
		const state = await this.deps.getWebviewState();
		if (filterOverride !== undefined) {
			state.filterText = filterOverride;
		}
		this.view.webview.postMessage({ type: 'state', state });
	}

	/** Unicode codepoints из @vscode/codicons (без внешнего css — font в webview иначе не грузится). */
	private static codiconGlyphRules(): string {
		const glyphs: Record<string, string> = {
			table: 'ebb7',
			'file-code': 'eae9',
			'symbol-function': 'ea8c',
			'symbol-method': 'ea8c',
			'symbol-numeric': 'ea90',
			'symbol-class': 'eb5b',
			'list-tree': 'eb86',
			zap: 'ea86',
			gear: 'eaf8',
		};
		return Object.entries(glyphs)
			.map(([name, hex]) => `.codicon-${name}:before{content:"\\${hex}"}`)
			.join('');
	}

	private getHtml(codiconFont: vscode.Uri, cspSource: string): string {
		const kindsJson = JSON.stringify(
			TREE_SEARCH_OBJECT_KINDS.map((k) => ({
				kind: k.kind,
				title: k.title,
				icon: TREE_SEARCH_KIND_ICONS[k.kind],
			}))
		);
		const codiconRules = TreeSearchWebviewProvider.codiconGlyphRules();

		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'unsafe-inline';">
<style>
@font-face{
	font-family:codicon;
	font-display:block;
	src:url("${codiconFont}") format("truetype");
}
.codicon{
	font:normal normal normal 14px/1 codicon;
	display:inline-block;
	text-align:center;
	text-decoration:none;
	-webkit-font-smoothing:antialiased;
	-moz-osx-font-smoothing:grayscale;
}
${codiconRules}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
	font-family:var(--vscode-font-family);
	font-size:var(--vscode-font-size);
	color:var(--vscode-foreground);
	background:var(--vscode-sideBar-background);
}
.wrap{padding:2px 8px 6px}
.field{
	display:flex;align-items:center;gap:4px;
	padding:2px 6px 2px 8px;
	background:var(--vscode-input-background);
	border:1px solid var(--vscode-input-border);border-radius:3px;
}
.field:focus-within{
	border-color:var(--vscode-focusBorder);
	outline:1px solid var(--vscode-focusBorder);outline-offset:-1px;
}
.field .ico{color:var(--vscode-input-placeholderForeground);font-size:13px;user-select:none}
.field input{
	flex:1;min-width:0;border:none;outline:none;padding:4px 0;
	background:transparent;color:var(--vscode-input-foreground);font:inherit;
}
.field input::placeholder{color:var(--vscode-input-placeholderForeground)}
.field .clear{
	display:none;width:22px;height:22px;padding:0;border:none;border-radius:2px;
	background:transparent;color:var(--vscode-input-foreground);cursor:pointer;
}
.field .clear:hover{background:var(--vscode-toolbar-hoverBackground)}
.field .clear.on{display:flex;align-items:center;justify-content:center}
.toolbar{
	display:flex;flex-wrap:wrap;align-items:center;gap:2px;margin-top:4px;
}
.type-btn,.gear-btn{
	width:20px;height:20px;min-width:20px;padding:0;
	border:1px solid transparent;border-radius:2px;
	background:transparent;color:var(--vscode-icon-foreground);
	cursor:pointer;display:inline-flex;align-items:center;justify-content:center;
	opacity:0.38;flex:0 0 auto;
}
.type-btn:hover,.gear-btn:hover{
	opacity:0.65;background:var(--vscode-toolbar-hoverBackground);
}
.type-btn.on,.gear-btn.on{
	opacity:1;
	color:var(--vscode-foreground);
	background:var(--vscode-toolbar-activeBackground,var(--vscode-list-activeSelectionBackground));
	border-color:var(--vscode-focusBorder);
}
.type-btn .codicon,.gear-btn .codicon{font-size:14px;width:14px;height:14px;line-height:14px}
.gear-btn{margin-left:2px}
.settings{
	display:none;margin-top:6px;padding-top:6px;
	border-top:1px solid var(--vscode-panel-border);
	max-height:240px;overflow-y:auto;
}
.settings.open{display:block}
.settings-hdr{
	display:flex;align-items:center;justify-content:space-between;
	margin-bottom:6px;font-size:11px;font-weight:600;
	color:var(--vscode-sideBarSectionHeader-foreground);
	text-transform:uppercase;letter-spacing:0.04em;
}
.schema-actions{display:flex;gap:4px}
.schema-actions button{
	font:inherit;font-size:10px;padding:2px 6px;border-radius:2px;cursor:pointer;
	border:1px solid var(--vscode-button-border);
	background:var(--vscode-button-secondaryBackground);
	color:var(--vscode-button-secondaryForeground);
}
.schema-actions button:hover{background:var(--vscode-button-secondaryHoverBackground)}
.schemas{display:flex;flex-direction:column;gap:2px}
.schema-row{
	display:flex;align-items:center;gap:6px;padding:2px 4px;border-radius:2px;cursor:pointer;font-size:12px;
}
.schema-row:hover{background:var(--vscode-list-hoverBackground)}
.schema-row input{accent-color:var(--vscode-focusBorder);cursor:pointer}
.schema-row.off{opacity:0.55}
.settings-empty{font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0}
</style>
</head>
<body>
<div class="wrap">
	<div class="field">
		<span class="ico" aria-hidden="true">⌕</span>
		<input id="q" type="text" autocomplete="off" spellcheck="false"
			placeholder="Поиск (активное подключение)…" />
		<button type="button" class="clear" id="clear" title="Очистить">×</button>
	</div>
	<div class="toolbar" id="toolbar"></div>
	<div class="settings" id="settings">
		<div class="settings-hdr">
			<span>Схемы</span>
			<div class="schema-actions">
				<button type="button" id="schemasAll">Все</button>
				<button type="button" id="schemasNone">Ничего</button>
			</div>
		</div>
		<div class="schemas" id="schemas"></div>
	</div>
</div>
<script>
const KINDS = ${kindsJson};
const vscode = acquireVsCodeApi();
const input = document.getElementById('q');
const clearBtn = document.getElementById('clear');
const toolbarEl = document.getElementById('toolbar');
const settingsEl = document.getElementById('settings');
const schemasEl = document.getElementById('schemas');
let debounce = null;
let ui = null;
let gearBtn = null;

function syncClear(){ clearBtn.classList.toggle('on', !!input.value); }

function postFilter(){
	clearTimeout(debounce);
	debounce = setTimeout(() => vscode.postMessage({ type: 'filter', value: input.value }), 320);
}

function renderToolbar(){
	toolbarEl.innerHTML = '';
	for (const k of KINDS) {
		const on = ui?.objectTypes?.[k.kind] !== false;
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'type-btn' + (on ? ' on' : '');
		btn.title = k.title + (on ? ' — в поиске' : ' — исключено');
		btn.innerHTML = '<i class="codicon codicon-' + k.icon + '" aria-hidden="true"></i>';
		btn.onclick = () => vscode.postMessage({ type: 'toggleType', kind: k.kind, enabled: !on });
		toolbarEl.appendChild(btn);
	}
	gearBtn = document.createElement('button');
	gearBtn.type = 'button';
	gearBtn.className = 'gear-btn' + (ui?.settingsOpen ? ' on' : '');
	gearBtn.title = 'Схемы';
	gearBtn.innerHTML = '<i class="codicon codicon-gear" aria-hidden="true"></i>';
	gearBtn.onclick = () => vscode.postMessage({ type: 'toggleSettings' });
	toolbarEl.appendChild(gearBtn);
}

function renderSchemas(){
	schemasEl.innerHTML = '';
	if (!ui?.connectionName) {
		schemasEl.innerHTML = '<div class="settings-empty">Подключитесь к БД для списка схем</div>';
		return;
	}
	if (!ui.schemas?.length) {
		schemasEl.innerHTML = '<div class="settings-empty">Нет схем</div>';
		return;
	}
	for (const s of ui.schemas) {
		const row = document.createElement('label');
		row.className = 'schema-row' + (s.enabled ? '' : ' off');
		const cb = document.createElement('input');
		cb.type = 'checkbox';
		cb.checked = s.enabled;
		cb.onchange = () => vscode.postMessage({ type: 'toggleSchema', schema: s.name, enabled: cb.checked });
		const span = document.createElement('span');
		span.textContent = s.name;
		row.append(cb, span);
		schemasEl.appendChild(row);
	}
}

function applyState(state){
	ui = state;
	if (state.filterText !== input.value) input.value = state.filterText || '';
	syncClear();
	renderToolbar();
	settingsEl.classList.toggle('open', !!state.settingsOpen);
	renderSchemas();
}

input.addEventListener('input', () => { syncClear(); postFilter(); });
input.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') { input.value = ''; syncClear(); vscode.postMessage({ type: 'clear' }); }
});
clearBtn.addEventListener('click', () => { input.value = ''; syncClear(); vscode.postMessage({ type: 'clear' }); });
document.getElementById('schemasAll').onclick = () => vscode.postMessage({ type: 'allSchemas', enabled: true });
document.getElementById('schemasNone').onclick = () => vscode.postMessage({ type: 'allSchemas', enabled: false });
window.addEventListener('message', (e) => {
	const m = e.data;
	if (m.type === 'state' && m.state) applyState(m.state);
	if (m.type === 'focus') { input.focus(); input.select(); }
});
syncClear();
renderToolbar();
</script>
</body>
</html>`;
	}
}
