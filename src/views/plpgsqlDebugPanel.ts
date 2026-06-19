import * as vscode from 'vscode';
import type { DebugTraceEvent } from '../debug/debugProtocol';
import type { DebugSessionState } from '../debug/debugSession';
import { TraceVariableTracker } from '../debug/traceVariables';

export class PlpgsqlDebugViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'pgsqlPlpgsqlDebug';
	private _view?: vscode.WebviewView;
	private readonly tracker = new TraceVariableTracker();
	private state: DebugSessionState = 'idle';
	private statusText = '';
	private sessionLabel = '';
	private changeCount = 0;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.onDidReceiveMessage((msg) => {
			if (msg.command === 'continue') {
				void vscode.commands.executeCommand('pgsql-tools.debugContinue');
			} else if (msg.command === 'stop') {
				void vscode.commands.executeCommand('pgsql-tools.debugStop');
			} else if (msg.command === 'exportJson') {
				void this.exportJson();
			} else if (msg.command === 'goToLine' && typeof msg.line === 'number') {
				void vscode.commands.executeCommand('pgsql-tools.debugGoToLine', msg.line);
			}
		});
		this.render();
	}

	clear(): void {
		this.tracker.reset();
		this.changeCount = 0;
		this.render();
	}

	initTraceVariables(variableNames: string[]): void {
		this.tracker.reset(variableNames);
		this.changeCount = 0;
		this.render();
	}

	setSessionLabel(label: string): void {
		this.sessionLabel = label;
		this.render();
	}

	setState(state: DebugSessionState, detail?: string): void {
		this.state = state;
		this.statusText = detail ?? state;
		this.render();
	}

	addTrace(event: DebugTraceEvent): void {
		if (event.type === 'error') {
			return;
		}
		const time = new Date().toLocaleTimeString();
		const added = this.tracker.applyVars(event.line, time, event.vars);
		this.changeCount += added;
		this.render();
	}

	async focus(): Promise<void> {
		await vscode.commands.executeCommand('pgsqlPlpgsqlDebug.focus');
	}

	private async exportJson(): Promise<void> {
		const uri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.file('plpgsql-trace.json'),
			filters: { JSON: ['json'] },
		});
		if (!uri) {
			return;
		}
		const encoder = new TextEncoder();
		await vscode.workspace.fs.writeFile(
			uri,
			encoder.encode(JSON.stringify(this.tracker.getOrderedEntries(), null, 2))
		);
		vscode.window.showInformationMessage('Трассировка экспортирована');
	}

	private render(): void {
		if (!this._view) {
			return;
		}
		this._view.webview.html = this.getHtml();
	}

	private getHtml(): string {
		const entries = this.tracker.getOrderedEntries();
		const rowsHtml = entries
			.map((entry) => {
				const current = entry.current ?? '—';
				const history =
					entry.changes.length === 0
						? '<span class="muted">без изменений</span>'
						: entry.changes
								.map((ch) => {
									const lineBtn =
										ch.line > 0
											? `<button type="button" class="line-link" data-line="${ch.line}" title="Перейти к строке DDL">${ch.line}</button>`
											: '—';
									const prev = esc(ch.previous ?? 'NULL');
									const val = esc(ch.value);
									return `<div class="chg">${lineBtn} <span class="time">${esc(
										ch.time
									)}</span> <span class="val">${prev} → ${val}</span></div>`;
								})
								.join('');
				return `<tr><td class="param">${esc(entry.name)}</td><td class="current">${esc(
					current
				)}</td><td class="history">${history}</td></tr>`;
			})
			.join('');

		const canContinue = this.state === 'paused';
		const running = this.state === 'running' || this.state === 'paused';
		const label = this.sessionLabel ? esc(this.sessionLabel) + ' · ' : '';

		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
background:var(--vscode-panel-background);color:var(--vscode-foreground);display:flex;flex-direction:column}
.toolbar{display:flex;gap:6px;padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);align-items:center;flex-wrap:wrap}
.toolbar button{padding:4px 10px;cursor:pointer;background:var(--vscode-button-background);
color:var(--vscode-button-foreground);border:none;border-radius:2px;font-size:12px}
.toolbar button:disabled{opacity:0.5;cursor:default}
.status{flex:1;font-size:12px;color:var(--vscode-descriptionForeground)}
.table-wrap{flex:1;overflow:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border);text-align:left;vertical-align:top}
th{position:sticky;top:0;background:var(--vscode-editor-background);z-index:1}
.param{font-weight:600;font-family:var(--vscode-editor-font-family)}
.current{font-family:var(--vscode-editor-font-family);white-space:pre-wrap;word-break:break-all}
.history{font-family:var(--vscode-editor-font-family)}
.chg{margin-bottom:4px}
.chg:last-child{margin-bottom:0}
.time{color:var(--vscode-descriptionForeground);font-size:11px;margin:0 4px}
.val{white-space:pre-wrap;word-break:break-all}
.muted{color:var(--vscode-descriptionForeground);font-style:italic}
.hint{padding:8px;font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.4}
.line-link{background:none;border:none;color:var(--vscode-textLink-foreground);cursor:pointer;
font-weight:600;text-decoration:underline;padding:0;font-size:inherit}
.line-link:hover{color:var(--vscode-textLink-activeForeground)}
</style></head><body>
<div class="toolbar">
  <button id="btnContinue" ${canContinue ? '' : 'disabled'}>Continue</button>
  <button id="btnStop" ${running ? '' : 'disabled'}>Stop</button>
  <button id="btnExport">Export JSON</button>
  <span class="status">${label}${esc(this.statusText)} · ${this.changeCount} изменений</span>
</div>
<div class="hint">По одной строке на параметр. В «Изменения» — только моменты, когда значение изменилось (клик по номеру строки → переход в DDL).</div>
<div class="table-wrap">
<table>
<thead><tr><th>Параметр</th><th>Текущее</th><th>Изменения</th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan="3" style="text-align:center;padding:16px">Нет параметров — нажмите Запустить в правой панели</td></tr>'}</tbody>
</table>
</div>
<script>
const vscode = acquireVsCodeApi();
document.getElementById('btnContinue')?.addEventListener('click', () => vscode.postMessage({ command: 'continue' }));
document.getElementById('btnStop')?.addEventListener('click', () => vscode.postMessage({ command: 'stop' }));
document.getElementById('btnExport')?.addEventListener('click', () => vscode.postMessage({ command: 'exportJson' }));
document.querySelectorAll('.line-link').forEach(btn => {
  btn.addEventListener('click', () => {
    const line = parseInt(btn.getAttribute('data-line'), 10);
    if (!isNaN(line)) vscode.postMessage({ command: 'goToLine', line });
  });
});
</script>
</body></html>`;
	}
}

function esc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
