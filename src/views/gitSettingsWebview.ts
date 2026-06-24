import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { GitConnectionConfig, GitConnectionSettings } from '../git/gitConnectionSettings';
import { normalizeCompareKinds } from '../git/gitCompareKinds';

type SettingsRow = GitConnectionConfig & { name: string };

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
		const rows: SettingsRow[] = names.map((name) => {
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
				for (const row of message.rows as SettingsRow[]) {
					configs[row.name] = {
						repositoryPath: String(row.repositoryPath ?? '').trim(),
						compareEnabled: !!row.compareEnabled,
						compareKinds: normalizeCompareKinds(row.compareKinds),
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

	private static getHtml(rows: SettingsRow[]): string {
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
				<label class="chk"><input type="checkbox" class="compare" ${r.compareEnabled ? 'checked' : ''} /> Сравнивать</label>
			</td>
			<td class="kinds">
				<div class="kinds-inner">
					<label class="chk"><input type="checkbox" class="kind-table" ${r.compareKinds.table ? 'checked' : ''} /> Таблицы</label>
					<label class="chk"><input type="checkbox" class="kind-function" ${r.compareKinds.function ? 'checked' : ''} /> Функции</label>
					<label class="chk"><input type="checkbox" class="kind-procedure" ${r.compareKinds.procedure ? 'checked' : ''} /> Процедуры</label>
				</div>
			</td>
			<td class="path-cell">
				<div class="path-wrap">
					<input type="text" class="path" value="${esc(r.repositoryPath)}" placeholder="Путь к каталогу Tables/Function/Procedures" />
					<button type="button" class="pick" title="Выбрать папку">…</button>
				</div>
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
table{width:100%;border-collapse:collapse;table-layout:fixed}
th,td{border:1px solid var(--vscode-panel-border);padding:8px 10px;vertical-align:top}
th{background:var(--vscode-editor-inactiveSelectionBackground);text-align:left;font-size:11px;text-transform:uppercase}
th:nth-child(1),td.conn{width:14%}
th:nth-child(2){width:12%}
th:nth-child(3){width:18%}
th:nth-child(4){width:56%}
.conn{font-weight:600;white-space:nowrap}
.kinds-inner{display:flex;flex-direction:column;gap:4px}
.path-wrap{display:flex;gap:6px;align-items:center;width:100%}
.path{flex:1;min-width:0;width:100%;padding:4px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px}
.chk{display:flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px}
button{padding:4px 12px;border:1px solid var(--vscode-button-border);background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-radius:2px;cursor:pointer}
button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
button.pick{padding:4px 8px;flex-shrink:0}
.actions{margin-top:16px;display:flex;gap:8px}
.empty{color:var(--vscode-descriptionForeground)}
</style></head>
<body>
<h2>Git DDL по подключениям</h2>
<p class="hint">Для каждого подключения укажите каталог с папками Tables, Function, Procedures. Выберите типы объектов для сравнения. Если сравнение выключено, лишние запросы к БД не выполняются.</p>
<table>
<thead><tr><th>Подключение</th><th>Сравнение</th><th>Типы объектов</th><th>Каталог Git DDL</th></tr></thead>
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
		compareKinds: {
			table: tr.querySelector('.kind-table').checked,
			function: tr.querySelector('.kind-function').checked,
			procedure: tr.querySelector('.kind-procedure').checked
		},
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
