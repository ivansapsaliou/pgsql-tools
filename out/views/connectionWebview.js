"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionWebview = void 0;
const vscode = __importStar(require("vscode"));
class ConnectionWebview {
    static show(context, connectionManager, databaseTreeProvider, connectionsTreeProvider) {
        if (this.panel) {
            this.panel.reveal();
        }
        else {
            this.panel = vscode.window.createWebviewPanel('pgsqlConnection', 'Add PostgreSQL Connection', vscode.ViewColumn.One, { enableScripts: true });
        }
        this.panel.webview.html = this.getHtml();
        this.panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'addConnection') {
                const config = message.config;
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
    static getHtml() {
        return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
			font-size: 16px;
			font-weight: 600;
			margin-bottom: 20px;
			color: var(--vscode-foreground);
		}

		.form-container {
			background: var(--vscode-sideBar-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			padding: 20px;
			max-width: 480px;
		}

		.form-group {
			margin-bottom: 14px;
		}

		label {
			display: block;
			margin-bottom: 5px;
			font-size: 12px;
			font-weight: 600;
			color: var(--vscode-foreground);
			opacity: 0.9;
		}

		input {
			width: 100%;
			padding: 6px 8px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			font-family: var(--vscode-font-family);
			font-size: 13px;
			border-radius: 2px;
			outline: none;
			transition: border-color 0.15s;
		}

		input:focus {
			border-color: var(--vscode-focusBorder);
		}

		input::placeholder {
			color: var(--vscode-input-placeholderForeground);
		}

		.row {
			display: flex;
			gap: 10px;
		}

		.row .form-group { flex: 1; }
		.row .form-group:last-child { flex: 0 0 100px; }

		button {
			width: 100%;
			padding: 8px 16px;
			margin-top: 6px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 2px;
			font-family: var(--vscode-font-family);
			font-size: 13px;
			font-weight: 500;
			cursor: pointer;
			transition: background 0.15s;
		}

		button:hover { background: var(--vscode-button-hoverBackground); }
		button:disabled { opacity: 0.5; cursor: not-allowed; }

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
	</style>
</head>
<body>
	<div class="form-container">
		<h2>Add PostgreSQL Connection</h2>
		<form id="form">
			<div class="form-group">
				<label>Connection Name</label>
				<input type="text" id="name" placeholder="e.g. production_db" required autocomplete="off">
			</div>
			<div class="row">
				<div class="form-group">
					<label>Host</label>
					<input type="text" id="host" value="localhost" required autocomplete="off">
				</div>
				<div class="form-group">
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
			<button type="submit" id="submitBtn">Connect</button>
			<div class="error-msg" id="errorMsg"></div>
		</form>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		const form = document.getElementById('form');
		const submitBtn = document.getElementById('submitBtn');
		const errorMsg = document.getElementById('errorMsg');

		form.addEventListener('submit', e => {
			e.preventDefault();
			submitBtn.disabled = true;
			submitBtn.textContent = 'Connecting…';
			errorMsg.classList.remove('show');

			vscode.postMessage({
				command: 'addConnection',
				config: {
					name: document.getElementById('name').value.trim(),
					host: document.getElementById('host').value.trim(),
					port: parseInt(document.getElementById('port').value),
					database: document.getElementById('database').value.trim(),
					user: document.getElementById('user').value.trim(),
					password: document.getElementById('password').value
				}
			});
		});

		window.addEventListener('message', e => {
			if (e.data.command === 'connectionError') {
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
exports.ConnectionWebview = ConnectionWebview;
//# sourceMappingURL=connectionWebview.js.map