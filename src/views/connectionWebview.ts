import * as vscode from 'vscode';
import { ConnectionManager, ConnectionConfig } from '../database/connectionManager';
import { PostgreSQLTreeDataProvider } from '../providers/treeDataProvider';
import { ConnectionsTreeProvider } from '../providers/connectionsTreeProvider';
import { ThemeManager } from '../theme/themeManager';

export class ConnectionWebview {
	private static panel: vscode.WebviewPanel | undefined;

	static show(
		context: vscode.ExtensionContext,
		connectionManager: ConnectionManager,
		databaseTreeProvider: PostgreSQLTreeDataProvider,
		connectionsTreeProvider: ConnectionsTreeProvider,
		themeManager: ThemeManager
	) {
		if (this.panel) {
			this.panel.reveal();
		} else {
			this.panel = vscode.window.createWebviewPanel(
				'pgsqlConnection',
				'Add PostgreSQL Connection',
				vscode.ViewColumn.One,
				{ enableScripts: true }
			);
		}

		this.panel.webview.html = this.getHtml(themeManager);
		
		this.panel.webview.onDidReceiveMessage(async (message) => {
			if (message.command === 'addConnection') {
				const config: ConnectionConfig = message.config;
				const success = await connectionManager.addConnection(config);
				if (success) {
					vscode.window.showInformationMessage(`✓ Connected to ${config.name}`);
					databaseTreeProvider.refresh();
					connectionsTreeProvider.refresh();
					this.panel?.dispose();
				}
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
				<style>
					${cssVars}
					
					* { margin: 0; padding: 0; box-sizing: border-box; }
					
					body { 
						font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
						background-color: var(--vscode-background);
						color: var(--vscode-foreground);
						padding: 20px;
					}
					
					h2 {
						margin-bottom: 20px;
						color: var(--vscode-foreground);
						font-size: 18px;
						font-weight: 500;
					}
					
					.form-group { 
						margin-bottom: 15px; 
					}
					
					label { 
						display: block; 
						margin-bottom: 5px; 
						font-weight: 500;
						color: var(--vscode-foreground);
						font-size: 13px;
					}
					
					input { 
						width: 100%; 
						padding: 8px 10px;
						background-color: var(--vscode-input-background);
						color: var(--vscode-input-foreground);
						border: 1px solid var(--vscode-input-border);
						border-radius: 2px;
						box-sizing: border-box;
						font-size: 13px;
						font-family: inherit;
						transition: border-color 0.2s;
					}
					
					input:focus {
						outline: none;
						border-color: var(--vscode-accent);
						box-shadow: 0 0 0 1px var(--vscode-accent);
					}
					
					input::placeholder {
						color: var(--vscode-input-foreground);
						opacity: 0.6;
					}
					
					button { 
						padding: 10px 20px;
						background-color: var(--vscode-button-background);
						color: var(--vscode-button-foreground);
						border: none;
						border-radius: 2px;
						cursor: pointer;
						font-size: 13px;
						font-weight: 500;
						transition: background-color 0.2s;
						width: 100%;
						margin-top: 10px;
					}
					
					button:hover { 
						background-color: var(--vscode-button-hover-background);
					}
					
					button:disabled {
						opacity: 0.6;
						cursor: not-allowed;
					}
					
					button:active:not(:disabled) {
						transform: translateY(1px);
					}
					
					.form-container {
						background-color: var(--vscode-sidebar-background);
						padding: 20px;
						border-radius: 4px;
						border: 1px solid var(--vscode-input-border);
					}

					.success-message {
						background-color: rgba(76, 175, 80, 0.1);
						border-left: 3px solid #4caf50;
						padding: 10px;
						margin-bottom: 15px;
						border-radius: 2px;
						color: #4caf50;
						display: none;
					}

					.success-message.show {
						display: block;
					}
				</style>
			</head>
			<body>
				<div class="form-container">
					<h2>Add PostgreSQL Connection</h2>
					<div class="success-message" id="successMsg">✓ Connection added successfully!</div>
					<form id="connectionForm">
						<div class="form-group">
							<label>Connection Name:</label>
							<input type="text" id="name" placeholder="e.g., production_db" required>
						</div>
						<div class="form-group">
							<label>Host:</label>
							<input type="text" id="host" value="localhost" required>
						</div>
						<div class="form-group">
							<label>Port:</label>
							<input type="number" id="port" value="5432" required>
						</div>
						<div class="form-group">
							<label>Database:</label>
							<input type="text" id="database" placeholder="database_name" required>
						</div>
						<div class="form-group">
							<label>User:</label>
							<input type="text" id="user" placeholder="postgres" required>
						</div>
						<div class="form-group">
							<label>Password:</label>
							<input type="password" id="password" required>
						</div>
						<button type="submit" id="submitBtn">Connect</button>
					</form>
				</div>

				<script>
					const vscode = acquireVsCodeApi();
					const form = document.getElementById('connectionForm');
					const submitBtn = document.getElementById('submitBtn');
					const successMsg = document.getElementById('successMsg');

					form.addEventListener('submit', (e) => {
						e.preventDefault();
						submitBtn.disabled = true;
						submitBtn.textContent = 'Connecting...';

						vscode.postMessage({
							command: 'addConnection',
							config: {
								name: document.getElementById('name').value,
								host: document.getElementById('host').value,
								port: parseInt(document.getElementById('port').value),
								database: document.getElementById('database').value,
								user: document.getElementById('user').value,
								password: document.getElementById('password').value
							}
						});
					});
				</script>
			</body>
			</html>
		`;
	}
}