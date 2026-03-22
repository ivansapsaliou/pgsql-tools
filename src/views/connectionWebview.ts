import * as vscode from 'vscode';
import { ConnectionManager, ConnectionConfig } from '../database/connectionManager';

export class ConnectionWebview {
	private static panel: vscode.WebviewPanel | undefined;

	static show(
		context: vscode.ExtensionContext,
		connectionManager: ConnectionManager,
		onSuccess: () => void
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

		this.panel.webview.html = this.getHtml();

		this.panel.webview.onDidReceiveMessage(async (message) => {
			if (message.command === 'addConnection') {
				const raw = message.config;

				const config: ConnectionConfig = {
					name: raw.name,
					host: raw.host,
					port: parseInt(raw.port),
					database: raw.database,
					user: raw.user,
					password: raw.password,
				};

				// SSH-туннель
				if (raw.sshEnabled) {
					config.ssh = {
						host: raw.sshHost,
						port: parseInt(raw.sshPort) || 22,
						username: raw.sshUser,
						password: raw.sshPassword || undefined,
						privateKey: raw.sshPrivateKey || undefined,
						passphrase: raw.sshPassphrase || undefined,
					};
				}

				const success = await connectionManager.addConnection(config);
				if (success) {
					vscode.window.showInformationMessage(`✓ Connected to ${config.name}`);
					onSuccess();
					this.panel?.dispose();
				} else {
					this.panel?.webview.postMessage({ command: 'connectionError', error: 'Connection failed. Check credentials.' });
				}
			}
		});

		this.panel.onDidDispose(() => { this.panel = undefined; });
	}

	private static getHtml(): string {
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
	*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		padding: 24px;
	}

	h2 {
		font-size: 15px;
		font-weight: 600;
		margin-bottom: 18px;
	}

	h3 {
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--vscode-descriptionForeground);
		margin: 18px 0 10px;
		padding-bottom: 5px;
		border-bottom: 1px solid var(--vscode-panel-border);
	}

	.form-container {
		background: var(--vscode-sideBar-background);
		border: 1px solid var(--vscode-panel-border);
		border-radius: 4px;
		padding: 20px;
		max-width: 520px;
	}

	.form-group { margin-bottom: 12px; }

	label {
		display: block;
		margin-bottom: 4px;
		font-size: 11px;
		font-weight: 600;
		color: var(--vscode-foreground);
		opacity: 0.85;
	}

	input, select {
		width: 100%;
		padding: 5px 8px;
		background: var(--vscode-input-background);
		color: var(--vscode-input-foreground);
		border: 1px solid var(--vscode-input-border);
		font-family: var(--vscode-font-family);
		font-size: 13px;
		border-radius: 2px;
		outline: none;
	}
	input:focus, select:focus { border-color: var(--vscode-focusBorder); }
	input::placeholder { color: var(--vscode-input-placeholderForeground); }

	.row { display: flex; gap: 10px; }
	.row .form-group { flex: 1; }
	.row .form-group.narrow { flex: 0 0 90px; }

	.toggle-row {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		margin: 14px 0 6px;
		user-select: none;
	}
	.toggle-row input[type=checkbox] { width: auto; margin: 0; cursor: pointer; }
	.toggle-row span { font-size: 12px; font-weight: 600; }

	.ssh-block {
		display: none;
		border-left: 2px solid var(--vscode-focusBorder);
		padding-left: 14px;
		margin-top: 8px;
	}
	.ssh-block.visible { display: block; }

	.tab-group { margin-top: 8px; }
	.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
	.tab-btn {
		padding: 5px 14px;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		border-bottom: 2px solid transparent;
		color: var(--vscode-foreground);
		opacity: 0.6;
		background: none;
		border-top: none; border-left: none; border-right: none;
	}
	.tab-btn.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-textLink-foreground); }
	.tab-pane { display: none; }
	.tab-pane.active { display: block; }

	button[type=submit] {
		width: 100%;
		padding: 8px 16px;
		margin-top: 14px;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none;
		border-radius: 2px;
		font-family: var(--vscode-font-family);
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
	}
	button[type=submit]:hover { background: var(--vscode-button-hoverBackground); }
	button[type=submit]:disabled { opacity: 0.5; cursor: not-allowed; }

	.error-msg {
		display: none;
		margin-top: 10px;
		padding: 8px 10px;
		background: var(--vscode-inputValidation-errorBackground);
		border: 1px solid var(--vscode-inputValidation-errorBorder);
		color: var(--vscode-errorForeground);
		font-size: 12px;
		border-radius: 2px;
	}
	.error-msg.show { display: block; }

	.hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
