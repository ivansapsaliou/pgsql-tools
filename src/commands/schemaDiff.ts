import * as vscode from 'vscode';
import * as pg from 'pg';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ResultsViewProvider } from '../views/resultsPanel';

interface ColumnMeta {
	column_name: string;
	data_type: string;
	is_nullable: string;
	column_default: string | null;
}

interface IndexMeta {
	indexname: string;
	tablename: string;
	indexdef: string;
}

interface ConstraintMeta {
	table_name: string;
	constraint_name: string;
	constraint_type: string;
}

interface ViewMeta {
	table_name: string;
	view_definition: string;
}

interface EnumMeta {
	typname: string;
	labels: string;
}

interface FunctionMeta {
	function_name: string;
	function_definition: string;
}

interface ProcedureMeta {
	procedure_name: string;
	procedure_definition: string;
}

interface SchemaSnapshot {
	tables: Record<string, ColumnMeta[]>;
	indexes: IndexMeta[];
	constraints: ConstraintMeta[];
	views: ViewMeta[];
	enums: EnumMeta[];
	functions: FunctionMeta[];
	procedures: ProcedureMeta[];
}

async function getSchemaSnapshot(client: pg.Client, queryExecutor: QueryExecutor, schema: string): Promise<SchemaSnapshot> {
	const eq = (q: string) => queryExecutor.executeQueryOnClient(client, q);
	const esc = (s: string) => s.replace(/'/g, "''");

	const tablesRes = await eq(
		`SELECT table_name FROM information_schema.tables WHERE table_schema = '${esc(schema)}' AND table_type = 'BASE TABLE' ORDER BY table_name`
	);

	// Fetch all columns for the schema in one query to avoid N+1 round trips
	const allColsRes = await eq(
		`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = '${esc(schema)}' ORDER BY table_name, ordinal_position`
	);

	const tables: Record<string, ColumnMeta[]> = {};
	for (const row of tablesRes.rows) {
		tables[row.table_name] = [];
	}
	for (const col of allColsRes.rows) {
		if (Object.prototype.hasOwnProperty.call(tables, col.table_name)) {
			tables[col.table_name].push(col);
		}
	}

	const idxRes = await eq(
		`SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = '${esc(schema)}' ORDER BY tablename, indexname`
	);

	const conRes = await eq(
		`SELECT tc.table_name, tc.constraint_name, tc.constraint_type FROM information_schema.table_constraints tc WHERE tc.table_schema = '${esc(schema)}' ORDER BY tc.table_name, tc.constraint_name`
	);

	const viewRes = await eq(
		`SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = '${esc(schema)}' ORDER BY table_name`
	);

	const enumRes = await eq(
		`SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = '${esc(schema)}' GROUP BY t.typname ORDER BY t.typname`
	);

	// Fetch functions
	const funcRes = await eq(
		`SELECT p.proname AS function_name, pg_get_functiondef(p.oid) AS function_definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${esc(schema)}' AND p.prokind = 'f' ORDER BY p.proname`
	);

	// Fetch procedures
	const procRes = await eq(
		`SELECT p.proname AS procedure_name, REPLACE(regexp_replace(pg_get_functiondef(p.oid),E'[[:<:]](IN|OUT|INOUT|VARIADIC)[[:>:]]', '', 'gi'), '( ', '(') AS procedure_definition FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${esc(schema)}' AND p.prokind = 'p' ORDER BY p.proname`
	);

	return {
		tables,
		indexes: idxRes.rows,
		constraints: conRes.rows,
		views: viewRes.rows,
		enums: enumRes.rows,
		functions: funcRes.rows,
		procedures: procRes.rows
	};
}

function escHtml(s: string): string {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Normalize function/procedure definition to ignore version-specific differences
// PG 13 includes IN/OUT/INOUT keywords, PG 15 may not
function normalizeDefinition(def: string): string {
	if (!def) return '';
	return def
		// Remove parameter mode keywords (IN, OUT, INOUT, VARIADIC)
		.replace(/\b(IN|OUT|INOUT|VARIADIC)\b/gi, '')
		// Normalize whitespace (multiple spaces to single, trim)
		.replace(/\s+/g, ' ')
		.trim()
		// Normalize case for comparison (optional - comment out if case matters)
		.toLowerCase();
}

// Compute line-by-line diff between two texts
function computeLineDiff(oldText: string, newText: string): { left: string[], right: string[] } {
	const oldLines = (oldText || '').split('\n');
	const newLines = (newText || '').split('\n');
	
	// Simple LCS-based diff algorithm
	const m = oldLines.length;
	const n = newLines.length;
	
	// Build LCS table
	const lcs: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (oldLines[i - 1].trim() === newLines[j - 1].trim()) {
				lcs[i][j] = lcs[i - 1][j - 1] + 1;
			} else {
				lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
			}
		}
	}
	
	// Backtrack to build diff
	const left: string[] = [];
	const right: string[] = [];
	let i = m, j = n;
	
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1].trim() === newLines[j - 1].trim()) {
			// Unchanged line
			left.unshift(escHtml(oldLines[i - 1]));
			right.unshift(escHtml(newLines[j - 1]));
			i--;
			j--;
		} else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
			// Added line
			left.unshift('');
			right.unshift(`<span class="diff-line-added">${escHtml(newLines[j - 1])}</span>`);
			j--;
		} else if (i > 0) {
			// Removed line
			left.unshift(`<span class="diff-line-removed">${escHtml(oldLines[i - 1])}</span>`);
			right.unshift('');
			i--;
		}
	}
	
	return { left, right };
}

