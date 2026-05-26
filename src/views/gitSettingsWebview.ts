import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { GitConnectionConfig, GitConnectionSettings } from '../git/gitConnectionSettings';

export class GitSettingsWebview {
	private static panel: vscode.WebviewPanel | undefined;

	static show(
		context: vscode.ExtensionContext,
		connectionManager: ConnectionManager,
		gitSettings: GitConnectionSettings,
		onSaved: () => void
	): void {
		if (this.panel) {
			this.panel.reveal();
		} else {
			this.panel = vscode.window.createWebviewPanel(
				'pgsqlGitSettings',
				'Git DDL — настройки',
				vscode.ViewColumn.One,
				{ enableScripts: true, retainContextWhenHidden: true }
			);
		}

		const names = connectionManager.getSavedConnectionNames();
		const rows = names.map((name) => {
			const cfg = gitSettings.get(name);
			return { name, ...cfg };
		});

		this.panel.webview.html = this.getHtml(rows);

		this.panel.webview.onDidReceiveMessage(async (message) => {
			if (message.command === 'close') {
				this.panel?.dispose();
				return;
			}
			if (message.command === 'save') {
				const configs: Record<string, GitConnectionConfig> = {};
				for (const row of message.rows as Array<GitConnectionConfig & { name: string }>) {
					configs[row.name] = {
						repositoryPath: String(row.repositoryPath ?? '').trim(),
						compareEnabled: !!row.compareEnabled,
					};
				}
				await gitSettings.setAll(configs);
				vscode.window.showInformationMessage('Настройки Git DDL сохранены');
				onSaved();
				this.panel?.dispose();
			}
			if (message.command === 'pickFolder') {
				const rowName = String(message.connectionName ?? '');
				const current = gitSettings.get(rowName).repositoryPath;
				const picked = await vscode.window.showOpenDialog({
					canSelectFiles: false,
					canSelectFolders: true,
					canSelectMany: false,
					openLabel: 'Каталог DDL',
					defaultUri: current ? vscode.Uri.file(current) : undefined,
				});
				if (picked?.[0]) {
					this.panel?.webview.postMessage({
						command: 'folderPicked',
						connectionName: rowName,
						path: picked[0].fsPath,
					});
				}
			}
		});

		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
	}

	private static getHtml(
		rows: Array<{ name: string; repositoryPath: string; compareEnabled: boolean }>
	): string {
		const esc = (s: string) =>
			String(s ?? '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;');

		const body =
			rows.length === 0
				? '<p class="empty">Нет сохранённых подключений. Добавьте подключение в дереве PostgreSQL.</p>'
				: rows
						.map(
							(r) => `
		<tr data-name="${esc(r.name)}">
			<td class="conn">${esc(r.name)}</td>
			<td>
				<label class="chk"><input type="checkbox" class="compare" ${r.compareEnabled ? 'checked' : ''} /> Сравнивать с Git</label>
			</td>
			<td class="path-cell">
				<input type="text" class="path" value="${esc(r.repositoryPath)}" placeholder="Путь к каталогу tables/Function/Procedures" />
				<button type="button" class="pick" title="Выбрать папку">…</button>
			</td>
		</tr>`
						)
						.join('');

		return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
*,*::before,*::after{box-sizing:border-box}
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);padding:16px 20px}
h2{font-size:15px;font-weight:600;margin-bottom:8px}
.hint{color:var(--vscode-descriptionForeground);font-size:12px;margin-bottom:16px;line-height:1.45}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid var(--vscode-panel-border);padding:8px 10px;vertical-align:middle}
th{background:var(--vscode-editor-inactiveSelectionBackground);text-align:left;font-size:11px;text-transform:uppercase}
.conn{font-weight:600;white-space:nowrap}
.path-cell{display:flex;gap:6px}
.path{flex:1;min-width:0;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px}
.chk{display:flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px}
button{padding:4px 12px;border:1px solid var(--vscode-button-border);background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-radius:2px;cursor:pointer}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.pick{padding:4px 8px}
.actions{margin-top:16px;display:flex;gap:8px}
.empty{color:var(--vscode-descriptionForeground)}
</style></head>
<body>
<h2>Git DDL по подключениям</h2>
<p class="hint">Для каждого подключения укажите каталог с папками Tables, Function, Procedures. Если сравнение выключено, лишние запросы к БД для Git не выполняются.</p>
<table>
<thead><tr><th>Подключение</th><th>Сравнение</th><th>Каталог Git DDL</th></tr></thead>
<tbody>${body}</tbody>
</table>
<div class="actions">
<button id="save">Сохранить</button>
<button class="secondary" id="cancel">Отмена</button>
</div>
<script>
const vscode = acquireVsCodeApi();
function collectRows(){
	return [...document.querySelectorAll('tbody tr')].map(tr=>({
		name: tr.dataset.name,
		compareEnabled: tr.querySelector('.compare').checked,
		repositoryPath: tr.querySelector('.path').value.trim()
	}));
}
document.getElementById('save').onclick=()=>vscode.postMessage({command:'save',rows:collectRows()});
document.getElementById('cancel').onclick=()=>vscode.postMessage({command:'close'});
document.querySelectorAll('.pick').forEach(btn=>{
	btn.onclick=()=>vscode.postMessage({command:'pickFolder',connectionName:btn.closest('tr').dataset.name});
});
window.addEventListener('message',e=>{
	if(e.data.command==='folderPicked'){
		const tr=document.querySelector('tr[data-name="'+e.data.connectionName+'"]');
		if(tr) tr.querySelector('.path').value=e.data.path;
	}
});
</script>
</body></html>`;
	}
}
