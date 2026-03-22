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
interface ColInfo   { table_name: string; column_name: string; data_type: string; is_nullable: string; }
interface PKInfo    { table_name: string; column_name: string; }

// ─── Весь граф схемы — грузим один раз ───────────────────────
interface SchemaData {
	allTables : string[];
	allColumns: ColInfo[];
	allPks    : PKInfo[];
	allFks    : FKRelation[];
}

export class ERDPanel {
	private static panels: Map<string, vscode.WebviewPanel> = new Map();

	// ── Точка входа ── полная схема ─────────────────────────────
	static async show(
		context: vscode.ExtensionContext,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		connName?: string,
		focusTable?: string          // если задано — запуск в режиме "от таблицы"
	): Promise<void> {
		const activeConn = connName || connectionManager.getActiveConnectionName();
		if (!activeConn) { vscode.window.showErrorMessage('No active database connection.'); return; }

		const client = connectionManager.getConnectionByName(activeConn);
		if (!client) { vscode.window.showErrorMessage(`Connection "${activeConn}" is not available.`); return; }

		// ── Выбор схемы ──────────────────────────────────────────
		const schemasRes = await queryExecutor.executeQueryOnClient(client,
			`SELECT schema_name FROM information_schema.schemata
			 WHERE schema_name NOT LIKE 'pg_%' AND schema_name <> 'information_schema'
			 ORDER BY schema_name`);
		const schemaNames = schemasRes.rows.map((r: any) => r.schema_name as string);

		let schemaName = 'public';
		if (schemaNames.length > 1) {
			const picked = await vscode.window.showQuickPick(
				schemaNames.map(s => ({ label: s })),
				{ title: 'ER Diagram — Select Schema' });
			if (!picked) return;
			schemaName = picked.label;
		} else if (schemaNames.length === 1) { schemaName = schemaNames[0]; }

		// ── Режим: полная / от таблицы ───────────────────────────
		let mode: 'full' | 'focused' = 'full';
		let rootTable = focusTable;
		let maxDepth  = 1;

		if (!rootTable) {
			// Предлагаем выбрать режим
			const modeItem = await vscode.window.showQuickPick([
				{ label: '$(type-hierarchy) Full Schema',     description: 'Show all tables', value: 'full'    },
				{ label: '$(search)          From Table…',   description: 'Start from a specific table with depth control', value: 'focused' },
			], { title: 'ER Diagram — Mode' });
			if (!modeItem) return;
			mode = modeItem.value as 'full' | 'focused';
		} else {
			mode = 'focused';
		}

		if (mode === 'focused') {
			// Список таблиц для выбора
			if (!rootTable) {
				const tablesRes = await queryExecutor.executeQueryOnClient(client,
					`SELECT table_name FROM information_schema.tables
					 WHERE table_schema = '${schemaName.replace(/'/g,"''")}' AND table_type = 'BASE TABLE'
					 ORDER BY table_name`);
				const tableNames = tablesRes.rows.map((r: any) => r.table_name as string);
				const tblPick = await vscode.window.showQuickPick(
					tableNames.map(t => ({ label: t })),
					{ title: 'ER Diagram — Root Table', placeHolder: 'Choose starting table' });
				if (!tblPick) return;
				rootTable = tblPick.label;
			}

			// Выбор глубины
			const depthPick = await vscode.window.showQuickPick(
				[1,2,3,4,5].map(n => ({
					label: `${n} level${n > 1 ? 's' : ''}`,
					description: n === 1 ? 'Direct FK relations only'
						: n === 2 ? 'FK of FK' : `${n} hops from root`,
					value: n,
				})),
				{ title: `ER Diagram — Depth from "${rootTable}"` });
			if (!depthPick) return;
			maxDepth = depthPick.value;
		}

		// ── Ключ панели (уникальный) ─────────────────────────────
		const panelKey = `erd:${activeConn}:${schemaName}:${mode}:${rootTable ?? ''}:${maxDepth}`;
		const existing = this.panels.get(panelKey);
		if (existing) { existing.reveal(vscode.ViewColumn.One); return; }

		const panelTitle = mode === 'full'
			? `ERD — ${activeConn} / ${schemaName}`
			: `ERD — ${rootTable} (depth ${maxDepth})`;

		const panel = vscode.window.createWebviewPanel(
			'pgsqlERD', panelTitle,
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		this.panels.set(panelKey, panel);
		panel.onDidDispose(() => this.panels.delete(panelKey));
		panel.webview.html = this.loadingHtml(panelTitle);

		try {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Generating ER Diagram…', cancellable: false },
				async (progress) => {
					const esc = (s: string) => s.replace(/'/g, "''");

					progress.report({ message: 'Loading tables…' });
					const tablesRes = await queryExecutor.executeQueryOnClient(client,
						`SELECT table_name FROM information_schema.tables
						 WHERE table_schema = '${esc(schemaName)}' AND table_type = 'BASE TABLE'
						 ORDER BY table_name`);
					const allTables = tablesRes.rows.map((r: any) => r.table_name as string);
					if (!allTables.length) { panel.webview.html = this.emptyHtml(schemaName); return; }

					progress.report({ message: 'Loading columns…' });
					const colsRes = await queryExecutor.executeQueryOnClient(client,
						`SELECT table_name, column_name, data_type, is_nullable
						 FROM information_schema.columns
						 WHERE table_schema = '${esc(schemaName)}'
						 ORDER BY table_name, ordinal_position`);

					progress.report({ message: 'Loading primary keys…' });
					const pksRes = await queryExecutor.executeQueryOnClient(client,
						`SELECT tc.table_name, kcu.column_name
						 FROM information_schema.table_constraints tc
						 JOIN information_schema.key_column_usage kcu
						   ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
						 WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '${esc(schemaName)}'`);

					progress.report({ message: 'Loading foreign keys…' });
					const fksRes = await queryExecutor.executeQueryOnClient(client,
						`SELECT tc.constraint_name,
						        tc.table_name   AS source_table,
						        kcu.column_name AS source_column,
						        ccu.table_name  AS target_table,
						        ccu.column_name AS target_column
						 FROM information_schema.table_constraints tc
						 JOIN information_schema.key_column_usage kcu
						   ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
						 JOIN information_schema.constraint_column_usage ccu
						   ON ccu.constraint_name = tc.constraint_name
						 WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${esc(schemaName)}'
						 ORDER BY tc.table_name, kcu.column_name`);

					const schemaData: SchemaData = {
						allTables,
						allColumns: colsRes.rows as ColInfo[],
						allPks    : pksRes.rows as PKInfo[],
						allFks    : fksRes.rows as FKRelation[],
					};

					panel.webview.html = this.buildHtml(
						activeConn, schemaName, schemaData, mode, rootTable ?? null, maxDepth
					);
				}
			);
		} catch (err) {
			vscode.window.showErrorMessage(`ER Diagram failed: ${err}`);
			panel.dispose();
		}
	}

	// ── Режим от конкретной таблицы (из контекстного меню дерева) ──
	static async showFromTable(
		context: vscode.ExtensionContext,
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		schema: string,
		tableName: string,
		connName?: string
	): Promise<void> {
		return this.show(context, queryExecutor, connectionManager, connName, tableName);
	}

	// ─────────────────────────────────────────────────────────────
	private static loadingHtml(title: string): string {
		return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);">
		<div style="text-align:center;opacity:0.6"><div style="font-size:24px;margin-bottom:12px">⏳</div>
		<div>Generating ER Diagram for <strong>${escHtml(title)}</strong>…</div></div></body></html>`;
	}
	private static emptyHtml(schema: string): string {
		return `<!DOCTYPE html><html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);">
		<div style="text-align:center;opacity:0.5"><div style="font-size:28px;margin-bottom:10px">📭</div>
		<div>No tables found in schema <strong>${escHtml(schema)}</strong></div></div></body></html>`;
	}

	// ─────────────────────────────────────────────────────────────
	private static buildHtml(
		connName: string, schema: string,
		data: SchemaData,
		mode: 'full' | 'focused',
		rootTable: string | null,
		maxDepth: number
	): string {
		const { allTables, allColumns, allPks, allFks } = data;

		// ── Индексы ──────────────────────────────────────────────
		const pkSet = new Set(allPks.map(p => `${p.table_name}.${p.column_name}`));
		const fkSet = new Set(allFks.map(f => `${f.source_table}.${f.source_column}`));

		const colsByTable = new Map<string, ColInfo[]>();
		for (const t of allTables) colsByTable.set(t, []);
		for (const c of allColumns) colsByTable.get(c.table_name)?.push(c);

		// FK-граф: outgoing (from → to) и incoming (to ← from)
		const outEdges = new Map<string, FKRelation[]>();  // source → [fk]
		const inEdges  = new Map<string, FKRelation[]>();  // target → [fk]
		for (const t of allTables) { outEdges.set(t, []); inEdges.set(t, []); }
		for (const fk of allFks) {
			outEdges.get(fk.source_table)?.push(fk);
			inEdges .get(fk.target_table)?.push(fk);
		}

		// ── BFS по уровням для focused-режима ────────────────────
		// tableLevel[name] = номер уровня (0 = root)
		// fkLevel[fk_key]  = уровень на котором появилась связь
		const tableLevel = new Map<string, number>();
		const fkLevel    = new Map<string, number>();  // constraint_name → level

		let activeTables: string[] = allTables;
		let activeFks   : FKRelation[] = allFks;

		if (mode === 'focused' && rootTable) {
			// BFS — обходим и исходящие (out) и входящие (in) связи
			tableLevel.set(rootTable, 0);
			let frontier = [rootTable];

			for (let depth = 1; depth <= maxDepth; depth++) {
				const next: string[] = [];
				for (const t of frontier) {
					const connected = [
						...(outEdges.get(t) ?? []),
						...(inEdges .get(t) ?? []),
					];
					for (const fk of connected) {
						const key = fk.constraint_name;
						if (!fkLevel.has(key)) fkLevel.set(key, depth);

						const neighbor = fk.source_table === t ? fk.target_table : fk.source_table;
						if (!tableLevel.has(neighbor)) {
							tableLevel.set(neighbor, depth);
							next.push(neighbor);
						}
					}
				}
				frontier = next;
				if (!frontier.length) break;
			}

			activeTables = allTables.filter(t => tableLevel.has(t));
			activeFks    = allFks.filter(fk =>
				tableLevel.has(fk.source_table) && tableLevel.has(fk.target_table)
			);
		} else {
			// Full mode — все таблицы на уровне 0
			for (const t of allTables) tableLevel.set(t, 0);
		}

		// ── Mermaid ───────────────────────────────────────────────
		const mermaidLines = ['erDiagram'];
		for (const t of activeTables) {
			const cols = colsByTable.get(t) ?? [];
			if (!cols.length) continue;
			mermaidLines.push(`    ${t} {`);
			for (const c of cols) {
				const n  = c.column_name.replace(/\s+/g, '_');
				const tp = c.data_type.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
				mermaidLines.push(`        ${tp || 'text'} ${n}`);
			}
			mermaidLines.push('    }');
		}
		const seenRel = new Set<string>();
		for (const fk of activeFks) {
			const key = `${fk.source_table}=>${fk.target_table}`;
			if (!seenRel.has(key)) {
				seenRel.add(key);
				const lbl = fk.constraint_name.replace(/"/g, "'");
				mermaidLines.push(`    ${fk.target_table} ||--o{ ${fk.source_table} : "${lbl}"`);
			}
		}
		const mermaidCode = mermaidLines.join('\n');

		// ── JSON данные для Canvas ────────────────────────────────
		const diagramData = {
			mode,
			rootTable,
			maxDepth,
			tables: activeTables.map(t => ({
				name  : t,
				level : tableLevel.get(t) ?? 0,
				isRoot: t === rootTable,
				columns: (colsByTable.get(t) ?? []).map(c => ({
					name    : c.column_name,
					type    : c.data_type,
					isPk    : pkSet.has(`${t}.${c.column_name}`),
					isFk    : fkSet.has(`${t}.${c.column_name}`),
					nullable: c.is_nullable === 'YES',
				}))
			})),
			fks: activeFks.map(fk => ({
				fromTable : fk.source_table,
				fromCol   : fk.source_column,
				toTable   : fk.target_table,
				toCol     : fk.target_column,
				constraint: fk.constraint_name,
				level     : fkLevel.get(fk.constraint_name) ?? 0,
			}))
		};

		const titleStr = mode === 'full'
			? `${escHtml(connName)} / ${escHtml(schema)}`
			: `${escHtml(rootTable!)} (depth ${maxDepth}) — ${escHtml(schema)}`;

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
	--border : var(--vscode-panel-border);
	--bg     : var(--vscode-editor-background);
	--bg2    : var(--vscode-editorGroupHeader-tabsBackground);
	--bg3    : var(--vscode-sideBar-background, #1e1e1e);
	--fg     : var(--vscode-foreground);
	--fg2    : var(--vscode-descriptionForeground);
	--accent : #4d9cf5;
	--pk     : #4ec9b0;
	--fk     : #d2a22a;
	--root-c : #e06c75;
	--font   : var(--vscode-font-family);
	--mono   : var(--vscode-editor-font-family, monospace);
}
html, body { width:100%; height:100%; font-family:var(--font); font-size:13px;
	background:var(--bg); color:var(--fg); display:flex; flex-direction:column; overflow:hidden; }

/* ── toolbar ── */
.toolbar { display:flex; align-items:center; gap:8px; padding:5px 10px;
	background:var(--bg2); border-bottom:1px solid var(--border); flex-shrink:0; }
.toolbar-title { font-size:12px; font-weight:600; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.toolbar-meta  { font-size:11px; color:var(--fg2); white-space:nowrap; }
.btn { padding:3px 9px; background:var(--vscode-button-background);
	color:var(--vscode-button-foreground); border:none; border-radius:2px; font-size:11px; cursor:pointer; white-space:nowrap; }
.btn:hover { background:var(--vscode-button-hoverBackground); }
.btn-ghost { background:transparent; color:var(--fg2); border:1px solid var(--border); }
.btn-ghost:hover { color:var(--fg); background:rgba(255,255,255,0.06); }
.btn-group { display:flex; gap:3px; }

/* ── tabs ── */
.tabs { display:flex; background:var(--bg2); border-bottom:1px solid var(--border); padding:0 4px; flex-shrink:0; }
.tab { padding:6px 14px; font-size:12px; font-weight:500; cursor:pointer;
	border-bottom:2px solid transparent; color:var(--fg); opacity:.6; user-select:none; }
.tab:hover { opacity:.9; }
.tab.active { opacity:1; border-bottom-color:var(--accent); color:var(--accent); }

/* ── layout ── */
.content { flex:1; overflow:hidden; display:flex; }
.tab-pane { display:none; flex:1; overflow:hidden; }
.tab-pane.active { display:flex; }

/* ── sidebar ── */
.sidebar {
	width:240px; min-width:200px; max-width:340px; flex-shrink:0;
	border-right:1px solid var(--border);
	display:flex; flex-direction:column; overflow:hidden;
	background:var(--bg3);
	resize:horizontal; /* browser-native resize */
}
.sidebar-section { flex-shrink:0; border-bottom:1px solid var(--border); }
.sidebar-head {
	display:flex; align-items:center; justify-content:space-between;
	padding:6px 10px; font-size:10px; font-weight:700;
	text-transform:uppercase; letter-spacing:.06em; color:var(--fg2);
	cursor:pointer; user-select:none;
}
.sidebar-head:hover { background:rgba(255,255,255,0.04); }
.sidebar-head .chevron { transition:transform .15s; }
.sidebar-head.collapsed .chevron { transform:rotate(-90deg); }
.sidebar-body { overflow-y:auto; }
.sidebar-body.hidden { display:none; }

.filter-input {
	width:calc(100% - 16px); margin:5px 8px; padding:4px 8px;
	background:var(--vscode-input-background); color:var(--vscode-input-foreground);
	border:1px solid var(--vscode-input-border, transparent);
	border-radius:2px; font-size:11px; outline:none;
}
.filter-input:focus { border-color:var(--accent); }

.table-item {
	display:flex; align-items:center; gap:6px;
	padding:3px 10px 3px 8px; font-size:11px; cursor:pointer;
	user-select:none;
}
.table-item:hover { background:rgba(255,255,255,0.05); }
.table-item input[type=checkbox] { flex-shrink:0; cursor:pointer; accent-color:var(--accent); }
.table-item .tbl-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.table-item .tbl-badge {
	font-size:9px; font-weight:700; padding:0 4px; border-radius:2px;
	flex-shrink:0;
}
.badge-root  { background:rgba(224,108,117,.25); color:var(--root-c); }
.badge-level { background:rgba(77,156,245,.15); color:var(--accent); }

.fk-item {
	display:flex; align-items:flex-start; gap:6px;
	padding:3px 10px 3px 8px; font-size:10px; cursor:pointer;
	user-select:none; line-height:1.4;
}
.fk-item:hover { background:rgba(255,255,255,0.05); }
.fk-item input[type=checkbox] { flex-shrink:0; margin-top:1px; cursor:pointer; accent-color:var(--fk); }
.fk-desc { flex:1; color:var(--fg2); overflow:hidden; }
.fk-desc b { color:var(--fg); }

.sidebar-actions { padding:6px 8px; display:flex; gap:4px; flex-wrap:wrap; }

/* scrollbar sidebar */
.sidebar-body::-webkit-scrollbar { width:6px; }
.sidebar-body::-webkit-scrollbar-track { background:transparent; }
.sidebar-body::-webkit-scrollbar-thumb { background:rgba(128,128,128,0.3); border-radius:3px; }

/* ── canvas area ── */
.canvas-wrap { flex:1; position:relative; overflow:hidden; background:var(--bg); }
#erd-canvas  { display:block; cursor:default; }
#erd-canvas.panning  { cursor:grabbing; }
#erd-canvas.hovering { cursor:pointer; }

#zoom-badge {
	position:absolute; bottom:10px; right:10px;
	background:var(--bg2); border:1px solid var(--border);
	color:var(--fg2); font-size:11px; padding:3px 8px; border-radius:4px;
	pointer-events:none; user-select:none;
}
#legend {
	position:absolute; bottom:10px; left:10px;
	background:var(--bg2); border:1px solid var(--border);
	padding:8px 10px; border-radius:4px; font-size:10px; line-height:1.9;
}
.leg-row { display:flex; align-items:center; gap:7px; }
.leg-swatch { width:12px; height:12px; border-radius:2px; flex-shrink:0; }
.leg-line   { width:28px; height:10px; position:relative; flex-shrink:0; }
.leg-line svg { position:absolute; inset:0; }

#tooltip {
	position:fixed; pointer-events:none; display:none;
	background:var(--bg2); border:1px solid var(--border);
	color:var(--fg); font-size:11px; padding:6px 9px;
	border-radius:4px; box-shadow:0 2px 8px rgba(0,0,0,.4);
	z-index:200; max-width:280px; line-height:1.5;
}

/* ── mermaid pane ── */
#pane-mermaid { flex-direction:column; padding:14px; gap:10px; overflow:auto; }
.copy-bar { display:flex; gap:8px; align-items:center; flex-shrink:0; }
.copied { font-size:11px; color:var(--pk); }
.mermaid-code {
	font-family:var(--mono); font-size:12px;
	background:var(--bg2); border:1px solid var(--border);
	border-radius:4px; padding:12px; white-space:pre; overflow:auto; flex:1;
}
</style>
</head>
<body>

<!-- toolbar -->
<div class="toolbar">
	<span class="toolbar-title">ERD — ${titleStr}</span>
	<span class="toolbar-meta" id="stats-badge"></span>
	<div class="btn-group">
		<button class="btn btn-ghost" onclick="resetView()">⊡ Fit</button>
		<button class="btn btn-ghost" onclick="autoLayout()">⟳ Layout</button>
		<button class="btn btn-ghost" onclick="selectAll(true)">☑ All</button>
		<button class="btn btn-ghost" onclick="selectAll(false)">☐ None</button>
	</div>
</div>

<!-- tabs -->
<div class="tabs">
	<div class="tab active" data-tab="diagram">Diagram</div>
	<div class="tab" data-tab="mermaid">Mermaid</div>
</div>

<div class="content">

<!-- ══ DIAGRAM TAB ══ -->
<div class="tab-pane active" id="pane-diagram" style="flex-direction:row;">

	<!-- sidebar -->
	<div class="sidebar" id="sidebar">

		<!-- Tables section -->
		<div class="sidebar-section">
			<div class="sidebar-head" id="head-tables" onclick="toggleSection('tables')">
				<span>Tables <span id="tbl-count" style="opacity:.6;font-weight:400"></span></span>
				<span class="chevron">▾</span>
			</div>
			<div class="sidebar-body" id="body-tables">
				<input class="filter-input" id="tbl-filter" placeholder="Filter tables…"
					oninput="filterTables(this.value)">
				<div id="table-list"></div>
				<div class="sidebar-actions">
					<button class="btn btn-ghost" style="font-size:10px" onclick="selectTablesByLevel(0)">L0 only</button>
					<button class="btn btn-ghost" style="font-size:10px" onclick="selectTablesByLevel(1)">L0+L1</button>
					<button class="btn btn-ghost" style="font-size:10px" onclick="selectTablesByLevel(99)">All levels</button>
				</div>
			</div>
		</div>

		<!-- Relations section -->
		<div class="sidebar-section" style="flex:1;overflow:hidden;display:flex;flex-direction:column;">
			<div class="sidebar-head" id="head-fks" onclick="toggleSection('fks')">
				<span>Relations <span id="fk-count" style="opacity:.6;font-weight:400"></span></span>
				<span class="chevron">▾</span>
			</div>
			<div class="sidebar-body" id="body-fks" style="flex:1;">
				<input class="filter-input" id="fk-filter" placeholder="Filter relations…"
					oninput="filterFks(this.value)">
				<div id="fk-list"></div>
			</div>
		</div>
	</div>

	<!-- canvas -->
	<div class="canvas-wrap" id="canvas-wrap">
		<canvas id="erd-canvas"></canvas>
		<div id="zoom-badge">100%</div>
		<div id="legend">
			${mode === 'focused' ? `
			<div class="leg-row"><div class="leg-swatch" style="background:rgba(224,108,117,.3);border:1.5px solid var(--root-c)"></div>Root table</div>
			<div class="leg-row"><div class="leg-swatch" style="background:rgba(77,156,245,.25);border:1px solid var(--accent)"></div>Level 1+</div>
			` : ''}
			<div class="leg-row"><div class="leg-swatch" style="background:rgba(78,201,176,.25);border:1px solid var(--pk)"></div>Primary Key</div>
			<div class="leg-row"><div class="leg-swatch" style="background:rgba(210,162,42,.2);border:1px solid var(--fk)"></div>Foreign Key</div>
			<div class="leg-row">
				<div class="leg-line"><svg><line x1="0" y1="5" x2="28" y2="5" stroke="#4d9cf5" stroke-width="1.5" stroke-dasharray="4,2"/></svg></div>
				FK Relation
			</div>
		</div>
	</div>
</div><!-- /diagram tab -->

<!-- ══ MERMAID TAB ══ -->
<div class="tab-pane" id="pane-mermaid">
	<div class="copy-bar">
		<button class="btn" onclick="copyMermaid()">Copy</button>
		<span class="copied" id="copiedLabel" style="display:none">✓ Copied!</span>
		<span style="font-size:11px;color:var(--fg2)">
			Open at <a href="https://mermaid.live" style="color:var(--accent)">mermaid.live</a>
		</span>
	</div>
	<pre class="mermaid-code" id="mermaidCode">${escHtml(mermaidCode)}</pre>
</div>

</div><!-- /content -->
<div id="tooltip"></div>

<script>
// ══════════════════════════════════════════════════════════════
//  DATA
// ══════════════════════════════════════════════════════════════
const DATA = ${JSON.stringify(diagramData)};

// ── Visibility state ──────────────────────────────────────────
// hiddenTables: Set<name>, hiddenFks: Set<constraint_name>
const hiddenTables = new Set();
const hiddenFks    = new Set();

// ── Visible subsets ───────────────────────────────────────────
function visibleTables() { return DATA.tables.filter(t => !hiddenTables.has(t.name)); }
function visibleFks()    {
	return DATA.fks.filter(fk =>
		!hiddenFks.has(fk.constraint) &&
		!hiddenTables.has(fk.fromTable) &&
		!hiddenTables.has(fk.toTable)
	);
}

// ════════════════════════════════════════════════════════════════
//  TABS
// ════════════════════════════════════════════════════════════════
document.querySelectorAll('.tab').forEach(tab => {
	tab.addEventListener('click', () => {
		document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
		document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById('pane-' + tab.dataset.tab).classList.add('active');
		if (tab.dataset.tab === 'diagram') requestAnimationFrame(render);
	});
});

function copyMermaid() {
	navigator.clipboard.writeText(document.getElementById('mermaidCode').textContent || '').then(() => {
		const l = document.getElementById('copiedLabel');
		l.style.display = 'inline';
		setTimeout(() => l.style.display = 'none', 2000);
	});
}

// ════════════════════════════════════════════════════════════════
//  SIDEBAR
// ════════════════════════════════════════════════════════════════
function toggleSection(which) {
	const head = document.getElementById('head-' + which);
	const body = document.getElementById('body-' + which);
	const collapsed = body.classList.toggle('hidden');
	head.classList.toggle('collapsed', collapsed);
}

// ── Build table list ──────────────────────────────────────────
function buildTableList(filter = '') {
	const list = document.getElementById('table-list');
	const f = filter.toLowerCase();
	list.innerHTML = '';
	DATA.tables
		.filter(t => !f || t.name.toLowerCase().includes(f))
		.forEach(t => {
			const div = document.createElement('div');
			div.className = 'table-item';
			const checked = !hiddenTables.has(t.name);
			let badge = '';
			if (t.isRoot)   badge = '<span class="tbl-badge badge-root">ROOT</span>';
			else if (t.level > 0) badge = '<span class="tbl-badge badge-level">L' + t.level + '</span>';
			div.innerHTML =
				'<input type="checkbox" ' + (checked ? 'checked' : '') + ' data-table="' + escH(t.name) + '">' +
				'<span class="tbl-name" title="' + escH(t.name) + '">' + escH(t.name) + '</span>' +
				badge;
			div.querySelector('input').addEventListener('change', e => {
				const name = e.target.dataset.table;
				if (e.target.checked) hiddenTables.delete(name);
				else hiddenTables.add(name);
				rebuildFkList();
				updateStats();
				render();
			});
			list.appendChild(div);
		});
	document.getElementById('tbl-count').textContent = '(' + DATA.tables.length + ')';
}

function filterTables(v) { buildTableList(v); }

// ── Build FK list ─────────────────────────────────────────────
function buildFkList(filter = '') {
	const list = document.getElementById('fk-list');
	const f = filter.toLowerCase();
	list.innerHTML = '';
	DATA.fks
		.filter(fk => !f ||
			fk.constraint.toLowerCase().includes(f) ||
			fk.fromTable.toLowerCase().includes(f) ||
			fk.toTable.toLowerCase().includes(f))
		.forEach(fk => {
			const div = document.createElement('div');
			div.className = 'fk-item';
			const checked = !hiddenFks.has(fk.constraint);
			const grayed  = hiddenTables.has(fk.fromTable) || hiddenTables.has(fk.toTable);
			div.style.opacity = grayed ? '0.4' : '1';
			div.innerHTML =
				'<input type="checkbox" ' + (checked ? 'checked' : '') +
				' data-fk="' + escH(fk.constraint) + '" ' + (grayed ? 'disabled' : '') + '>' +
				'<div class="fk-desc">' +
					'<b>' + escH(fk.fromTable) + '</b>.' + escH(fk.fromCol) +
					' → <b>' + escH(fk.toTable) + '</b>.' + escH(fk.toCol) +
					'<br><span style="font-size:9px;opacity:.6">' + escH(fk.constraint) + '</span>' +
				'</div>';
			div.querySelector('input')?.addEventListener('change', e => {
				const name = e.target.dataset.fk;
				if (e.target.checked) hiddenFks.delete(name);
				else hiddenFks.add(name);
				updateStats();
				render();
			});
			list.appendChild(div);
		});
	document.getElementById('fk-count').textContent = '(' + DATA.fks.length + ')';
}

function rebuildFkList() { buildFkList(document.getElementById('fk-filter').value); }
function filterFks(v)    { buildFkList(v); }

function selectAll(on) {
	if (on) { hiddenTables.clear(); hiddenFks.clear(); }
	else    { DATA.tables.forEach(t => hiddenTables.add(t.name)); DATA.fks.forEach(f => hiddenFks.add(f.constraint)); }
	buildTableList(document.getElementById('tbl-filter').value);
	buildFkList(document.getElementById('fk-filter').value);
	updateStats(); render();
}

function selectTablesByLevel(maxL) {
	hiddenTables.clear();
	DATA.tables.forEach(t => { if (t.level > maxL) hiddenTables.add(t.name); });
	// auto-hide FK where both sides hidden
	buildTableList(document.getElementById('tbl-filter').value);
	rebuildFkList();
	updateStats(); render();
}

function updateStats() {
	const vt = visibleTables().length;
	const vf = visibleFks().length;
	document.getElementById('stats-badge').textContent = vt + ' tables · ' + vf + ' relations';
}

// ════════════════════════════════════════════════════════════════
//  CANVAS ENGINE
// ════════════════════════════════════════════════════════════════
const canvas  = document.getElementById('erd-canvas');
const ctx     = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
const badge   = document.getElementById('zoom-badge');

const COL_H = 22, HDR_H = 30, PAD_X = 12, MIN_W = 190;
const LEVEL_COLORS = ['#4d9cf5','#d2a22a','#4ec9b0','#c586c0','#f08080'];

let scale = 1, offsetX = 0, offsetY = 0;
let panning = false, panStartX, panStartY, panOffX, panOffY;
let dragTable = null, dragDX, dragDY;
let hoveredTable = null, hoveredFk = null;

// positions
const tblState = {};   // name → {x,y,w,h}

function buildTableState() {
	const VIS = DATA.tables;
	const cols = Math.max(1, Math.ceil(Math.sqrt(VIS.length)));
	VIS.forEach((t, i) => {
		const w = Math.max(MIN_W,
			t.columns.reduce((m,c) => Math.max(m, (c.name.length + c.type.length) * 6 + 60), MIN_W));
		const h = HDR_H + t.columns.length * COL_H + 4;
		const col = i % cols, row = Math.floor(i / cols);
		tblState[t.name] = { x: 20 + col*(w+60), y: 20 + row*(h+50), w, h };
	});
}

// ── Force-directed layout ─────────────────────────────────────
function autoLayout() {
	const vt = visibleTables();
	if (!vt.length) return;

	const ITER = 100, REPEL = 15000, ATTRACT = 0.04;
	const names = vt.map(t => t.name);

	for (let iter = 0; iter < ITER; iter++) {
		const dx = Object.fromEntries(names.map(n => [n, 0]));
		const dy = Object.fromEntries(names.map(n => [n, 0]));

		// Repulsion
		for (let i = 0; i < names.length; i++) {
			for (let j = i+1; j < names.length; j++) {
				const a = tblState[names[i]], b = tblState[names[j]];
				const ddx = (a.x+a.w/2) - (b.x+b.w/2);
				const ddy = (a.y+a.h/2) - (b.y+b.h/2);
				const dist = Math.sqrt(ddx*ddx+ddy*ddy) || 1;
				const f = REPEL / (dist*dist);
				dx[names[i]] += (ddx/dist)*f; dy[names[i]] += (ddy/dist)*f;
				dx[names[j]] -= (ddx/dist)*f; dy[names[j]] -= (ddy/dist)*f;
			}
		}

		// Attraction along visible FK edges
		for (const fk of visibleFks()) {
			const a = tblState[fk.fromTable], b = tblState[fk.toTable];
			if (!a || !b) continue;
			const ddx = (b.x+b.w/2) - (a.x+a.w/2);
			const ddy = (b.y+b.h/2) - (a.y+a.h/2);
			const dist = Math.sqrt(ddx*ddx+ddy*ddy) || 1;
			const ideal = a.w/2 + b.w/2 + 100;
			const f = ATTRACT * (dist - ideal);
			dx[fk.fromTable] += (ddx/dist)*f; dy[fk.fromTable] += (ddy/dist)*f;
			dx[fk.toTable]   -= (ddx/dist)*f; dy[fk.toTable]   -= (ddy/dist)*f;
		}

		const damp = 1 - iter/ITER;
		for (const n of names) {
			tblState[n].x += dx[n]*damp;
			tblState[n].y += dy[n]*damp;
		}
	}

	// Normalise
	let minX=Infinity, minY=Infinity;
	for (const n of names) { minX=Math.min(minX,tblState[n].x); minY=Math.min(minY,tblState[n].y); }
	for (const n of names) { tblState[n].x -= minX-20; tblState[n].y -= minY-20; }
	resetView();
}

function resetView() {
	const vt = visibleTables();
	if (!vt.length) return;
	let maxX=0, maxY=0;
	for (const t of vt) { const s=tblState[t.name]; if(s){maxX=Math.max(maxX,s.x+s.w); maxY=Math.max(maxY,s.y+s.h);} }
	const vw=canvas.width, vh=canvas.height;
	scale = Math.min(1.2, Math.min(vw/(maxX+40), vh/(maxY+40)));
	offsetX = (vw - maxX*scale)/2;
	offsetY = (vh - maxY*scale)/2;
	render();
}

// ── Render ────────────────────────────────────────────────────
function render() {
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	ctx.save();
	ctx.translate(offsetX, offsetY);
	ctx.scale(scale, scale);

	drawEdges();

	for (const t of visibleTables()) drawTable(t, tblState[t.name]);

	ctx.restore();
	badge.textContent = Math.round(scale*100) + '%';
}

// ── Edges ─────────────────────────────────────────────────────
function colAnchor(tname, cname, side) {
	const s = tblState[tname]; if(!s) return null;
	const idx = DATA.tables.find(t=>t.name===tname)?.columns.findIndex(c=>c.name===cname) ?? 0;
	const y = s.y + HDR_H + Math.max(0,idx)*COL_H + COL_H/2;
	return { x: side==='right' ? s.x+s.w : s.x, y };
}

function drawEdges() {
	for (const fk of visibleFks()) {
		const from = tblState[fk.fromTable], to = tblState[fk.toTable];
		if (!from||!to) continue;
		const isHov = hoveredFk && hoveredFk.constraint===fk.constraint;

		const fromCX = from.x+from.w/2, toCX = to.x+to.w/2;
		const fromSide = fromCX < toCX ? 'right':'left';
		const toSide   = fromCX < toCX ? 'left' :'right';

		const p1 = colAnchor(fk.fromTable, fk.fromCol, fromSide);
		const p2 = colAnchor(fk.toTable,   fk.toCol,   toSide);
		if (!p1||!p2) continue;

		const cpOff = Math.max(60, Math.abs(p2.x-p1.x)*0.42);
		const cp1x  = p1.x + (fromSide==='right'?cpOff:-cpOff);
		const cp2x  = p2.x + (toSide==='right'?cpOff:-cpOff);

		// Edge color based on FK level
		const levelColor = LEVEL_COLORS[Math.min(fk.level, LEVEL_COLORS.length-1)];

		ctx.save();
		ctx.globalAlpha = isHov ? 1.0 : 0.7;
		ctx.strokeStyle = isHov ? '#ffffff' : levelColor;
		ctx.lineWidth   = isHov ? 2.2 : 1.4;
		ctx.setLineDash(isHov ? [] : [5,3]);
		if (isHov) { ctx.shadowBlur=8; ctx.shadowColor=levelColor; }

		ctx.beginPath();
		ctx.moveTo(p1.x, p1.y);
		ctx.bezierCurveTo(cp1x,p1.y, cp2x,p2.y, p2.x,p2.y);
		ctx.stroke();
		ctx.setLineDash([]); ctx.shadowBlur=0;

		// Arrow at target
		const angle = Math.atan2(p2.y-p1.y, p2.x-cp2x);
		ctx.fillStyle = isHov ? '#ffffff' : levelColor;
		ctx.beginPath();
		ctx.moveTo(p2.x, p2.y);
		ctx.lineTo(p2.x-9*Math.cos(angle-0.4), p2.y-9*Math.sin(angle-0.4));
		ctx.lineTo(p2.x-9*Math.cos(angle+0.4), p2.y-9*Math.sin(angle+0.4));
		ctx.closePath(); ctx.fill();

		// Cardinality labels
		ctx.globalAlpha = isHov ? 1 : 0.8;
		ctx.fillStyle   = levelColor;
		ctx.font = 'bold 9px ' + getComputedStyle(document.body).getPropertyValue('--font');
		ctx.textAlign = 'center';
		const oM = 14;
		ctx.fillText('1', p1.x+(fromSide==='right'?oM:-oM), p1.y-5);
		ctx.fillText('N', p2.x+(toSide==='right'?oM:-oM),   p2.y-5);
		ctx.restore();
	}
}

// ── Table card ────────────────────────────────────────────────
function drawTable(tbl, s) {
	if(!s) return;
	const {x,y,w,h} = s;
	const isHov  = hoveredTable===tbl.name;
	const isRoot = tbl.isRoot;

	const borderColor = isRoot ? '#e06c75' : isHov ? '#4d9cf5' : getCssVar('--border');
	const hdrColor    = isRoot ? '#c0464f' : '#3a7bc8';

	// Shadow
	ctx.save();
	ctx.shadowColor   = isRoot ? 'rgba(224,108,117,.4)' : isHov ? 'rgba(77,156,245,.3)' : 'rgba(0,0,0,.3)';
	ctx.shadowBlur    = isHov||isRoot ? 14 : 5;
	ctx.shadowOffsetY = 2;

	// Card bg
	ctx.fillStyle   = getCssVar('--bg');
	ctx.strokeStyle = borderColor;
	ctx.lineWidth   = isHov||isRoot ? 2 : 1;
	roundRect(x,y,w,h,6); ctx.fill(); ctx.stroke();
	ctx.restore();

	// Header gradient
	ctx.save();
	const grad = ctx.createLinearGradient(x,y,x,y+HDR_H);
	grad.addColorStop(0, isRoot ? '#e06c75' : (isHov ? '#4d9cf5' : '#3a7bc8'));
	grad.addColorStop(1, isRoot ? '#c0464f' : (isHov ? '#3a8ae0' : '#2d6baa'));
	ctx.fillStyle = grad;
	roundRectTop(x,y,w,HDR_H,6); ctx.fill();

	// Level badge in header (focused mode)
	if (DATA.mode==='focused' && !tbl.isRoot) {
		ctx.fillStyle = 'rgba(0,0,0,.25)';
		ctx.font = 'bold 9px sans-serif';
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		ctx.fillText('L' + tbl.level, x+w-8, y+HDR_H/2);
	}

	// Table name
	ctx.fillStyle   = '#ffffff';
	ctx.font        = 'bold 12px ' + getCssVar('--font');
	ctx.textBaseline = 'middle';
	ctx.textAlign   = 'center';
	const nameMaxW  = w - (DATA.mode==='focused' ? 36 : PAD_X*2);
	ctx.fillText(tbl.name, x+w/2, y+HDR_H/2, nameMaxW);
	ctx.restore();

	// Columns
	tbl.columns.forEach((col, i) => {
		const ry = y + HDR_H + i*COL_H;

		// Row highlight for active FK
		const isFkHov = hoveredFk && (
			(hoveredFk.fromTable===tbl.name && hoveredFk.fromCol===col.name) ||
			(hoveredFk.toTable  ===tbl.name && hoveredFk.toCol  ===col.name));

		if (isFkHov)    { ctx.fillStyle='rgba(77,156,245,.15)'; ctx.fillRect(x+1,ry,w-2,COL_H); }
		else if(col.isPk){ ctx.fillStyle='rgba(78,201,176,.07)'; ctx.fillRect(x+1,ry,w-2,COL_H); }
		else if(col.isFk){ ctx.fillStyle='rgba(210,162,42,.07)'; ctx.fillRect(x+1,ry,w-2,COL_H); }

		// Row divider
		ctx.strokeStyle = 'rgba(128,128,128,.1)';
		ctx.lineWidth   = 1;
		ctx.beginPath(); ctx.moveTo(x+1,ry); ctx.lineTo(x+w-1,ry); ctx.stroke();

		const midY = ry+COL_H/2;
		let curX   = x+PAD_X;

		// PK/FK badge
		if (col.isPk||col.isFk) {
			const bc = col.isPk ? '#4ec9b0' : '#d2a22a';
			const lbl = col.isPk ? 'PK' : 'FK';
			ctx.fillStyle = col.isPk ? 'rgba(78,201,176,.22)' : 'rgba(210,162,42,.2)';
			ctx.strokeStyle = bc; ctx.lineWidth = .8;
			ctx.fillRect(curX,midY-7,18,14); ctx.strokeRect(curX,midY-7,18,14);
			ctx.fillStyle = bc;
			ctx.font = 'bold 8px sans-serif';
			ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
			ctx.fillText(lbl, curX+9, midY);
		}
		curX += 22;

		// Column name
		ctx.fillStyle   = col.isPk ? '#4ec9b0' : col.isFk ? '#d2a22a' : getCssVar('--fg');
		ctx.font        = (col.isPk?'bold ':'') + '11px ' + getCssVar('--font');
		ctx.textAlign   = 'left';
		ctx.textBaseline= 'middle';
		ctx.fillText(col.name, curX, midY, w-curX-PAD_X-72);

		// Type (right)
		ctx.fillStyle = getCssVar('--fg2');
		ctx.font      = 'italic 10px ' + getCssVar('--font');
		ctx.textAlign = 'right';
		ctx.fillText(col.type, x+w-PAD_X, midY, 80);
	});

	// Bottom rule
	const lastY = y+HDR_H+tbl.columns.length*COL_H;
	ctx.strokeStyle='rgba(128,128,128,.1)'; ctx.lineWidth=1;
	ctx.beginPath(); ctx.moveTo(x+1,lastY); ctx.lineTo(x+w-1,lastY); ctx.stroke();
}

// ── Helpers ───────────────────────────────────────────────────
function roundRect(x,y,w,h,r) {
	ctx.beginPath();
	ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
	ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
	ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
	ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
	ctx.closePath();
}
function roundRectTop(x,y,w,h,r) {
	ctx.beginPath();
	ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
	ctx.lineTo(x+w,y+h); ctx.lineTo(x,y+h); ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
	ctx.closePath();
}
function getCssVar(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim()||'#888'; }

// ── Hit-test ──────────────────────────────────────────────────
function worldPt(ex,ey) {
	const r=canvas.getBoundingClientRect();
	return { wx:(ex-r.left-offsetX)/scale, wy:(ey-r.top-offsetY)/scale };
}
function hitTable(wx,wy) {
	for(const t of visibleTables()){
		const s=tblState[t.name]; if(!s)continue;
		if(wx>=s.x&&wx<=s.x+s.w&&wy>=s.y&&wy<=s.y+s.h) return t.name;
	} return null;
}
function bezier1d(t,p0,p1,p2,p3){ const m=1-t; return m*m*m*p0+3*m*m*t*p1+3*m*t*t*p2+t*t*t*p3; }
function hitFkEdge(wx,wy) {
	const THRESH=9;
	for(const fk of visibleFks()){
		const from=tblState[fk.fromTable], to=tblState[fk.toTable]; if(!from||!to)continue;
		const fromCX=from.x+from.w/2, toCX=to.x+to.w/2;
		const fs=fromCX<toCX?'right':'left', ts=fromCX<toCX?'left':'right';
		const p1=colAnchor(fk.fromTable,fk.fromCol,fs), p2=colAnchor(fk.toTable,fk.toCol,ts);
		if(!p1||!p2)continue;
		const cpOff=Math.max(60,Math.abs(p2.x-p1.x)*0.42);
		const cp1x=p1.x+(fs==='right'?cpOff:-cpOff), cp2x=p2.x+(ts==='right'?cpOff:-cpOff);
		for(let t=0;t<=1;t+=0.04){
			const bx=bezier1d(t,p1.x,cp1x,cp2x,p2.x), by=bezier1d(t,p1.y,p1.y,p2.y,p2.y);
			if(Math.hypot(wx-bx,wy-by)<THRESH) return fk;
		}
	} return null;
}

// ── Mouse ─────────────────────────────────────────────────────
canvas.addEventListener('mousedown', e => {
	const {wx,wy}=worldPt(e.clientX,e.clientY);
	const tname=hitTable(wx,wy);
	if(tname){
		const s=tblState[tname];
		if(wy < s.y+HDR_H){
			dragTable=tname; dragDX=wx-s.x; dragDY=wy-s.y;
		} else {
			panning=true; panStartX=e.clientX; panStartY=e.clientY; panOffX=offsetX; panOffY=offsetY;
		}
	} else {
		panning=true; panStartX=e.clientX; panStartY=e.clientY; panOffX=offsetX; panOffY=offsetY;
	}
});

canvas.addEventListener('mousemove', e => {
	const {wx,wy}=worldPt(e.clientX,e.clientY);
	if(dragTable){ tblState[dragTable].x=wx-dragDX; tblState[dragTable].y=wy-dragDY; render(); return; }
	if(panning){ offsetX=panOffX+(e.clientX-panStartX); offsetY=panOffY+(e.clientY-panStartY); render(); return; }

	const prevT=hoveredTable, prevF=hoveredFk;
	hoveredTable=hitTable(wx,wy);
	hoveredFk   =hoveredTable?null:hitFkEdge(wx,wy);

	if(hoveredFk){
		tooltip.style.display='block';
		tooltip.style.left=(e.clientX+14)+'px'; tooltip.style.top=(e.clientY+14)+'px';
		tooltip.innerHTML=
			'<strong>'+escH(hoveredFk.constraint)+'</strong><br>'+
			escH(hoveredFk.fromTable)+'.<b>'+escH(hoveredFk.fromCol)+'</b>'+
			' → '+escH(hoveredFk.toTable)+'.<b>'+escH(hoveredFk.toCol)+'</b>';
		canvas.className='hovering';
	} else {
		tooltip.style.display='none';
		canvas.className=hoveredTable?'hovering':'';
	}
	if(prevT!==hoveredTable||prevF!==hoveredFk) render();
});

canvas.addEventListener('mouseup',   ()=>{ panning=false; dragTable=null; });
canvas.addEventListener('mouseleave',()=>{
	panning=false; dragTable=null; hoveredTable=null; hoveredFk=null;
	tooltip.style.display='none'; render();
});

canvas.addEventListener('wheel', e=>{
	e.preventDefault();
	const {wx,wy}=worldPt(e.clientX,e.clientY);
	const f=e.deltaY<0?1.12:0.88;
	scale=Math.min(3,Math.max(0.08,scale*f));
	const r=canvas.getBoundingClientRect();
	offsetX=e.clientX-r.left-wx*scale;
	offsetY=e.clientY-r.top -wy*scale;
	render();
},{passive:false});

// ── Resize ────────────────────────────────────────────────────
const wrap=document.getElementById('canvas-wrap');
new ResizeObserver(()=>{ canvas.width=wrap.clientWidth; canvas.height=wrap.clientHeight; render(); }).observe(wrap);

// ── HTML escape ───────────────────────────────────────────────
function escH(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Init ──────────────────────────────────────────────────────
buildTableState();
buildTableList();
buildFkList();
updateStats();

setTimeout(()=>{
	canvas.width =wrap.clientWidth  || 900;
	canvas.height=wrap.clientHeight || 600;
	autoLayout();
}, 80);
</script>
</body>
</html>`;
	}
}