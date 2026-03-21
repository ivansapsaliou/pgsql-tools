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
exports.QueryEditorPanel = void 0;
const vscode = __importStar(require("vscode"));
class QueryEditorPanel {
    static show(context, queryExecutor, connectionManager) {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        this.panel = vscode.window.createWebviewPanel('pgsqlQuery', 'PostgreSQL Query', vscode.ViewColumn.One, { enableScripts: true });
        this.panel.webview.html = this.getHtml(connectionManager.getActiveConnectionName());
        this.panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'executeQuery') {
                try {
                    const result = await queryExecutor.executeQuery(message.query);
                    this.panel?.webview.postMessage({
                        command: 'queryResult',
                        result: {
                            rows: result.rows,
                            rowCount: result.rowCount,
                            fields: result.fields?.map((f) => f.name)
                        }
                    });
                }
                catch (error) {
                    this.panel?.webview.postMessage({
                        command: 'queryError',
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }
            else if (message.command === 'queryChanged') {
                this.currentQuery = message.query;
            }
        });
        if (this.panel) {
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
        }
    }
    static getHtml(connectionName) {
        return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
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

		.toolbar {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
			height: 35px;
		}

		.btn {
			display: flex;
			align-items: center;
			gap: 4px;
			padding: 2px 10px;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			border-radius: 2px;
			font-family: var(--vscode-font-family);
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
			height: 22px;
			white-space: nowrap;
		}
		.btn:hover { background: var(--vscode-button-hoverBackground); }
		.btn:disabled { opacity: 0.5; cursor: not-allowed; }

		.btn-secondary {
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

		.connection-badge {
			padding: 2px 8px;
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			border-radius: 10px;
			font-size: 11px;
			font-weight: 500;
		}

		.status {
			margin-left: auto;
			font-size: 11px;
			opacity: 0.6;
		}

		.editor-wrap {
			flex: 1;
			min-height: 0;
			position: relative;
		}

		#monacoEditor {
			width: 100%;
			height: 100%;
		}

		.results-wrap {
			height: 40%;
			min-height: 80px;
			border-top: 1px solid var(--vscode-panel-border);
			overflow: auto;
			background: var(--vscode-editor-background);
		}

		.results-placeholder {
			display: flex;
			align-items: center;
			justify-content: center;
			height: 100%;
			opacity: 0.4;
			font-size: 12px;
		}

		.results-info {
			padding: 6px 10px;
			font-size: 11px;
			background: var(--vscode-editorGroupHeader-tabsBackground);
			border-bottom: 1px solid var(--vscode-panel-border);
			color: var(--vscode-foreground);
			opacity: 0.8;
		}

		.results-info.error {
			color: var(--vscode-errorForeground);
			background: var(--vscode-inputValidation-errorBackground);
		}

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
			font-size: 12px;
		}

		tr:hover td { background: var(--vscode-list-hoverBackground); }