function getFunctionDiffHtml(detailId: string, name: string, defA: string, defB: string, labelA: string, labelB: string): string {
	const { left, right } = computeLineDiff(defA, defB);
	
	const leftHtml = left.map((line, idx) => 
		line ? `<div class="diff-line ${line.includes('diff-line-removed') ? 'line-removed' : ''}">${line || '&nbsp;'}</div>` : ''
	).join('');
	
	const rightHtml = right.map((line, idx) => 
		line ? `<div class="diff-line ${line.includes('diff-line-added') ? 'line-added' : ''}">${line || '&nbsp;'}</div>` : ''
	).join('');
	
	return `<div class="diff-detail-inner">
		<div style="font-weight:600; margin-bottom:8px; color:var(--vscode-foreground);">${escHtml(name)} — Code Diff</div>
		<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
			<div>
				<div style="font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:4px;">${escHtml(labelA)}</div>
				<pre class="diff-code">${leftHtml}</pre>
			</div>
			<div>
				<div style="font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:4px;">${escHtml(labelB)}</div>
				<pre class="diff-code">${rightHtml}</pre>
			</div>
		</div>
	</div>`;
}

function getProcedureDiffHtml(detailId: string, name: string, defA: string, defB: string, labelA: string, labelB: string): string {
	const { left, right } = computeLineDiff(defA, defB);
	
	const leftHtml = left.map((line, idx) => 
		line ? `<div class="diff-line ${line.includes('diff-line-removed') ? 'line-removed' : ''}">${line || '&nbsp;'}</div>` : ''
	).join('');
	
	const rightHtml = right.map((line, idx) => 
		line ? `<div class="diff-line ${line.includes('diff-line-added') ? 'line-added' : ''}">${line || '&nbsp;'}</div>` : ''
	).join('');
	
	return `<div class="diff-detail-inner">
		<div style="font-weight:600; margin-bottom:8px; color:var(--vscode-foreground);">${escHtml(name)} — Code Diff</div>
		<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
			<div>
				<div style="font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:4px;">${escHtml(labelA)}</div>
				<pre class="diff-code">${leftHtml}</pre>
			</div>
			<div>
				<div style="font-size:11px; color:var(--vscode-descriptionForeground); margin-bottom:4px;">${escHtml(labelB)}</div>
				<pre class="diff-code">${rightHtml}</pre>
			</div>
		</div>
	</div>`;
}