</style>
</head>
<body>
<div class="form-container">
	<h2>Add PostgreSQL Connection</h2>
	<form id="form">

		<!-- ── Основные настройки ── -->
		<div class="form-group">
			<label>Connection Name</label>
			<input type="text" id="name" placeholder="e.g. production_db" required autocomplete="off">
		</div>
		<div class="row">
			<div class="form-group">
				<label>Host</label>
				<input type="text" id="host" value="localhost" required autocomplete="off">
			</div>
			<div class="form-group narrow">
				<label>Port</label>
				<input type="number" id="port" value="5432" required>
			</div>
		</div>
		<div class="form-group">
			<label>Database</label>
			<input type="text" id="database" placeholder="postgres" required autocomplete="off">
		</div>
		<div class="form-group">
			<label>User</label>
			<input type="text" id="user" placeholder="postgres" required autocomplete="off">
		</div>
		<div class="form-group">
			<label>Password</label>
			<input type="password" id="password" autocomplete="new-password">
		</div>

		<!-- ── SSH-туннель ── -->
		<label class="toggle-row" for="sshToggle">
			<input type="checkbox" id="sshToggle">
			<span>🔒 Connect via SSH Tunnel</span>
		</label>

		<div class="ssh-block" id="sshBlock">
			<h3>SSH Server</h3>
			<div class="row">
				<div class="form-group">
					<label>SSH Host</label>
					<input type="text" id="sshHost" placeholder="ssh.example.com" autocomplete="off">
				</div>
				<div class="form-group narrow">
					<label>SSH Port</label>
					<input type="number" id="sshPort" value="22">
				</div>
			</div>
			<div class="form-group">
				<label>SSH Username</label>
				<input type="text" id="sshUser" placeholder="ubuntu" autocomplete="off">
			</div>

			<h3>SSH Authentication</h3>
			<div class="tab-group">
				<div class="tabs">
					<button type="button" class="tab-btn active" data-tab="password">Password</button>
					<button type="button" class="tab-btn" data-tab="key">Private Key</button>
				</div>
				<div class="tab-pane active" id="tab-password">
					<div class="form-group">
						<label>SSH Password</label>
						<input type="password" id="sshPassword" autocomplete="new-password">
					</div>
				</div>
				<div class="tab-pane" id="tab-key">
					<div class="form-group">
						<label>Private Key (PEM content)</label>
						<textarea id="sshPrivateKey" rows="5"
							style="width:100%;padding:5px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;resize:vertical;outline:none;"
							placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"></textarea>
						<div class="hint">Вставьте содержимое файла ~/.ssh/id_rsa или id_ed25519</div>
					</div>
					<div class="form-group">
						<label>Passphrase (if encrypted)</label>
						<input type="password" id="sshPassphrase" autocomplete="new-password">
					</div>
				</div>
			</div>
		</div>

		<button type="submit" id="submitBtn">Connect</button>
		<div class="error-msg" id="errorMsg"></div>
	</form>
</div>

<script>
const vscode = acquireVsCodeApi();

// ── SSH toggle ──
document.getElementById('sshToggle').addEventListener('change', function() {
	document.getElementById('sshBlock').classList.toggle('visible', this.checked);
});

// ── SSH auth tabs ──
document.querySelectorAll('.tab-btn').forEach(btn => {
	btn.addEventListener('click', () => {
		document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
		document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
		btn.classList.add('active');
		document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
	});
});

// ── Submit ──
document.getElementById('form').addEventListener('submit', e => {
	e.preventDefault();
	const submitBtn = document.getElementById('submitBtn');
	const errorMsg = document.getElementById('errorMsg');
	submitBtn.disabled = true;
	submitBtn.textContent = 'Connecting…';
	errorMsg.classList.remove('show');

	const sshEnabled = document.getElementById('sshToggle').checked;

	vscode.postMessage({
		command: 'addConnection',
		config: {
			name:       document.getElementById('name').value.trim(),
			host:       document.getElementById('host').value.trim(),
			port:       document.getElementById('port').value,
			database:   document.getElementById('database').value.trim(),
			user:       document.getElementById('user').value.trim(),
			password:   document.getElementById('password').value,
			sshEnabled,
			sshHost:        sshEnabled ? document.getElementById('sshHost').value.trim() : '',
			sshPort:        sshEnabled ? document.getElementById('sshPort').value : '22',
			sshUser:        sshEnabled ? document.getElementById('sshUser').value.trim() : '',
			sshPassword:    sshEnabled ? document.getElementById('sshPassword').value : '',
			sshPrivateKey:  sshEnabled ? document.getElementById('sshPrivateKey').value.trim() : '',
			sshPassphrase:  sshEnabled ? document.getElementById('sshPassphrase').value : '',
		}
	});
});

window.addEventListener('message', e => {
	if (e.data.command === 'connectionError') {
		const submitBtn = document.getElementById('submitBtn');
		const errorMsg = document.getElementById('errorMsg');
		submitBtn.disabled = false;
		submitBtn.textContent = 'Connect';
		errorMsg.textContent = e.data.error;
		errorMsg.classList.add('show');
	}
});
</script>
</body>
</html>`;
	}
}