import * as vscode from 'vscode';
import { QueryExecutor, QueryResult } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ThemeManager } from '../theme/themeManager';

export class QueryEditorPanel {
	private static panel: vscode.WebviewPanel | undefined;
	private static currentQuery: string = '';

	static show(
		context: vscode.ExtensionContext,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		themeManager: ThemeManager
	) {
		if (this.panel) {
			this.panel.reveal();
			return;
		}

		this.panel = vscode.window.createWebviewPanel(
			'pgsqlQuery',
			'PostgreSQL Query',
			vscode.ViewColumn.One,
			{ enableScripts: true }
		);

		this.panel.webview.html = this.getHtml(themeManager);

		this.panel.webview.onDidReceiveMessage(async (message) => {
			if (message.command === 'executeQuery') {
				try {
					const result = await queryExecutor.executeQuery(message.query);
					this.panel?.webview.postMessage({
						command: 'queryResult',
						result: {
							rows: result.rows,
							rowCount: result.rowCount,
							fields: result.fields?.map(f => f.name)
						}
					});
				} catch (error) {
					this.panel?.webview.postMessage({
						command: 'queryError',
						error: error instanceof Error ? error.message : String(error)
					});
				}
			} else if (message.command === 'queryChanged') {
				this.currentQuery = message.query;
			}
		});

		if (this.panel) {
			this.panel.onDidDispose(() => {
				this.panel = undefined;
			});
		}
	}

	private static getHtml(themeManager: ThemeManager): string {
		const cssVars = themeManager.getCSSVariables();
		
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
					
					#editor-container {
						flex: 1;
						border-bottom: 1px solid var(--vscode-input-border);
						position: relative;
						display: flex;
						flex-direction: column;
					}

					.editor-header {
						display: flex;
						align-items: center;
						padding: 8px 10px;
						background-color: var(--vscode-sidebar-background);
						border-bottom: 1px solid var(--vscode-input-border);
						gap: 8px;
						flex-wrap: wrap;
					}

					.editor-body {
						flex: 1;
					}

					.controls { 
						padding: 8px 10px; 
						border-bottom: 1px solid var(--vscode-input-border);
						display: flex; 
						gap: 8px;
						background-color: var(--vscode-sidebar-background);
						align-items: center;
						flex-wrap: wrap;
					}
					
					button { 
						padding: 6px 12px; 
						background-color: var(--vscode-button-background); 
						color: var(--vscode-button-foreground); 
						border: 1px solid transparent;
						border-radius: 2px;
						cursor: pointer;
						font-size: 12px;
						font-weight: 500;
						transition: background-color 0.2s;
						display: flex;
						align-items: center;
						gap: 4px;
						white-space: nowrap;
					}
					
					button:hover { 
						background-color: var(--vscode-button-hoverBackground);
					}

					button:disabled {
						opacity: 0.5;
						cursor: not-allowed;
					}

					button:active:not(:disabled) {
						transform: translateY(1px);
					}
					
					.status-text {
						color: var(--vscode-sidebar-foreground);
						font-size: 12px;
						margin-left: auto;
					}
					
					.results { 
						flex: 1; 
						padding: 10px; 
						overflow: auto;
						background-color: var(--vscode-background);
					}
					
					.results-container {
						display: flex;
						flex-direction: column;
						height: 100%;
					}
					
					table { 
						width: 100%; 
						border-collapse: collapse;
						background-color: var(--vscode-sidebar-background);
						font-size: 12px;
					}
					
					th, td { 
						border: 1px solid var(--vscode-input-border); 
						padding: 6px 8px; 
						text-align: left;
					}
					
					th { 
						background-color: var(--vscode-input-background);
						font-weight: 600;
						color: var(--vscode-foreground);
						position: sticky;
						top: 0;
					}
					
					td {
						color: var(--vscode-foreground);
						word-break: break-word;
						max-width: 300px;
					}
					
					.error { 
						color: var(--vscode-error-foreground); 
						padding: 12px;
						background-color: rgba(248, 113, 113, 0.1);
						border-left: 3px solid var(--vscode-error-foreground);
						border-radius: 2px;
						font-family: monospace;
						font-size: 12px;
						white-space: pre-wrap;
						word-wrap: break-word;
					}
					
					.info { 
						color: var(--vscode-sidebar-foreground); 
						padding: 10px 12px;
						background-color: var(--vscode-input-background);
						border-radius: 2px;
						margin-bottom: 10px;
						font-size: 12px;
					}
					
					.success-info {
						background-color: rgba(76, 175, 80, 0.1);
						border-left: 3px solid #4caf50;
						color: #4caf50;
					}
					