function diffSchemas(labelA: string, a: SchemaSnapshot, labelB: string, b: SchemaSnapshot): string {
	const sections: string[] = [];

	// ── Tables ──
	const tablesA = new Set(Object.keys(a.tables));
	const tablesB = new Set(Object.keys(b.tables));
	const addedTables = [...tablesB].filter(t => !tablesA.has(t));
	const removedTables = [...tablesA].filter(t => !tablesB.has(t));
	const commonTables = [...tablesA].filter(t => tablesB.has(t));

	const tableRows: string[] = [];
	for (const t of addedTables) {
		tableRows.push(`<tr class="diff-added"><td>+</td><td>${escHtml(t)}</td><td>Added in <strong>${escHtml(labelB)}</strong></td></tr>`);
	}
	for (const t of removedTables) {
		tableRows.push(`<tr class="diff-removed"><td>-</td><td>${escHtml(t)}</td><td>Only in <strong>${escHtml(labelA)}</strong></td></tr>`);
	}

	// ── Columns ──
	const columnRows: string[] = [];
	for (const t of commonTables) {
		const colsA = a.tables[t] ?? [];
		const colsB = b.tables[t] ?? [];
		const colMapA = new Map(colsA.map(c => [c.column_name, c]));
		const colMapB = new Map(colsB.map(c => [c.column_name, c]));

		for (const [col, meta] of colMapB) {
			if (!colMapA.has(col)) {
				columnRows.push(`<tr class="diff-added"><td>+</td><td>${escHtml(t)}.${escHtml(col)}</td><td>${escHtml(meta.data_type)}</td><td>Added in <strong>${escHtml(labelB)}</strong></td></tr>`);
			}
		}
		for (const [col, meta] of colMapA) {
			if (!colMapB.has(col)) {
				columnRows.push(`<tr class="diff-removed"><td>-</td><td>${escHtml(t)}.${escHtml(col)}</td><td>${escHtml(meta.data_type)}</td><td>Only in <strong>${escHtml(labelA)}</strong></td></tr>`);
			} else {
				const metaB = colMapB.get(col)!;
				const diffs: string[] = [];
				if (meta.data_type !== metaB.data_type) diffs.push(`type: ${escHtml(meta.data_type)} → ${escHtml(metaB.data_type)}`);
				if (meta.is_nullable !== metaB.is_nullable) diffs.push(`nullable: ${meta.is_nullable} → ${metaB.is_nullable}`);
				if ((meta.column_default ?? '') !== (metaB.column_default ?? '')) {
					diffs.push(`default: ${escHtml(String(meta.column_default ?? 'null'))} → ${escHtml(String(metaB.column_default ?? 'null'))}`);
				}
				if (diffs.length > 0) {
					columnRows.push(`<tr class="diff-changed"><td>~</td><td>${escHtml(t)}.${escHtml(col)}</td><td></td><td>${diffs.join('<br>')}</td></tr>`);
				}
			}
		}
	}

	// ── Indexes ──
	const idxMapA = new Map(a.indexes.map(i => [`${i.tablename}.${i.indexname}`, i.indexdef]));
	const idxMapB = new Map(b.indexes.map(i => [`${i.tablename}.${i.indexname}`, i.indexdef]));
	const indexRows: string[] = [];
	for (const [key, def] of idxMapB) {
		if (!idxMapA.has(key)) {
			indexRows.push(`<tr class="diff-added"><td>+</td><td>${escHtml(key)}</td><td>Added in <strong>${escHtml(labelB)}</strong></td></tr>`);
		} else if (idxMapA.get(key) !== def) {
			indexRows.push(`<tr class="diff-changed"><td>~</td><td>${escHtml(key)}</td><td>Definition changed</td></tr>`);
		}
	}
	for (const key of idxMapA.keys()) {
		if (!idxMapB.has(key)) {
			indexRows.push(`<tr class="diff-removed"><td>-</td><td>${escHtml(key)}</td><td>Only in <strong>${escHtml(labelA)}</strong></td></tr>`);
		}
	}

	// ── Enums ──
	const enumMapA = new Map(a.enums.map(e => [e.typname, e.labels]));
	const enumMapB = new Map(b.enums.map(e => [e.typname, e.labels]));
	const enumRows: string[] = [];
	for (const [name, labels] of enumMapB) {
		if (!enumMapA.has(name)) {
			enumRows.push(`<tr class="diff-added"><td>+</td><td>${escHtml(name)}</td><td>Added (${escHtml(labels)})</td></tr>`);
		} else if (enumMapA.get(name) !== labels) {
			enumRows.push(`<tr class="diff-changed"><td>~</td><td>${escHtml(name)}</td><td>${escHtml(enumMapA.get(name)!)} → ${escHtml(labels)}</td></tr>`);
		}
	}
	for (const name of enumMapA.keys()) {
		if (!enumMapB.has(name)) {
			enumRows.push(`<tr class="diff-removed"><td>-</td><td>${escHtml(name)}</td><td>Only in <strong>${escHtml(labelA)}</strong></td></tr>`);
		}
	}

	// ── Views ──
	const viewMapA = new Map(a.views.map(v => [v.table_name, v.view_definition || '']));
	const viewMapB = new Map(b.views.map(v => [v.table_name, v.view_definition || '']));
	
	let viewUnchanged = 0;
	const viewRows: string[] = [];
	
	for (const [name, defA] of viewMapA) {
		if (!viewMapB.has(name)) {
			viewRows.push(`<tr class="diff-removed"><td>-</td><td>${escHtml(name)}</td><td>Only in <strong>${escHtml(labelA)}</strong></td></tr>`);
		} else {
			const defB = viewMapB.get(name)!;
			if (defA !== defB) {
				const detailId = `view_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
				viewRows.push(`<tr class="diff-changed" onclick="toggleDetail('${detailId}')" style="cursor:pointer"><td>~</td><td>${escHtml(name)}</td><td>Definition changed <span style="color:var(--textLink-foreground)">(click to view diff)</span></td></tr>`);
				viewRows.push(`<tr id="${detailId}" class="diff-detail-row" style="display:none;"><td colspan="3">${getFunctionDiffHtml(detailId, name, defA, defB, labelA, labelB)}</td></tr>`);
			} else {
				viewUnchanged++;
			}
		}
	}
	for (const [name] of viewMapB) {
		if (!viewMapA.has(name)) {
			viewRows.push(`<tr class="diff-added"><td>+</td><td>${escHtml(name)}</td><td>Added in <strong>${escHtml(labelB)}</strong></td></tr>`);
		}
	}

	// ── Functions ──
	const funcMapA = new Map(a.functions.map(f => [f.function_name, f.function_definition || '']));
	const funcMapB = new Map(b.functions.map(f => [f.function_name, f.function_definition || '']));
	
	let funcUnchanged = 0;
	const functionRows: string[] = [];
	
	for (const [name, defA] of funcMapA) {
		if (!funcMapB.has(name)) {
			functionRows.push(`<tr class="diff-removed"><td>-</td><td>${escHtml(name)}</td><td>Only in <strong>${escHtml(labelA)}</strong></td></tr>`);
		} else {
			const defB = funcMapB.get(name)!;
			const normA = normalizeDefinition(defA);
			const normB = normalizeDefinition(defB);
			if (normA !== normB) {
				const detailId = `func_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
				functionRows.push(`<tr class="diff-changed" onclick="toggleDetail('${detailId}')" style="cursor:pointer"><td>~</td><td>${escHtml(name)}</td><td>Definition changed <span style="color:var(--textLink-foreground)">(click to view diff)</span></td></tr>`);
				functionRows.push(`<tr id="${detailId}" class="diff-detail-row" style="display:none;"><td colspan="3">${getFunctionDiffHtml(detailId, name, defA, defB, labelA, labelB)}</td></tr>`);
			} else {
				funcUnchanged++;
			}
		}
	}
	for (const [name] of funcMapB) {
		if (!funcMapA.has(name)) {
			functionRows.push(`<tr class="diff-added"><td>+</td><td>${escHtml(name)}</td><td>Added in <strong>${escHtml(labelB)}</strong></td></tr>`);
		}
	}

	// ── Procedures ──
	const procMapA = new Map(a.procedures.map(p => [p.procedure_name, p.procedure_definition || '']));
	const procMapB = new Map(b.procedures.map(p => [p.procedure_name, p.procedure_definition || '']));
	
	let procUnchanged = 0;
	const procedureRows: string[] = [];
	
	for (const [name, defA] of procMapA) {
		if (!procMapB.has(name)) {
			procedureRows.push(`<tr class="diff-removed"><td>-</td><td>${escHtml(name)}</td><td>Only in <strong>${escHtml(labelA)}</strong></td></tr>`);
		} else {
			const defB = procMapB.get(name)!;
			const normA = normalizeDefinition(defA);
			const normB = normalizeDefinition(defB);
			if (normA !== normB) {
				const detailId = `proc_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
				procedureRows.push(`<tr class="diff-changed" onclick="toggleDetail('${detailId}')" style="cursor:pointer"><td>~</td><td>${escHtml(name)}</td><td>Definition changed <span style="color:var(--textLink-foreground)">(click to view diff)</span></td></tr>`);
				procedureRows.push(`<tr id="${detailId}" class="diff-detail-row" style="display:none;"><td colspan="3">${getProcedureDiffHtml(detailId, name, defA, defB, labelA, labelB)}</td></tr>`);
			} else {
				procUnchanged++;
			}
		}
	}
	for (const [name] of procMapB) {
		if (!procMapA.has(name)) {
			procedureRows.push(`<tr class="diff-added"><td>+</td><td>${escHtml(name)}</td><td>Added in <strong>${escHtml(labelB)}</strong></td></tr>`);
		}
	}

	const buildSection = (sectionTitle: string, headers: string[], rows: string[]): string => {
		if (rows.length === 0) {
			return `<div class="diff-section"><h3>${sectionTitle}</h3><p class="empty-state">No differences</p></div>`;
		}
		const headerHtml = headers.map(h => `<th>${escHtml(h)}</th>`).join('');
		return `<div class="diff-section"><h3>${sectionTitle}</h3><table class="diff-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
	};

	// Calculate statistics for each object type
	const tableTotal = Object.keys(a.tables).length;
	const tableChanged = tableRows.length;
	const tableUnchanged = tableTotal - (addedTables.length + removedTables.length);
	
	const columnTotalA = Object.values(a.tables).reduce((sum, cols) => sum + cols.length, 0);
	const columnTotalB = Object.values(b.tables).reduce((sum, cols) => sum + cols.length, 0);
	const columnChanged = columnRows.length;
	
	const indexTotal = a.indexes.length;
	const indexChanged = indexRows.length;
	
	const enumTotal = a.enums.length;
	const enumChanged = enumRows.length;
	
	const viewTotalA = a.views.length;
	const viewTotalB = b.views.length;
	const viewChanged = viewRows.length;
	const viewUnchangedCount = viewTotalA - [...viewMapA.keys()].filter(n => !viewMapB.has(n)).length - [...viewMapA.keys()].filter(n => viewMapB.has(n) && viewMapA.get(n) !== viewMapB.get(n)).length;
	
	const funcTotalA = a.functions.length;
	const funcTotalB = b.functions.length;
	const funcChanged = functionRows.length;
	
	const procTotalA = a.procedures.length;
	const procTotalB = b.procedures.length;
	const procChanged = procedureRows.length;
	
	const totalChanges = tableRows.length + columnRows.length + indexRows.length + enumRows.length + viewRows.length + functionRows.length + procedureRows.length;

	// Build summary table
	const summaryRows = [
		`<tr><td>Tables</td><td>${tableTotal}</td><td>${tableUnchanged}</td><td>${addedTables.length}</td><td>${removedTables.length}</td><td>${tableChanged - addedTables.length - removedTables.length}</td></tr>`,
		`<tr><td>Columns</td><td>${columnTotalA}</td><td>${columnTotalA - columnChanged}</td><td>${columnRows.filter(r => r.includes('diff-added')).length}</td><td>${columnRows.filter(r => r.includes('diff-removed')).length}</td><td>${columnRows.filter(r => r.includes('diff-changed')).length}</td></tr>`,
		`<tr><td>Indexes</td><td>${indexTotal}</td><td>${indexTotal - indexChanged}</td><td>${indexRows.filter(r => r.includes('diff-added')).length}</td><td>${indexRows.filter(r => r.includes('diff-removed')).length}</td><td>${indexRows.filter(r => r.includes('diff-changed')).length}</td></tr>`,
		`<tr><td>Enums</td><td>${enumTotal}</td><td>${enumTotal - enumChanged}</td><td>${enumRows.filter(r => r.includes('diff-added')).length}</td><td>${enumRows.filter(r => r.includes('diff-removed')).length}</td><td>${enumRows.filter(r => r.includes('diff-changed')).length}</td></tr>`,
		`<tr><td>Views</td><td>${Math.max(viewTotalA, viewTotalB)}</td><td>${viewUnchanged}</td><td>${viewRows.filter(r => r.includes('diff-added')).length}</td><td>${viewRows.filter(r => r.includes('diff-removed')).length}</td><td>${viewRows.filter(r => r.includes('diff-changed')).length}</td></tr>`,
		`<tr><td>Functions</td><td>${Math.max(funcTotalA, funcTotalB)}</td><td>${funcUnchanged}</td><td>${functionRows.filter(r => r.includes('diff-added')).length}</td><td>${functionRows.filter(r => r.includes('diff-removed')).length}</td><td>${functionRows.filter(r => r.includes('diff-changed')).length}</td></tr>`,
		`<tr><td>Procedures</td><td>${Math.max(procTotalA, procTotalB)}</td><td>${procUnchanged}</td><td>${procedureRows.filter(r => r.includes('diff-added')).length}</td><td>${procedureRows.filter(r => r.includes('diff-removed')).length}</td><td>${procedureRows.filter(r => r.includes('diff-changed')).length}</td></tr>`,
	];

	sections.push(`<div class="diff-section">
		<h3>Summary — Comparing <strong>${escHtml(labelA)}</strong> vs <strong>${escHtml(labelB)}</strong></h3>
		<table class="diff-table" style="margin-bottom:16px;">
			<thead><tr><th>Object Type</th><th>Total</th><th>Unchanged</th><th>Added</th><th>Removed</th><th>Changed</th></tr></thead>
			<tbody>${summaryRows.join('')}</tbody>
		</table>
		<p style="padding:4px 0;font-size:12px;"><strong>${totalChanges}</strong> total difference(s) found</p>
	</div>`);
	
	sections.push(buildSection('Tables', ['', 'Table', 'Change'], tableRows));
	sections.push(buildSection('Columns', ['', 'Table.Column', 'Type', 'Change'], columnRows));
	sections.push(buildSection('Indexes', ['', 'Table.Index', 'Change'], indexRows));
	sections.push(buildSection('Enums', ['', 'Enum', 'Change'], enumRows));
	sections.push(buildSection('Views', ['', 'View', 'Change'], viewRows));
	sections.push(buildSection('Functions', ['', 'Function', 'Change'], functionRows));
	sections.push(buildSection('Procedures', ['', 'Procedure', 'Change'], procedureRows));

	return `<div class="rich-body">${sections.join('')}</div>`;
}

export class SchemaDiffPanel {
	private static panels: Map<string, vscode.WebviewPanel> = new Map();

	static async show(
		context: vscode.ExtensionContext,
		labelA: string,
		snapA: SchemaSnapshot,
		labelB: string,
		snapB: SchemaSnapshot,
		title: string
	): Promise<void> {
		const panelKey = `schemaDiff:${title}`;
		const existing = this.panels.get(panelKey);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'pgsqlSchemaDiff',
			title,
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		this.panels.set(panelKey, panel);

		panel.onDidDispose(() => {
			this.panels.delete(panelKey);
		});

		const html = diffSchemas(labelA, snapA, labelB, snapB);
		panel.webview.html = this.getHtml(title, html);
	}

	private static getHtml(title: string, content: string): string {
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
	*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

	html, body {
		width: 100%; height: 100%;
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		background: var(--vscode-panel-background);
		color: var(--vscode-foreground);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.rich-toolbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px;
		background: var(--vscode-editorGroupHeader-tabsBackground);
		border-bottom: 1px solid var(--vscode-panel-border);
		flex-shrink: 0;
		height: 35px;
	}

	.rich-title {
		font-weight: 600;
		font-size: 12px;
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rich-body {
		flex: 1;
		overflow: auto;
		padding: 8px 12px;
	}

	.diff-section { margin-bottom: 16px; }
	.diff-section h3 {
		font-size: 12px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--vscode-foreground);
		padding: 6px 0 4px;
		border-bottom: 1px solid var(--vscode-panel-border);
		margin-bottom: 6px;
	}

	.diff-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	.diff-table th {
		background: var(--vscode-editorGroupHeader-tabsBackground);
		padding: 4px 8px;
		text-align: left;
		font-weight: 600;
		border-bottom: 1px solid var(--vscode-panel-border);
	}
	.diff-table td {
		padding: 3px 8px;
		border-bottom: 1px solid var(--vscode-panel-border);
		vertical-align: top;
	}
	.diff-table tr:last-child td { border-bottom: none; }

	.diff-added { background: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.2)); }
	.diff-removed { background: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2)); }
	.diff-changed { background: var(--vscode-diffEditor-modifiedTextBackground, rgba(255, 200, 50, 0.2)); }

	.empty-state {
		color: var(--vscode-descriptionForeground);
		font-style: italic;
		padding: 4px 0;
	}
	
	.diff-detail { animation: fadeIn 0.2s ease-in-out; }
	.diff-detail-row td { padding: 0 !important; background: var(--vscode-editor-background); }
	.diff-detail-inner { 
		max-height: 400px; 
		overflow: auto; 
		padding: 8px;
	}
	.diff-code {
		margin: 0; padding: 4px; font-size: 11px; overflow-x: auto;
		background: var(--vscode-editor-background); border-radius: 4px;
		font-family: var(--vscode-editor-font-family, monospace);
		line-height: 1.4;
		max-height: 350px;
		overflow-x: auto;
		overflow-y: auto;
	}
	.diff-line { padding: 1px 4px; margin: 0; }
	.diff-line-added { background: var(--vscode-diffEditor-insertedTextBackground, #ddffdd); display: block; }
	.diff-line-removed { background: var(--vscode-diffEditor-removedTextBackground, #ffdddd); display: block; }
	.line-added { background: var(--vscode-diffEditor-insertedTextBackground, #ddffdd); }
	.line-removed { background: var(--vscode-diffEditor-removedTextBackground, #ffdddd); }
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
<script>
	function toggleDetail(id) {
		var el = document.getElementById(id);
		if (el) {
			el.style.display = el.style.display === 'none' ? 'block' : 'none';
		}
	}
</script>
</head>
<body>
	<div class="rich-toolbar">
		<span class="rich-title">${escHtml(title)}</span>
	</div>
	${content}
</body>
</html>`;
	}
}

export class SchemaDiffCommand {
	static register(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		context: vscode.ExtensionContext
	) {
		return vscode.commands.registerCommand('pgsql-tools.schemaDiff', async () => {
			const mode = await vscode.window.showQuickPick(
				[
					{ label: '$(database) DB vs DB', description: 'Compare two different database connections', value: 'db' },
					{ label: '$(symbol-namespace) Schema vs Schema', description: 'Compare two schemas in the same connection', value: 'schema' }
				],
				{ title: 'Schema Diff — Choose Mode', placeHolder: 'Select comparison mode' }
			);
			if (!mode) return;

			const connections = connectionManager.getConnections();
			if (connections.length === 0) {
				vscode.window.showErrorMessage('No active connections. Please add and connect first.');
				return;
			}

			try {
				if (mode.value === 'db') {
					// ── DB vs DB ──
					if (connections.length < 2) {
						vscode.window.showErrorMessage('DB vs DB comparison requires at least two active connections.');
						return;
					}

					const connAItem = await vscode.window.showQuickPick(
						connections.map(c => ({ label: c })),
						{ title: 'Schema Diff — Select Connection A', placeHolder: 'First connection' }
					);
					if (!connAItem) return;

					const connBItems = connections.filter(c => c !== connAItem.label);
					const connBItem = await vscode.window.showQuickPick(
						connBItems.map(c => ({ label: c })),
						{ title: 'Schema Diff — Select Connection B', placeHolder: 'Second connection' }
					);
					if (!connBItem) return;

					const schemaInput = await vscode.window.showInputBox({
						title: 'Schema Diff — Schema Name',
						prompt: 'Schema to compare in both databases',
						value: 'public'
					});
					if (schemaInput === undefined) return;
					const schemaName = schemaInput.trim() || 'public';

					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: 'Schema Diff', cancellable: false },
						async (progress) => {
							progress.report({ message: 'Loading schema A…' });
							const clientA = connectionManager.getConnectionByName(connAItem.label)!;
							const snapA = await getSchemaSnapshot(clientA, queryExecutor, schemaName);

							progress.report({ message: 'Loading schema B…' });
							const clientB = connectionManager.getConnectionByName(connBItem.label)!;
							const snapB = await getSchemaSnapshot(clientB, queryExecutor, schemaName);

						await SchemaDiffPanel.show(
							context,
							`${connAItem.label} (${schemaName})`,
							snapA,
							`${connBItem.label} (${schemaName})`,
							snapB,
							`Schema Diff: ${connAItem.label} vs ${connBItem.label} [${schemaName}]`
						);
						}
					);
				} else {
					// ── Schema vs Schema ──
					const connItem = await vscode.window.showQuickPick(
						connections.map(c => ({ label: c })),
						{ title: 'Schema Diff — Select Connection', placeHolder: 'Connection to use' }
					);
					if (!connItem) return;

					const client = connectionManager.getConnectionByName(connItem.label);
					if (!client) {
						vscode.window.showErrorMessage(`Connection "${connItem.label}" is not available.`);
						return;
					}

					// Get available schemas
					const schemasRes = await queryExecutor.executeQueryOnClient(
						client,
						`SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name != 'information_schema' ORDER BY schema_name`
					);
					const schemaNames = schemasRes.rows.map((r: any) => r.schema_name as string);

					const schemaAItem = await vscode.window.showQuickPick(
						schemaNames.map(s => ({ label: s })),
						{ title: 'Schema Diff — Select Schema A', placeHolder: 'First schema' }
					);
					if (!schemaAItem) return;

					const schemaBItems = schemaNames.filter(s => s !== schemaAItem.label);
					const schemaBItem = await vscode.window.showQuickPick(
						schemaBItems.map(s => ({ label: s })),
						{ title: 'Schema Diff — Select Schema B', placeHolder: 'Second schema' }
					);
					if (!schemaBItem) return;

					await vscode.window.withProgress(
						{ location: vscode.ProgressLocation.Notification, title: 'Schema Diff', cancellable: false },
						async (progress) => {
							progress.report({ message: `Loading schema "${schemaAItem.label}"…` });
							const snapA = await getSchemaSnapshot(client, queryExecutor, schemaAItem.label);

							progress.report({ message: `Loading schema "${schemaBItem.label}"…` });
							const snapB = await getSchemaSnapshot(client, queryExecutor, schemaBItem.label);

						await SchemaDiffPanel.show(
							context,
							schemaAItem.label,
							snapA,
							schemaBItem.label,
							snapB,
							`Schema Diff: ${schemaAItem.label} vs ${schemaBItem.label} (${connItem.label})`
						);
						}
					);
				}
			} catch (err) {
				vscode.window.showErrorMessage(`Schema Diff failed: ${err}`);
			}
		});
	}
}