		.null-val {
			color: var(--vscode-debugTokenExpression-null, #808080);
			font-style: italic;
		}

		.resizer {
			height: 4px;
			background: transparent;
			cursor: ns-resize;
			flex-shrink: 0;
			border-top: 1px solid var(--vscode-panel-border);
		}
		.resizer:hover { background: var(--vscode-focusBorder); }
	</style>
</head>
<body>
	<div class="toolbar">
		<button class="btn" id="executeBtn">▶ Execute</button>
		<button class="btn btn-secondary" id="clearBtn">Clear</button>
		${connectionName ? `<span class="connection-badge">⬤ ${connectionName}</span>` : '<span class="connection-badge" style="opacity:0.5">Not connected</span>'}
		<span class="status" id="status"></span>
	</div>

	<div class="editor-wrap">
		<div id="monacoEditor"></div>
	</div>

	<div class="resizer" id="resizer"></div>

	<div class="results-wrap" id="resultsWrap">
		<div class="results-placeholder">Execute a query to see results</div>
	</div>

	<script>
		require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });

		const vscode = acquireVsCodeApi();
		let editor, isExecuting = false;

		require(['vs/editor/editor.main'], () => {
			editor = monaco.editor.create(document.getElementById('monacoEditor'), {
				value: '',
				language: 'sql',
				theme: document.body.classList.contains('vscode-light') ? 'vs' : 'vs-dark',
				minimap: { enabled: false },
				fontSize: 13,
				tabSize: 2,
				wordWrap: 'on',
				scrollBeyondLastLine: false,
				automaticLayout: true,
				quickSuggestions: { other: true, comments: false, strings: false },
				suggestOnTriggerCharacters: true
			});

			editor.onDidChangeModelContent(() => {
				vscode.postMessage({ command: 'queryChanged', query: editor.getValue() });
			});

			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, executeQuery);
		});

		function executeQuery() {
			if (!editor || isExecuting) return;
			const query = editor.getValue().trim();
			if (!query) return;

			isExecuting = true;
			document.getElementById('executeBtn').disabled = true;
			document.getElementById('executeBtn').textContent = '⟳ Running…';
			document.getElementById('status').textContent = '';

			vscode.postMessage({ command: 'executeQuery', query });
		}

		document.getElementById('executeBtn').addEventListener('click', executeQuery);
		document.getElementById('clearBtn').addEventListener('click', () => {
			editor?.setValue('');
			document.getElementById('resultsWrap').innerHTML = '<div class="results-placeholder">Execute a query to see results</div>';
			document.getElementById('status').textContent = '';
		});

		// Resize handle
		const resizer = document.getElementById('resizer');
		const resultsWrap = document.getElementById('resultsWrap');
		let isResizing = false, startY = 0, startH = 0;

		resizer.addEventListener('mousedown', e => {
			isResizing = true;
			startY = e.clientY;
			startH = resultsWrap.offsetHeight;
			document.body.style.cursor = 'ns-resize';
		});

		document.addEventListener('mousemove', e => {
			if (!isResizing) return;
			const delta = startY - e.clientY;
			resultsWrap.style.height = Math.max(60, startH + delta) + 'px';
		});

		document.addEventListener('mouseup', () => {
			isResizing = false;
			document.body.style.cursor = '';
		});

		function escapeHtml(t) {
			const d = document.createElement('div');
			d.textContent = t;
			return d.innerHTML;
		}

		window.addEventListener('message', e => {
			const msg = e.data;
			isExecuting = false;
			document.getElementById('executeBtn').disabled = false;
			document.getElementById('executeBtn').textContent = '▶ Execute';

			if (msg.command === 'queryResult') {
				const { rows, rowCount, fields } = msg.result;
				document.getElementById('status').textContent = rowCount + ' rows';

				let html = '<div class="results-info">✓ ' + rowCount + ' rows returned</div>';

				if (rows.length > 0) {
					html += '<table><thead><tr>';
					fields.forEach(f => { html += '<th>' + escapeHtml(f) + '</th>'; });
					html += '</tr></thead><tbody>';
					rows.forEach(row => {
						html += '<tr>';
						fields.forEach(f => {
							const v = row[f];
							html += v === null
								? '<td><span class="null-val">NULL</span></td>'
								: '<td title="' + escapeHtml(String(v)) + '">' + escapeHtml(String(v)) + '</td>';
						});
						html += '</tr>';
					});
					html += '</tbody></table>';
				} else {
					html += '<div class="results-placeholder">Query executed — no rows returned</div>';
				}

				document.getElementById('resultsWrap').innerHTML = html;

			} else if (msg.command === 'queryError') {
				document.getElementById('status').textContent = 'Error';
				document.getElementById('resultsWrap').innerHTML =
					'<div class="results-info error">✕ ' + escapeHtml(msg.error) + '</div>';
			}
		});
	</script>
</body>
</html>`;
    }
}
exports.QueryEditorPanel = QueryEditorPanel;
QueryEditorPanel.currentQuery = '';
//# sourceMappingURL=queryEditorPanel.js.map