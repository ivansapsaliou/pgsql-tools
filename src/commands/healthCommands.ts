import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ResultsViewProvider } from '../views/resultsPanel';

function escHtml(s: string): string {
	return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildTable(columns: string[], rows: Record<string, any>[], badgeCol?: string): string {
	if (rows.length === 0) {
		return '<p class="empty-state">No rows returned.</p>';
	}
	const headers = columns.map(c => `<th>${escHtml(c)}</th>`).join('');
	const bodyRows = rows.map(row => {
		const cells = columns.map(col => {
			let val = String(row[col] ?? '');
			let cls = '';
			if (col === badgeCol) {
				const low = val.toLowerCase();
				if (low.includes('vacuum') || low.includes('analyze')) cls = 'badge-warn';
				else if (low === 'ok') cls = 'badge-ok';
				else if (low.includes('critical') || low.includes('never')) cls = 'badge-crit';
			}
			return `<td${cls ? ` class="${cls}"` : ''}>${escHtml(val)}</td>`;
		}).join('');
		return `<tr>${cells}</tr>`;
	}).join('');
	return `<table class="health-table"><thead><tr>${headers}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

function wrapBody(title: string, subtitle: string, tableHtml: string): string {
	return `<div class="rich-body">
		<p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:10px;">${escHtml(subtitle)}</p>
		${tableHtml}
	</div>`;
}

async function ensureActiveConnection(connectionManager: ConnectionManager): Promise<string | null> {
	const connections = connectionManager.getConnections();
	if (connections.length === 0) {
		vscode.window.showErrorMessage('No active connections. Please add and connect first.');
		return null;
	}
	const active = connectionManager.getActiveConnectionName();
	if (active) return active;
	return connections[0];
}

export class HealthCommands {
	static registerAll(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider: ResultsViewProvider
	): vscode.Disposable[] {
		return [
			HealthCommands.registerSlowQueries(queryExecutor, connectionManager, resultsViewProvider),
			HealthCommands.registerLocks(queryExecutor, connectionManager, resultsViewProvider),
			HealthCommands.registerSizes(queryExecutor, connectionManager, resultsViewProvider),
			HealthCommands.registerVacuum(queryExecutor, connectionManager, resultsViewProvider),
		];
	}

	// ── Slow Queries ──────────────────────────────────────────────────────────

	private static registerSlowQueries(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider: ResultsViewProvider
	) {
		return vscode.commands.registerCommand('pgsql-tools.healthSlowQueries', async () => {
			const connName = await ensureActiveConnection(connectionManager);
			if (!connName) return;

			const limitStr = await vscode.window.showInputBox({
				title: 'Slow Queries — Limit',
				prompt: 'Max number of queries to show',
				value: '20',
				validateInput: v => isNaN(parseInt(v)) ? 'Enter a number' : null
			});
			if (limitStr === undefined) return;
			const limit = Math.max(1, parseInt(limitStr) || 20);

			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Loading slow queries…', cancellable: false },
					async () => {
						// Check if pg_stat_statements is available
						const extCheck = await queryExecutor.executeQuery(
							`SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS available`
						);
						const available = extCheck.rows[0]?.available === true;

						if (!available) {
							await resultsViewProvider.showRichContent({
								type: 'html',
								title: 'Health: Slow Queries',
								content: `<div class="rich-body"><div class="empty-state">
									<p style="margin-bottom:8px;"><strong>pg_stat_statements extension is not enabled.</strong></p>
									<p>To enable it, run as a superuser:</p>
									<pre style="margin-top:8px;padding:8px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:3px;font-size:12px;">CREATE EXTENSION IF NOT EXISTS pg_stat_statements;</pre>
									<p style="margin-top:8px;color:var(--vscode-descriptionForeground);font-size:11px;">Note: You may also need to add <code>pg_stat_statements</code> to <code>shared_preload_libraries</code> in <code>postgresql.conf</code> and restart PostgreSQL.</p>
								</div></div>`
							});
							return;
						}

						const res = await queryExecutor.executeQuery(`
							SELECT
								LEFT(query, 200)             AS query,
								calls,
								ROUND(total_exec_time::numeric, 2) AS total_ms,
								ROUND(mean_exec_time::numeric, 2)  AS mean_ms,
								ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
								rows
							FROM pg_stat_statements
							ORDER BY mean_exec_time DESC
							LIMIT ${limit}
						`);

						const cols = ['query', 'calls', 'total_ms', 'mean_ms', 'stddev_ms', 'rows'];
						const tableHtml = buildTable(cols, res.rows);
						await resultsViewProvider.showRichContent({
							type: 'html',
							title: `Health: Slow Queries (top ${limit})`,
							content: wrapBody('Health: Slow Queries', `Top ${limit} slowest queries by mean execution time (ms) on "${connName}"`, tableHtml)
						});
					}
				);
			} catch (err) {
				vscode.window.showErrorMessage(`Slow Queries failed: ${err}`);
			}
		});
	}

	// ── Locks ─────────────────────────────────────────────────────────────────

	private static registerLocks(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider: ResultsViewProvider
	) {
		return vscode.commands.registerCommand('pgsql-tools.healthLocks', async () => {
			const connName = await ensureActiveConnection(connectionManager);
			if (!connName) return;

			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Loading lock information…', cancellable: false },
					async () => {
						const res = await queryExecutor.executeQuery(`
							SELECT
								blocked.pid                     AS blocked_pid,
								blocked.usename                 AS blocked_user,
								LEFT(blocked.query, 200)        AS blocked_query,
								blocked.state                   AS blocked_state,
								ROUND(EXTRACT(EPOCH FROM (now() - blocked.query_start))::numeric, 1) AS blocked_secs,
								blocking.pid                    AS blocking_pid,
								blocking.usename                AS blocking_user,
								LEFT(blocking.query, 200)       AS blocking_query
							FROM pg_stat_activity blocked
							JOIN pg_stat_activity blocking
								ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
							WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0
							ORDER BY blocked_secs DESC NULLS LAST
						`);

						let tableHtml: string;
						if (res.rows.length === 0) {
							tableHtml = '<p class="empty-state" style="color:var(--vscode-gitDecoration-addedResourceForeground,#57ab5a)">✓ No blocking locks detected.</p>';
						} else {
							const cols = ['blocked_pid', 'blocked_user', 'blocked_query', 'blocked_state', 'blocked_secs', 'blocking_pid', 'blocking_user', 'blocking_query'];
							tableHtml = buildTable(cols, res.rows);
						}

						await resultsViewProvider.showRichContent({
							type: 'html',
							title: `Health: Locks (${res.rows.length} blocking)`,
							content: wrapBody('Health: Locks', `Blocking/waiting processes on "${connName}"`, tableHtml)
						});
					}
				);
			} catch (err) {
				vscode.window.showErrorMessage(`Locks check failed: ${err}`);
			}
		});
	}

	// ── Sizes ─────────────────────────────────────────────────────────────────

	private static registerSizes(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider: ResultsViewProvider
	) {
		return vscode.commands.registerCommand('pgsql-tools.healthSizes', async () => {
			const connName = await ensureActiveConnection(connectionManager);
			if (!connName) return;

			const limitStr = await vscode.window.showInputBox({
				title: 'Table Sizes — Limit',
				prompt: 'Max number of tables to show',
				value: '50',
				validateInput: v => isNaN(parseInt(v)) ? 'Enter a number' : null
			});
			if (limitStr === undefined) return;
			const limit = Math.max(1, parseInt(limitStr) || 50);

			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Loading table sizes…', cancellable: false },
					async () => {
						const res = await queryExecutor.executeQuery(`
							SELECT
								schemaname                                                                 AS schema,
								tablename                                                                  AS table,
								pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename))         AS total_size,
								pg_size_pretty(pg_relation_size(schemaname||'.'||tablename))               AS table_size,
								pg_size_pretty(pg_indexes_size(schemaname||'.'||tablename))                AS indexes_size,
								pg_total_relation_size(schemaname||'.'||tablename)                         AS total_bytes
							FROM pg_tables
							WHERE schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
							ORDER BY total_bytes DESC
							LIMIT ${limit}
						`);

						const cols = ['schema', 'table', 'total_size', 'table_size', 'indexes_size'];
						const tableHtml = buildTable(cols, res.rows);
						await resultsViewProvider.showRichContent({
							type: 'html',
							title: `Health: Table & Index Sizes (top ${limit})`,
							content: wrapBody('Health: Sizes', `Top ${limit} tables by total size on "${connName}"`, tableHtml)
						});
					}
				);
			} catch (err) {
				vscode.window.showErrorMessage(`Sizes check failed: ${err}`);
			}
		});
	}

	// ── Vacuum Recommendations ────────────────────────────────────────────────

	private static registerVacuum(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		resultsViewProvider: ResultsViewProvider
	) {
		return vscode.commands.registerCommand('pgsql-tools.healthVacuum', async () => {
			const connName = await ensureActiveConnection(connectionManager);
			if (!connName) return;

			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'Loading vacuum stats…', cancellable: false },
					async () => {
						const res = await queryExecutor.executeQuery(`
							SELECT
								schemaname                  AS schema,
								relname                     AS table,
								n_dead_tup                  AS dead_tuples,
								n_live_tup                  AS live_tuples,
								TO_CHAR(last_vacuum,     'YYYY-MM-DD HH24:MI') AS last_vacuum,
								TO_CHAR(last_autovacuum, 'YYYY-MM-DD HH24:MI') AS last_autovacuum,
								TO_CHAR(last_analyze,    'YYYY-MM-DD HH24:MI') AS last_analyze,
								TO_CHAR(last_autoanalyze,'YYYY-MM-DD HH24:MI') AS last_autoanalyze,
								CASE
									WHEN n_dead_tup > 100000 THEN 'VACUUM critical (>100k dead tuples)'
									WHEN n_dead_tup > 10000
										AND last_vacuum IS NULL
										AND last_autovacuum IS NULL  THEN 'VACUUM recommended (never vacuumed)'
									WHEN n_dead_tup > 10000         THEN 'VACUUM recommended (>10k dead tuples)'
									WHEN last_analyze IS NULL
										AND last_autoanalyze IS NULL  THEN 'ANALYZE recommended (never analyzed)'
									ELSE 'OK'
								END                         AS recommendation
							FROM pg_stat_user_tables
							ORDER BY n_dead_tup DESC
						`);

						const cols = ['schema', 'table', 'dead_tuples', 'live_tuples', 'last_vacuum', 'last_autovacuum', 'last_analyze', 'last_autoanalyze', 'recommendation'];
						const tableHtml = buildTable(cols, res.rows, 'recommendation');
						await resultsViewProvider.showRichContent({
							type: 'html',
							title: 'Health: Vacuum / Analyze Recommendations',
							content: wrapBody('Health: Vacuum', `Vacuum/Analyze statistics for user tables on "${connName}"`, tableHtml)
						});
					}
				);
			} catch (err) {
				vscode.window.showErrorMessage(`Vacuum stats failed: ${err}`);
			}
		});
	}
}
