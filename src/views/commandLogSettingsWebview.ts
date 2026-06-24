import * as vscode from 'vscode';
import { CommandLogConfig, CommandLogSettings } from '../services/commandLogSettings';

export class CommandLogSettingsWebview {
	private static panel: vscode.WebviewPanel | undefined;

	static show(context: vscode.ExtensionContext, settings: CommandLogSettings): void {
		if (this.panel) {
			this.panel.reveal();
		} else {
			this.panel = vscode.window.createWebviewPanel(
				'pgsqlCommandLogSettings',
				'Command Log — settings',
				vscode.ViewColumn.One,
				{ enableScripts: true, retainContextWhenHidden: true }
			);
		}

		const cfg = settings.get();
		this.panel.webview.html = this.getHtml(cfg);

		this.panel.webview.onDidReceiveMessage(async (message) => {
			if (message.command === 'close') {
				this.panel?.dispose();
				return;
			}
			if (message.command === 'save') {
				const next: CommandLogConfig = {
					enabled: !!message.enabled,
					directory: String(message.directory ?? '').trim(),
					logSelectQueries: !!message.logSelectQueries,
				};
				await settings.set(next);
				vscode.window.showInformationMessage('Command log settings saved');
				this.panel?.dispose();
			}
			if (message.command === 'pickFolder') {
				const current = settings.get().directory;
				const picked = await vscode.window.showOpenDialog({
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					openLabel: 'Log directory',
					defaultUri: current ? vscode.Uri.file(current) : undefined,
				});
				if (picked?.[0]) {
					this.panel?.webview.postMessage({
						command: 'folderPicked',
						path: picked[0].fsPath,
					});
				}
			}
		});

		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
	}

	private static getHtml(cfg: CommandLogConfig): string {
		const esc = (s: string) =>
			String(s ?? '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;');

		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:16px 20px}
h2{font-size:15px;font-weight:600;margin-bottom:8px}
.hint{color:var(--vscode-descriptionForeground);font-size:12px;margin-bottom:16px;line-height:1.45}
.chk{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.path-row{display:flex;gap:6px;align-items:center;margin-top:8px}
.path{flex:1;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px}
button{padding:4px 12px;border:1px solid var(--vscode-button-border);background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-radius:2px;cursor:pointer}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.actions{margin-top:16px;display:flex;gap:8px}
</style></head>
<body>
<h2>Command log</h2>
<p class="hint">Logs SQL queries and extension commands per connection. Files are stored as <code>{directory}/{connection}/{YYYY-MM-DD}.log</code>. SELECT / WITH queries are skipped unless enabled below.</p>
<label class="chk"><input type="checkbox" id="enabled" ${cfg.enabled ? 'checked' : ''} /> Save commands to log</label>
<label class="chk"><input type="checkbox" id="logSelect" ${cfg.logSelectQueries ? 'checked' : ''} /> Log SELECT queries</label>
<label>Log directory</label>
<div class="path-row">
<input type="text" class="path" id="directory" value="${esc(cfg.directory)}" placeholder="Path to log folder" />
<button type="button" id="pick">…</button>
</div>
<div class="actions">
<button id="save">Save</button>
<button class="secondary" id="cancel">Cancel</button>
</div>
<script>
const vscode = acquireVsCodeApi();
document.getElementById('save').onclick=()=>vscode.postMessage({
	command:'save',
	enabled:document.getElementById('enabled').checked,
	logSelectQueries:document.getElementById('logSelect').checked,
	directory:document.getElementById('directory').value.trim()
});
document.getElementById('cancel').onclick=()=>vscode.postMessage({command:'close'});
document.getElementById('pick').onclick=()=>vscode.postMessage({command:'pickFolder'});
window.addEventListener('message',e=>{
	if(e.data.command==='folderPicked'){
		document.getElementById('directory').value=e.data.path;
	}
});
</script>
</body></html>`;
	}
}
