import * as vscode from 'vscode';
import { QueryExecutor, QueryResult } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';

export class ObjectDetailsPanel {
	private static currentPanel: vscode.WebviewPanel | undefined;

	static async show(
		context: vscode.ExtensionContext,
		schema: string,
		objectName: string,
		objectType: string,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager
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

			this.currentPanel.onDidDispose(() => {
				this.currentPanel = undefined;
			});
		}

		try {
			if (objectType === 'table') {
				const ddl = await queryExecutor.getTableDDL(schema, objectName);
				const data = await queryExecutor.getTableData(schema, objectName);
				this.currentPanel.webview.html = this.getHtml(schema, objectName, ddl, data);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to load object details: ${error}`);
		}
	}

	private static getHtml(schema: string, tableName: string, ddl: string, data: QueryResult): string {
		const tableRowsHtml = data.rows.map((row: any) => {
			const cells = data.fields.map((field: any) => {
				const value = row[field.name];
				return value === null
					? '<td><span class="null-val">NULL</span></td>'
					: `<td title="${this.escapeHtml(String(value))}">${this.escapeHtml(String(value))}</td>`;
			}).join('');
			return `<tr>${cells}</tr>`;
		}).join('');

		const headerHtml = data.fields.map((f: any) => `<th>${this.escapeHtml(f.name)}</th>`).join('');

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
			font-size: var(--vscode-font-size);
			background: var(--vscode-editor-background);
			color: var(--vscode-foreground);
			display: flex;
			flex-direction: column;
			overflow: hidden;
		}

		.header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 8px 12px;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
		}

		.header-title {
			font-size: 13px;
			font-weight: 600;
		}

		.header-meta {
			font-size: 11px;
			opacity: 0.6;
		}

		.tabs {
			display: flex;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
		}

		.tab {
			padding: 6px 16px;
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
			border-bottom: 2px solid transparent;
			color: var(--vscode-foreground);
			opacity: 0.7;
			user-select: none;
			transition: opacity 0.15s;
		}

		.tab:hover { opacity: 1; }
		.tab.active {
			opacity: 1;
			border-bottom-color: var(--vscode-focusBorder);
			color: var(--vscode-textLink-foreground);
		}

		.content {
			flex: 1;
			overflow: hidden;
			display: flex;
			flex-direction: column;
		}

		.tab-pane {
			display: none;
			flex: 1;
			overflow: auto;
		}

		.tab-pane.active {
			display: flex;
			flex-direction: column;
		}

		#ddlEditor { flex: 1; }

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
			padding: 4px 8px;
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
			padding: 2px 8px;
			height: 22px;
			border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, rgba(128,128,128,0.1));
			border-right: 1px solid var(--vscode-panel-border);
			max-width: 300px;
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
		}

		tr:hover td { background: var(--vscode-list-hoverBackground); }

		.null-val {
			color: var(--vscode-debugTokenExpression-null, #808080);
			font-style: italic;
		}

		.empty {
			display: flex;
			align-items: center;
			justify-content: center;
			height: 80px;
			opacity: 0.5;
			font-size: 12px;
		}
	</style>
</head>
<body>
	<div class="header">
		<span class="header-title">${this.escapeHtml(tableName)}</span>
		<span class="header-meta">schema: ${this.escapeHtml(schema)}</span>
	</div>

	<div class="tabs">
		<div class="tab active" data-tab="ddl">DDL</div>
		<div class="tab" data-tab="data">Data <span style="opacity:0.6">(${data.rows.length} rows)</span></div>
	</div>

	<div class="content">
		<div class="tab-pane active" id="ddl-pane">
			<div id="ddlEditor"></div>
		</div>
		<div class="tab-pane" id="data-pane">
			${data.rows.length > 0 ? `
				<table>
					<thead><tr>${headerHtml}</tr></thead>
					<tbody>${tableRowsHtml}</tbody>
				</table>
			` : '<div class="empty">No data in this table</div>'}
		</div>
	</div>

	<script>
		require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });

		let editor;
		const ddlContent = ${JSON.stringify(ddl)};

		require(['vs/editor/editor.main'], () => {
			editor = monaco.editor.create(document.getElementById('ddlEditor'), {
				value: ddlContent,
				language: 'sql',
				theme: document.body.classList.contains('vscode-light') 
					? 'vs' 
					: document.body.classList.contains('vscode-high-contrast')
						? 'hc-black'
						: 'vs-dark',
				minimap: { enabled: false },
				fontSize: 13,
				readOnly: true,
				automaticLayout: true,
				scrollBeyondLastLine: false,
				wordWrap: 'on'
			});
		});

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
	</script>
</body>
</html>`;
	}

	private static escapeHtml(text: string): string {
		const map: { [key: string]: string } = {
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
		};
		return text.replace(/[&<>"']/g, m => map[m]);
	}
}