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

interface SchemaSnapshot {
	tables: Record<string, ColumnMeta[]>;
	indexes: IndexMeta[];
	constraints: ConstraintMeta[];
	views: ViewMeta[];
	enums: EnumMeta[];
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

	return {
		tables,
		indexes: idxRes.rows,
		constraints: conRes.rows,
		views: viewRes.rows,
		enums: enumRes.rows
	};
}

function escHtml(s: string): string {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
	const viewMapA = new Map(a.views.map(v => [v.table_name, v.view_definition]));
	const viewMapB = new Map(b.views.map(v => [v.table_name, v.view_definition]));
	const viewRows: string[] = [];
	for (const [name] of viewMapB) {
		if (!viewMapA.has(name)) {
			viewRows.push(`<tr class="diff-added"><td>+</td><td>${escHtml(name)}</td><td>Added in <strong>${escHtml(labelB)}</strong></td></tr>`);
		} else if (viewMapA.get(name) !== viewMapB.get(name)) {
			viewRows.push(`<tr class="diff-changed"><td>~</td><td>${escHtml(name)}</td><td>Definition changed</td></tr>`);
		}
	}
	for (const name of viewMapA.keys()) {
		if (!viewMapB.has(name)) {
			viewRows.push(`<tr class="diff-removed"><td>-</td><td>${escHtml(name)}</td><td>Only in <strong>${escHtml(labelA)}</strong></td></tr>`);
		}
	}

	const buildSection = (sectionTitle: string, headers: string[], rows: string[]): string => {
		if (rows.length === 0) {
			return `<div class="diff-section"><h3>${sectionTitle}</h3><p class="empty-state">No differences</p></div>`;
		}
		const headerHtml = headers.map(h => `<th>${escHtml(h)}</th>`).join('');
		return `<div class="diff-section"><h3>${sectionTitle}</h3><table class="diff-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
	};

	const totalChanges = tableRows.length + columnRows.length + indexRows.length + enumRows.length + viewRows.length;

	sections.push(`<div class="diff-section"><p style="padding:4px 0;font-size:12px;">Comparing <strong>${escHtml(labelA)}</strong> vs <strong>${escHtml(labelB)}</strong> — <strong>${totalChanges}</strong> difference(s) found</p></div>`);
	sections.push(buildSection('Tables', ['', 'Table', 'Change'], tableRows));
	sections.push(buildSection('Columns', ['', 'Table.Column', 'Type', 'Change'], columnRows));
	sections.push(buildSection('Indexes', ['', 'Table.Index', 'Change'], indexRows));
	sections.push(buildSection('Enums', ['', 'Enum', 'Change'], enumRows));
	sections.push(buildSection('Views', ['', 'View', 'Change'], viewRows));

	return `<div class="rich-body">${sections.join('')}</div>`;
}

export class SchemaDiffCommand {
	static register(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider: ResultsViewProvider
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

							const html = diffSchemas(
								`${connAItem.label} (${schemaName})`,
								snapA,
								`${connBItem.label} (${schemaName})`,
								snapB
							);
							await resultsViewProvider.showRichContent({
								type: 'html',
								title: `Schema Diff: ${connAItem.label} vs ${connBItem.label} [${schemaName}]`,
								content: html
							});
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

							const html = diffSchemas(schemaAItem.label, snapA, schemaBItem.label, snapB);
							await resultsViewProvider.showRichContent({
								type: 'html',
								title: `Schema Diff: ${schemaAItem.label} vs ${schemaBItem.label} (${connItem.label})`,
								content: html
							});
						}
					);
				}
			} catch (err) {
				vscode.window.showErrorMessage(`Schema Diff failed: ${err}`);
			}
		});
	}
}
