import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';

function escHtml(s: string): string {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface FKRelation {
	source_table: string;
	source_column: string;
	target_table: string;
	target_column: string;
	constraint_name: string;
}

interface ColInfo {
	table_name: string;
	column_name: string;
	data_type: string;
	is_nullable: string;
}

interface PKInfo {
	table_name: string;
	column_name: string;
}

export class ERDPanel {
	private static panels: Map<string, vscode.WebviewPanel> = new Map();

	static async show(
		context: vscode.ExtensionContext,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		connName?: string
	): Promise<void> {
		const activeConn = connName || connectionManager.getActiveConnectionName();
		if (!activeConn) {
			vscode.window.showErrorMessage('No active database connection.');
			return;
		}

		const client = connectionManager.getConnectionByName(activeConn);
		if (!client) {
			vscode.window.showErrorMessage(`Connection "${activeConn}" is not available.`);
			return;
		}

		// Получаем список схем
		const schemasRes = await queryExecutor.executeQueryOnClient(
			client,
			`SELECT schema_name FROM information_schema.schemata
			 WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
			 ORDER BY schema_name`
		);
		const schemaNames = schemasRes.rows.map((r: any) => r.schema_name as string);

		let schemaName = 'public';
		if (schemaNames.length > 1) {
			const picked = await vscode.window.showQuickPick(
				schemaNames.map((s) => ({ label: s })),
				{ title: 'ER Diagram — Select Schema', placeHolder: 'Choose schema' }
			);
			if (!picked) return;
			schemaName = picked.label;
		} else if (schemaNames.length === 1) {
			schemaName = schemaNames[0];
		}

		const panelKey = `erd:${activeConn}:${schemaName}`;
		const existing = this.panels.get(panelKey);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'pgsqlERD',
			`ERD — ${activeConn} / ${schemaName}`,
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		this.panels.set(panelKey, panel);
		panel.onDidDispose(() => this.panels.delete(panelKey));

		// Показываем загрузку
		panel.webview.html = this.loadingHtml(`${activeConn} / ${schemaName}`);

		try {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Generating ER Diagram…', cancellable: false },
				async (progress) => {
					const esc = (s: string) => s.replace(/'/g, "''");

					progress.report({ message: 'Loading tables…' });
					const tablesRes = await queryExecutor.executeQueryOnClient(
						client,
						`SELECT table_name FROM information_schema.tables
						 WHERE table_schema = '${esc(schemaName)}' AND table_type = 'BASE TABLE'
						 ORDER BY table_name`
					);
					const tables = tablesRes.rows.map((r: any) => r.table_name as string);

					if (tables.length === 0) {
						panel.webview.html = this.emptyHtml(schemaName);
						return;
					}

					progress.report({ message: 'Loading columns…' });
					const colsRes = await queryExecutor.executeQueryOnClient(
						client,
						`SELECT table_name, column_name, data_type, is_nullable
						 FROM information_schema.columns
						 WHERE table_schema = '${esc(schemaName)}'
						 ORDER BY table_name, ordinal_position`
					);

					progress.report({ message: 'Loading primary keys…' });
					const pksRes = await queryExecutor.executeQueryOnClient(
						client,
						`SELECT tc.table_name, kcu.column_name
						 FROM information_schema.table_constraints tc
						 JOIN information_schema.key_column_usage kcu
						   ON kcu.constraint_name = tc.constraint_name
						   AND kcu.table_schema = tc.table_schema
						 WHERE tc.constraint_type = 'PRIMARY KEY'
						   AND tc.table_schema = '${esc(schemaName)}'`
					);

					progress.report({ message: 'Loading foreign keys…' });
					const fksRes = await queryExecutor.executeQueryOnClient(
						client,
						`SELECT tc.constraint_name,
						        tc.table_name AS source_table,
						        kcu.column_name AS source_column,
						        ccu.table_name AS target_table,
						        ccu.column_name AS target_column
						 FROM information_schema.table_constraints tc
						 JOIN information_schema.key_column_usage kcu
						   ON kcu.constraint_name = tc.constraint_name
						   AND kcu.table_schema = tc.table_schema
						 JOIN information_schema.constraint_column_usage ccu
						   ON ccu.constraint_name = tc.constraint_name
						 WHERE tc.constraint_type = 'FOREIGN KEY'
						   AND tc.table_schema = '${esc(schemaName)}'
						 ORDER BY tc.table_name, kcu.column_name`
					);

					panel.webview.html = this.buildHtml(
						activeConn,
						schemaName,
						tables,
						colsRes.rows as ColInfo[],
						pksRes.rows as PKInfo[],
						fksRes.rows as FKRelation[]
					);
				}
			);
		} catch (err) {
			vscode.window.showErrorMessage(`ER Diagram failed: ${err}`);
			panel.dispose();
		}
	}

	// ── HTML ──────────────────────────────────────────────────────────────────

	private static loadingHtml(title: string): string {
		return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);">
		<div style="text-align:center;opacity:0.6">
			<div style="font-size:24px;margin-bottom:12px">⏳</div>
			<div>Generating ER Diagram for <strong>${escHtml(title)}</strong>…</div>
		</div></body></html>`;
	}

	private static emptyHtml(schema: string): string {
		return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);">
		<div style="text-align:center;opacity:0.5">
			<div style="font-size:28px;margin-bottom:10px">📭</div>
			<div>No tables found in schema <strong>${escHtml(schema)}</strong></div>
		</div></body></html>`;
	}

	private static buildHtml(
		connName: string,
		schema: string,
		tables: string[],
		columns: ColInfo[],
		pks: PKInfo[],
		fks: FKRelation[]
	): string {
		const pkSet = new Set(pks.map((p) => `${p.table_name}.${p.column_name}`));
		const fkSet = new Set(fks.map((f) => `${f.source_table}.${f.source_column}`));

		// Колонки по таблицам
		const colsByTable = new Map<string, ColInfo[]>();
		for (const t of tables) colsByTable.set(t, []);
		for (const c of columns) colsByTable.get(c.table_name)?.push(c);

		// FK по таблицам
		const fksByTable = new Map<string, FKRelation[]>();
		for (const t of tables) fksByTable.set(t, []);
		for (const fk of fks) fksByTable.get(fk.source_table)?.push(fk);

		// Карточки таблиц
		const tableCards = tables.map((tableName) => {
			const cols = colsByTable.get(tableName) ?? [];
			const refs = fksByTable.get(tableName) ?? [];

			const colRows = cols.map((c) => {
				const isPk = pkSet.has(`${tableName}.${c.column_name}`);
				const isFk = fkSet.has(`${tableName}.${c.column_name}`);
				const badge = isPk
					? `<span class="badge pk" title="Primary Key">PK</span>`
					: isFk
					? `<span class="badge fk" title="Foreign Key">FK</span>`
					: '<span class="badge empty"></span>';
				return `<div class="col-row">
					${badge}
					<span class="col-name">${escHtml(c.column_name)}</span>
					<span class="col-type">${escHtml(c.data_type)}</span>
				</div>`;
			}).join('');

			const refRows = refs.map(
				(fk) =>
					`<div class="ref-row">
						<span class="ref-arrow">→</span>
						<span class="ref-col">${escHtml(fk.source_column)}</span>
						<span class="ref-sep">▶</span>
						<span class="ref-target">${escHtml(fk.target_table)}.${escHtml(fk.target_column)}</span>
					</div>`
			).join('');

			return `<div class="table-card" data-table="${escHtml(tableName)}">
				<div class="table-header">${escHtml(tableName)}</div>
				<div class="table-cols">${colRows}</div>
				${refs.length > 0 ? `<div class="table-refs">${refRows}</div>` : ''}
			</div>`;
		}).join('');

		// Mermaid
		const mermaidLines = ['erDiagram'];
		for (const tableName of tables) {
			const cols = colsByTable.get(tableName) ?? [];
			if (!cols.length) continue;
			mermaidLines.push(`    ${tableName} {`);
			for (const c of cols) {
				const safeName = c.column_name.replace(/\s+/g, '_');
				const safeType = c.data_type.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
				mermaidLines.push(`        ${safeType || 'text'} ${safeName}`);
			}
			mermaidLines.push('    }');
		}
		const seen = new Set<string>();
		for (const fk of fks) {
			const key = `${fk.source_table}||--o{${fk.target_table}`;
			const rev = `${fk.target_table}||--o{${fk.source_table}`;
			if (!seen.has(key) && !seen.has(rev)) {
				seen.add(key);
				const lbl = fk.constraint_name.replace(/"/g, "'");
				mermaidLines.push(`    ${fk.target_table} ||--o{ ${fk.source_table} : "${lbl}"`);
			}
		}
		const mermaidCode = mermaidLines.join('\n');

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
	*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

	:root {
		--border: var(--vscode-panel-border);
		--bg:  var(--vscode-editor-background);
		--bg2: var(--vscode-editorGroupHeader-tabsBackground);
		--fg:  var(--vscode-foreground);
		--fg2: var(--vscode-descriptionForeground);
		--accent: #4d9cf5;
		--pk: #4ec9b0;
		--fk: #d2a22a;
		--font: var(--vscode-font-family);
		--mono: var(--vscode-editor-font-family, monospace);
	}

	html, body {
		width: 100%; height: 100%;
		font-family: var(--font);
		font-size: 13px;
		background: var(--bg);
		color: var(--fg);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/* ── TOOLBAR ── */
	.toolbar {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 12px;
		background: var(--bg2);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}
	.toolbar-title { font-size: 12px; font-weight: 600; flex: 1; }
	.toolbar-meta { font-size: 11px; color: var(--fg2); }
	.btn {
		padding: 3px 10px;
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
		border: none; border-radius: 2px;
		font-size: 11px; cursor: pointer;
	}
	.btn:hover { background: var(--vscode-button-hoverBackground); }

	/* ── TABS ── */
	.tabs {
		display: flex;
		background: var(--bg2);
		border-bottom: 1px solid var(--border);
		padding: 0 4px;
		flex-shrink: 0;
	}
	.tab {
		padding: 6px 14px; font-size: 12px; font-weight: 500;
		cursor: pointer; border-bottom: 2px solid transparent;
		color: var(--fg); opacity: 0.6; user-select: none;
	}
	.tab:hover { opacity: 0.9; }
	.tab.active { opacity: 1; border-bottom-color: var(--accent); color: var(--accent); }

	/* ── CONTENT ── */
	.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
	.tab-pane { display: none; flex: 1; overflow: auto; }
	.tab-pane.active { display: flex; flex-direction: column; }

	/* ── VISUAL CARDS ── */
	#pane-visual { padding: 16px; flex-wrap: wrap; align-content: flex-start; gap: 12px; }

	.table-card {
		border: 1px solid var(--border);
		border-radius: 5px;
		min-width: 180px;
		max-width: 280px;
		overflow: hidden;
		flex-shrink: 0;
		background: var(--bg);
	}

	.table-header {
		background: var(--accent);
		color: #fff;
		padding: 6px 10px;
		font-size: 12px;
		font-weight: 700;
		text-align: center;
	}

	.table-cols { padding: 4px 0; }

	.col-row {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 2px 8px;
		font-size: 11px;
	}
	.col-row:hover { background: var(--vscode-list-hoverBackground); }

	.badge {
		display: inline-block;
		min-width: 20px;
		padding: 0 3px;
		border-radius: 2px;
		font-size: 9px;
		font-weight: 700;
		text-align: center;
		flex-shrink: 0;
	}
	.badge.pk { background: rgba(78,201,176,0.2); color: var(--pk); }
	.badge.fk { background: rgba(210,162,42,0.2); color: var(--fk); }
	.badge.empty { background: transparent; }

	.col-name { font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.col-type { color: var(--fg2); font-style: italic; font-size: 10px; flex-shrink: 0; }

	.table-refs {
		border-top: 1px solid var(--border);
		padding: 4px 8px;
		font-size: 10px;
		color: var(--fg2);
	}
	.ref-row { display: flex; align-items: center; gap: 4px; padding: 1px 0; }
	.ref-arrow { color: var(--fk); }
	.ref-sep { opacity: 0.4; }
	.ref-col { font-family: var(--mono); }
	.ref-target { font-family: var(--mono); color: var(--accent); }

	/* ── MERMAID ── */
	#pane-mermaid {
		padding: 16px;
		flex-direction: column;
		gap: 10px;
	}
	.mermaid-hint {
		font-size: 12px;
		color: var(--fg2);
	}
	.mermaid-hint a { color: var(--accent); }
	.mermaid-code {
		font-family: var(--mono);
		font-size: 12px;
		background: var(--bg2);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 12px;
		white-space: pre;
		overflow: auto;
		flex: 1;
	}
	.copy-bar { display: flex; gap: 8px; align-items: center; }
	.copied { font-size: 11px; color: var(--pk); display: none; }
</style>
</head>
<body>

<div class="toolbar">
	<span class="toolbar-title">ER Diagram — ${escHtml(connName)} / ${escHtml(schema)}</span>
	<span class="toolbar-meta">${tables.length} table(s) · ${fks.length} FK(s)</span>
</div>

<div class="tabs">
	<div class="tab active" data-tab="visual">Visual</div>
	<div class="tab" data-tab="mermaid">Mermaid Code</div>
</div>

<div class="content">
	<div class="tab-pane active" id="pane-visual" style="flex-direction:row;flex-wrap:wrap;align-content:flex-start;">
		${tableCards}
	</div>
	<div class="tab-pane" id="pane-mermaid">
		<div class="copy-bar">
			<button class="btn" onclick="copyMermaid()">Copy to Clipboard</button>
			<span class="copied" id="copiedLabel">✓ Copied!</span>
			<span style="font-size:11px;color:var(--fg2)">
				Paste at <a href="https://mermaid.live" style="color:var(--accent)">mermaid.live</a> for an interactive diagram
			</span>
		</div>
		<pre class="mermaid-code" id="mermaidCode">${escHtml(mermaidCode)}</pre>
	</div>
</div>

<script>
// Tabs
document.querySelectorAll('.tab').forEach(tab => {
	tab.addEventListener('click', () => {
		document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
		document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById('pane-' + tab.dataset.tab).classList.add('active');
	});
});

function copyMermaid() {
	const text = document.getElementById('mermaidCode').textContent || '';
	navigator.clipboard.writeText(text).then(() => {
		const lbl = document.getElementById('copiedLabel');
		lbl.style.display = 'inline';
		setTimeout(() => { lbl.style.display = 'none'; }, 2000);
	});
}
</script>
</body>
</html>`;
	}
}