					.no-results {
						text-align: center;
						padding: 30px;
						color: var(--vscode-sidebar-foreground);
						font-size: 13px;
					}

					.connection-info {
						padding: 4px 8px;
						background-color: var(--vscode-input-background);
						border-radius: 2px;
						font-size: 11px;
						color: var(--vscode-sidebar-foreground);
						border: 1px solid var(--vscode-input-border);
					}
				</style>
			</head>
			<body>
				<div id="editor-container">
					<div class="editor-header">
						<button id="executeBtn" style="min-width: 80px;">
							<span>▶</span> Execute
						</button>
						<button id="clearBtn">Clear</button>
						<div class="connection-info" id="connectionInfo">Not connected</div>
						<div class="status-text" id="statusText"></div>
					</div>
					<div class="editor-body"></div>
				</div>

				<div class="results" id="results">
					<div class="no-results">Results will appear here</div>
				</div>

				<script>
					require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
					
					let editor;
					let isExecuting = false;
					const vscode = acquireVsCodeApi();

					require(['vs/editor/editor.main'], function() {
						const container = document.querySelector('.editor-body');
						editor = monaco.editor.create(container, {
							value: 'SELECT * FROM information_schema.tables LIMIT 10;',
							language: 'sql',
							theme: 'vs-dark',
							minimap: { enabled: false },
							fontSize: 13,
							tabSize: 2,
							insertSpaces: true,
							wordWrap: 'on',
							autoClosingBrackets: 'always',
							autoClosingQuotes: 'always',
							formatOnPaste: true,
							suggestOnTriggerCharacters: true,
							quickSuggestions: {
								other: true,
								comments: false,
								strings: false
							}
						});

						// Listen for changes
						editor.onDidChangeModelContent(() => {
							const value = editor.getValue();
							vscode.postMessage({
								command: 'queryChanged',
								query: value
							});
						});

						// Ctrl+Enter to execute
						editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
							executeQuery();
						});
					});

					const executeBtn = document.getElementById('executeBtn');
					const clearBtn = document.getElementById('clearBtn');
					const resultsDiv = document.getElementById('results');
					const statusText = document.getElementById('statusText');

					function executeQuery() {
						if (!editor || isExecuting) return;
						
						const query = editor.getValue().trim();
						if (!query) {
							statusText.textContent = 'Query is empty';
							return;
						}

						isExecuting = true;
						executeBtn.disabled = true;
						executeBtn.textContent = '⟳ Executing...';
						statusText.textContent = 'Executing query...';

						vscode.postMessage({
							command: 'executeQuery',
							query: query
						});
					}

					executeBtn.addEventListener('click', executeQuery);

					clearBtn.addEventListener('click', () => {
						if (editor) {
							editor.setValue('');
							editor.focus();
						}
						resultsDiv.innerHTML = '<div class="no-results">Results will appear here</div>';
						statusText.textContent = '';
					});

					window.addEventListener('message', (event) => {
						const message = event.data;
						isExecuting = false;
						executeBtn.disabled = false;
						executeBtn.textContent = '▶ Execute';
						
						if (message.command === 'queryResult') {
							const result = message.result;
							statusText.textContent = 'Rows: ' + result.rowCount;
							
							let html = '<div class="info success-info">✓ Query executed successfully. Rows returned: ' + result.rowCount + '</div>';
							
							if (result.rows.length > 0) {
								html += '<div class="results-container"><table>';
								html += '<thead><tr>';
								result.fields.forEach(field => {
									html += '<th>' + escapeHtml(field) + '</th>';
								});
								html += '</tr></thead>';
								html += '<tbody>';
								result.rows.forEach(row => {
									html += '<tr>';
									result.fields.forEach(field => {
										const value = row[field];
										let displayValue = value === null ? '<em style="opacity:0.6">NULL</em>' : escapeHtml(String(value));
										html += '<td>' + displayValue + '</td>';
									});
									html += '</tr>';
								});
								html += '</tbody></table></div>';
							} else {
								html += '<div class="no-results">Query executed, but no rows were returned</div>';
							}
							resultsDiv.innerHTML = html;
						} else if (message.command === 'queryError') {
							statusText.textContent = 'Error: ' + message.error;
							resultsDiv.innerHTML = '<div class="error">Error executing query:\\n\\n' + escapeHtml(message.error) + '</div>';
						}
					});

					function escapeHtml(text) {
						const div = document.createElement('div');
						div.textContent = text;
						return div.innerHTML;
					}
				</script>
			</body>
			</html>
		`;
	}
}