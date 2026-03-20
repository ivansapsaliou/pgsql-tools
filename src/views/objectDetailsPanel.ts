import * as vscode from 'vscode';
import { QueryExecutor, QueryResult } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ThemeManager } from '../theme/themeManager';

export class ObjectDetailsPanel {
	private static currentPanel: vscode.WebviewPanel | undefined;

	static async show(
		context: vscode.ExtensionContext,
		schema: string,
		objectName: string,
		objectType: string,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		themeManager: ThemeManager
	) {
		// Reuse the same panel
		if (this.currentPanel) {
			this.currentPanel.reveal(vscode.ViewColumn.One);
		} else {
			this.currentPanel = vscode.window.createWebviewPanel(
				'pgsqlObjectDetails',
				`${objectName}`,
				vscode.ViewColumn.One,
				{ enableScripts: true }
			);

			this.currentPanel.onDidDispose(() => {
				this.currentPanel = undefined;
			});
		}

		try {
			let html = '';

			if (objectType === 'table') {
				const ddl = await queryExecutor.getTableDDL(schema, objectName);
				const data = await queryExecutor.getTableData(schema, objectName);

				html = this.getTableHtml(themeManager, schema, objectName, ddl, data);
			}

			this.currentPanel.webview.html = html;

		} catch (error) {
			vscode.window.showErrorMessage(`Failed to load object details: ${error}`);
		}
	}

	private static getTableHtml(
		themeManager: ThemeManager,
		schema: string,
		tableName: string,
		ddl: string,
		data: QueryResult
	): string {
		const cssVars = themeManager.getCSSVariables();

		// Generate table rows HTML
		const tableRowsHtml = data.rows.map((row: any) => {
			const cells = data.fields.map((field: any) => {
				const value = row[field.name];
				const displayValue = value === null 
					? '<em style="opacity:0.6">NULL</em>' 
					: this.escapeHtml(String(value));
				return `<td>${displayValue}</td>`;
			}).join('');
			return `<tr>${cells}</tr>`;
		}).join('');

		const tableHeadersHtml = data.fields.map((field: any) => 
			`<th>${field.name}</th>`
		).join('');

		return `
			<!DOCTYPE html>
			<html>
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.min.js"></script>
				<style>
					${cssVars}
					
					* { margin: 0; padding: 0; box-sizing: border-box; }
					
					html, body {
						width: 100%;
						height: 100%;
						font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
					}
					
					body {
						background-color: var(--vscode-background);
						color: var(--vscode-foreground);
						display: flex;
						flex-direction: column;
					}

					.header {
						padding: 12px 15px;
						background-color: var(--vscode-sidebar-background);
						border-bottom: 1px solid var(--vscode-input-border);
						display: flex;
						align-items: center;
						justify-content: space-between;
					}

					.header h2 {
						margin: 0;
						font-size: 14px;
						font-weight: 600;
					}

					.header-info {
						font-size: 11px;
						color: var(--vscode-sidebar-foreground);
						margin-left: 15px;
					}

					.tabs {
						display: flex;
						border-bottom: 1px solid var(--vscode-input-border);
						background-color: var(--vscode-sidebar-background);
						padding: 0 10px;
					}

					.tab {
						padding: 8px 16px;
						cursor: pointer;
						border-bottom: 2px solid transparent;
						color: var(--vscode-sidebar-foreground);
						font-size: 12px;
						font-weight: 500;
						transition: all 0.2s;
						user-select: none;
					}

					.tab:hover {
						background-color: var(--vscode-input-background);
						color: var(--vscode-foreground);
					}

					.tab.active {
						border-bottom-color: var(--vscode-accent);
						color: var(--vscode-accent);
					}

					.content {
						flex: 1;
						overflow: hidden;
						display: flex;
						flex-direction: column;
					}

					.tab-content {
						display: none;
						flex: 1;
						overflow: auto;
					}

					.tab-content.active {
						display: flex;
						flex-direction: column;
					}

					#ddl-editor {
						flex: 1;
						width: 100%;
					}

					.data-table {
						width: 100%;
						border-collapse: collapse;
						background-color: var(--vscode-sidebar-background);
						font-size: 12px;
					}

					.data-table th,
					.data-table td {
						border: 1px solid var(--vscode-input-border);
						padding: 6px 8px;
						text-align: left;
					}

					.data-table th {
						background-color: var(--vscode-input-background);
						font-weight: 600;
						color: var(--vscode-foreground);
						position: sticky;
						top: 0;
					}

					.data-table td {
						color: var(--vscode-foreground);
						word-break: break-word;
						max-width: 300px;
					}

					.data-container {
						overflow: auto;
						flex: 1;
					}

					.no-data {
						padding: 20px;
						text-align: center;
						color: var(--vscode-sidebar-foreground);
						font-size: 13px;
					}
				</style>
			</head>
			<body>
				<div class="header">
					<h2>${tableName}</h2>
					<div class="header-info">
						Schema: <strong>${schema}</strong>
					</div>
				</div>

				<div class="tabs">
					<div class="tab active" data-tab="ddl">DDL</div>
					<div class="tab" data-tab="data">Data (${data.rows.length} rows)</div>
				</div>

				<div class="content">
					<div class="tab-content active" id="ddl-tab">
						<div id="ddl-editor"></div>
					</div>

					<div class="tab-content" id="data-tab">
						<div class="data-container">
							${data.rows.length > 0 ? `
								<table class="data-table">
									<thead>
										<tr>
											${tableHeadersHtml}
										</tr>
									</thead>
									<tbody>
										${tableRowsHtml}
									</tbody>
								</table>
							` : `<div class="no-data">No data in this table</div>`}
						</div>
					</div>
				</div>

				<script>
					require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
					
					let editor;
					const ddlContent = \`${ddl.replace(/`/g, '\\`')}\`;

					require(['vs/editor/editor.main'], function() {
						editor = monaco.editor.create(document.getElementById('ddl-editor'), {
							value: ddlContent,
							language: 'sql',
							theme: 'vs-dark',
							minimap: { enabled: false },
							fontSize: 13,
							tabSize: 2,
							insertSpaces: true,
							wordWrap: 'on',
							readOnly: true
						});
					});

					// Tab switching
					document.querySelectorAll('.tab').forEach(tab => {
						tab.addEventListener('click', (e) => {
							const tabName = e.target.dataset.tab;
							
							// Update active tab
							document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
							e.target.classList.add('active');

							// Update active content
							document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
							document.getElementById(tabName + '-tab').classList.add('active');

							// Refresh editor layout if DDL tab is opened
							if (tabName === 'ddl' && editor) {
								setTimeout(() => editor.layout(), 100);
							}
						});
					});
				</script>
			</body>
			</html>
		`;
	}

	private static escapeHtml(text: string): string {
		const map: { [key: string]: string } = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&#039;'
		};
		return text.replace(/[&<>"']/g, m => map[m]);
	}
}