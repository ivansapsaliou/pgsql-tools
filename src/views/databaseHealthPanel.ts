import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';

export class DatabaseHealthPanel {
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

		const panelKey = `health:${activeConn}`;
		const existing = this.panels.get(panelKey);
		if (existing) {
			existing.reveal(vscode.ViewColumn.One);
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			'pgsqlHealth',
			`DB Health — ${activeConn}`,
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true }
		);

		this.panels.set(panelKey, panel);

		panel.onDidDispose(() => {
			this.panels.delete(panelKey);
		});

		panel.webview.html = this.getHtml(activeConn);

		// Handle messages from webview
		panel.webview.onDidReceiveMessage(async (message) => {
			if (message.command === 'fetchSection') {
				await this.fetchAndSend(panel, queryExecutor, activeConn, message.section);
			} else if (message.command === 'fetchAll') {
				const sections = ['overview', 'connections', 'slowQueries', 'locks', 'tableStats', 'indexHealth', 'vacuum', 'cacheHit', 'replication', 'bloat'];
				for (const section of sections) {
					await this.fetchAndSend(panel, queryExecutor, activeConn, section);
				}
			} else if (message.command === 'killPid') {
				try {
					await queryExecutor.executeQuery(`SELECT pg_terminate_backend(${parseInt(message.pid)})`);
					panel.webview.postMessage({ command: 'killResult', pid: message.pid, success: true });
					vscode.window.showInformationMessage(`Process ${message.pid} terminated.`);
				} catch (err) {
					panel.webview.postMessage({ command: 'killResult', pid: message.pid, success: false, error: String(err) });
				}
			}
		});

		// Auto-load all sections
		panel.webview.onDidReceiveMessage(async (message) => {
			// handled above
		});

		// Initial data load after panel is ready
		setTimeout(async () => {
			const sections = ['overview', 'connections', 'slowQueries', 'locks', 'tableStats', 'indexHealth', 'vacuum', 'cacheHit', 'replication', 'bloat'];
			for (const section of sections) {
				await this.fetchAndSend(panel, queryExecutor, activeConn, section);
			}
		}, 300);
	}

	private static async fetchAndSend(
		panel: vscode.WebviewPanel,
		queryExecutor: QueryExecutor,
		connName: string,
		section: string
	): Promise<void> {
		try {
			const data = await this.fetchSection(queryExecutor, section);
			panel.webview.postMessage({ command: 'sectionData', section, data, error: null });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			panel.webview.postMessage({ command: 'sectionData', section, data: null, error: msg });
		}
	}

	private static async fetchSection(queryExecutor: QueryExecutor, section: string): Promise<any> {
		switch (section) {
			case 'overview':
				return this.fetchOverview(queryExecutor);
			case 'connections':
				return this.fetchConnections(queryExecutor);
			case 'slowQueries':
				return this.fetchSlowQueries(queryExecutor);
			case 'locks':
				return this.fetchLocks(queryExecutor);
			case 'tableStats':
				return this.fetchTableStats(queryExecutor);
			case 'indexHealth':
				return this.fetchIndexHealth(queryExecutor);
			case 'vacuum':
				return this.fetchVacuum(queryExecutor);
			case 'cacheHit':
				return this.fetchCacheHit(queryExecutor);
			case 'replication':
				return this.fetchReplication(queryExecutor);
			case 'bloat':
				return this.fetchBloat(queryExecutor);
			default:
				return null;
		}
	}

	private static async fetchOverview(qe: QueryExecutor): Promise<any> {
		const dbRes = await qe.executeQuery(`
			SELECT
				current_database()                          AS db_name,
				pg_size_pretty(pg_database_size(current_database())) AS db_size,
				version()                                   AS pg_version,
				(SELECT count(*) FROM pg_stat_activity WHERE state = 'active')::int AS active_connections,
				(SELECT count(*) FROM pg_stat_activity)::int AS total_connections,
				(SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections,
				(SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock')::int AS waiting_queries,
				(SELECT count(*) FROM pg_stat_user_tables)::int AS user_tables,
				now() AS server_time,
				(SELECT pg_postmaster_start_time()) AS start_time
		`);

		const txRes = await qe.executeQuery(`
			SELECT
				xact_commit AS commits,
				xact_rollback AS rollbacks,
				blks_hit,
				blks_read,
				CASE WHEN (blks_hit + blks_read) > 0
					THEN ROUND(100.0 * blks_hit / (blks_hit + blks_read), 2)
					ELSE 0
				END AS cache_hit_ratio
			FROM pg_stat_database
			WHERE datname = current_database()
		`);

		return {
			db: dbRes.rows[0],
			tx: txRes.rows[0]
		};
	}

	private static async fetchConnections(qe: QueryExecutor): Promise<any> {
		const res = await qe.executeQuery(`
			SELECT
				pid,
				usename,
				application_name,
				client_addr,
				state,
				wait_event_type,
				wait_event,
				ROUND(EXTRACT(EPOCH FROM (now() - query_start))::numeric, 1) AS query_secs,
				ROUND(EXTRACT(EPOCH FROM (now() - state_change))::numeric, 1) AS state_secs,
				LEFT(query, 120) AS query
			FROM pg_stat_activity
			WHERE pid <> pg_backend_pid()
			ORDER BY query_secs DESC NULLS LAST
			LIMIT 50
		`);
		return res.rows;
	}

	private static async fetchSlowQueries(qe: QueryExecutor): Promise<any> {
		// Check if pg_stat_statements is available
		const extCheck = await qe.executeQuery(`
			SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS available
		`);
		const available = extCheck.rows[0]?.available === true;

		if (!available) {
			return { available: false };
		}

		const res = await qe.executeQuery(`
			SELECT
				LEFT(query, 200) AS query,
				calls,
				ROUND(total_exec_time::numeric, 2) AS total_ms,
				ROUND(mean_exec_time::numeric, 2) AS mean_ms,
				ROUND(min_exec_time::numeric, 2) AS min_ms,
				ROUND(max_exec_time::numeric, 2) AS max_ms,
				ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
				rows,
				ROUND(100.0 * shared_blks_hit / NULLIF(shared_blks_hit + shared_blks_read, 0), 2) AS hit_pct
			FROM pg_stat_statements
			ORDER BY mean_exec_time DESC
			LIMIT 25
		`);
		return { available: true, rows: res.rows };
	}

	private static async fetchLocks(qe: QueryExecutor): Promise<any> {
		const res = await qe.executeQuery(`
			SELECT
				blocked.pid                     AS blocked_pid,
				blocked.usename                 AS blocked_user,
				LEFT(blocked.query, 150)        AS blocked_query,
				blocked.state                   AS blocked_state,
				ROUND(EXTRACT(EPOCH FROM (now() - blocked.query_start))::numeric, 1) AS blocked_secs,
				blocking.pid                    AS blocking_pid,
				blocking.usename                AS blocking_user,
				LEFT(blocking.query, 150)       AS blocking_query
			FROM pg_stat_activity blocked
			JOIN pg_stat_activity blocking
				ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
			WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0
			ORDER BY blocked_secs DESC NULLS LAST
		`);
		return res.rows;
	}

	private static async fetchTableStats(qe: QueryExecutor): Promise<any> {
		const res = await qe.executeQuery(`
			SELECT
				schemaname,
				relname AS table_name,
				pg_size_pretty(pg_total_relation_size(schemaname||'.'||relname)) AS total_size,
				pg_size_pretty(pg_relation_size(schemaname||'.'||relname)) AS table_size,
				pg_size_pretty(pg_indexes_size(schemaname||'.'||relname)) AS indexes_size,
				pg_total_relation_size(schemaname||'.'||relname) AS total_bytes,
				n_live_tup AS live_tuples,
				n_dead_tup AS dead_tuples,
				ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
				seq_scan,
				idx_scan,
				ROUND(100.0 * idx_scan / NULLIF(seq_scan + idx_scan, 0), 1) AS idx_scan_pct,
				n_mod_since_analyze
			FROM pg_stat_user_tables
			WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
			ORDER BY total_bytes DESC NULLS LAST
			LIMIT 30
		`);
		return res.rows;
	}

	private static async fetchIndexHealth(qe: QueryExecutor): Promise<any> {
		const unusedRes = await qe.executeQuery(`
			SELECT
				schemaname,
				tablename,
				indexname,
				pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
				pg_relation_size(indexrelid) AS size_bytes,
				idx_scan,
				idx_tup_read,
				idx_tup_fetch
			FROM pg_stat_user_indexes
			JOIN pg_index ON pg_index.indexrelid = pg_stat_user_indexes.indexrelid
			WHERE NOT indisunique AND NOT indisprimary
			ORDER BY idx_scan ASC, size_bytes DESC
			LIMIT 20
		`);

		const dupRes = await qe.executeQuery(`
			SELECT
				indrelid::regclass AS table_name,
				array_agg(indexrelid::regclass) AS duplicate_indexes,
				count(*) AS count
			FROM pg_index
			GROUP BY indrelid, indkey
			HAVING count(*) > 1
			LIMIT 10
		`).catch(() => ({ rows: [] }));

		return { unused: unusedRes.rows, duplicates: dupRes.rows };
	}

	private static async fetchVacuum(qe: QueryExecutor): Promise<any> {
		const res = await qe.executeQuery(`
			SELECT
				schemaname,
				relname AS table_name,
				n_dead_tup AS dead_tuples,
				n_live_tup AS live_tuples,
				ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS bloat_pct,
				TO_CHAR(last_vacuum,      'YYYY-MM-DD HH24:MI') AS last_vacuum,
				TO_CHAR(last_autovacuum,  'YYYY-MM-DD HH24:MI') AS last_autovacuum,
				TO_CHAR(last_analyze,     'YYYY-MM-DD HH24:MI') AS last_analyze,
				TO_CHAR(last_autoanalyze, 'YYYY-MM-DD HH24:MI') AS last_autoanalyze,
				n_mod_since_analyze,
				CASE
					WHEN n_dead_tup > 100000                              THEN 'critical'
					WHEN n_dead_tup > 10000 AND last_autovacuum IS NULL   THEN 'warning'
					WHEN n_dead_tup > 10000                               THEN 'warning'
					WHEN last_analyze IS NULL AND last_autoanalyze IS NULL THEN 'info'
					ELSE 'ok'
				END AS status
			FROM pg_stat_user_tables
			ORDER BY n_dead_tup DESC, bloat_pct DESC NULLS LAST
			LIMIT 30
		`);
		return res.rows;
	}

	private static async fetchCacheHit(qe: QueryExecutor): Promise<any> {
		const dbRes = await qe.executeQuery(`
			SELECT
				datname,
				blks_hit,
				blks_read,
				CASE WHEN (blks_hit + blks_read) > 0
					THEN ROUND(100.0 * blks_hit / (blks_hit + blks_read), 2)
					ELSE 100.0
				END AS cache_hit_ratio,
				xact_commit,
				xact_rollback,
				deadlocks,
				temp_files,
				pg_size_pretty(temp_bytes) AS temp_size
			FROM pg_stat_database
			WHERE datname NOT IN ('template0', 'template1')
			ORDER BY datname
		`);

		const tableRes = await qe.executeQuery(`
			SELECT
				schemaname,
				relname AS table_name,
				heap_blks_hit,
				heap_blks_read,
				CASE WHEN (heap_blks_hit + heap_blks_read) > 0
					THEN ROUND(100.0 * heap_blks_hit / (heap_blks_hit + heap_blks_read), 2)
					ELSE 100.0
				END AS cache_hit_ratio,
				idx_blks_hit,
				idx_blks_read
			FROM pg_statio_user_tables
			WHERE (heap_blks_hit + heap_blks_read) > 0
			ORDER BY (heap_blks_hit + heap_blks_read) DESC
			LIMIT 20
		`);

		return { databases: dbRes.rows, tables: tableRes.rows };
	}

	private static async fetchReplication(qe: QueryExecutor): Promise<any> {
		const replRes = await qe.executeQuery(`
			SELECT
				client_addr,
				usename,
				application_name,
				state,
				sync_state,
				sent_lsn,
				write_lsn,
				flush_lsn,
				replay_lsn,
				pg_size_pretty(pg_wal_lsn_diff(sent_lsn, replay_lsn)) AS replication_lag_size,
				write_lag,
				flush_lag,
				replay_lag
			FROM pg_stat_replication
		`).catch(() => ({ rows: [] }));

		const walRes = await qe.executeQuery(`
			SELECT
				(SELECT count(*) FROM pg_ls_waldir()) AS wal_files,
				pg_size_pretty((SELECT sum(size) FROM pg_ls_waldir())) AS wal_size,
				pg_is_in_recovery() AS is_replica,
				pg_walfile_name(pg_current_wal_lsn()) AS current_wal
		`).catch(() => ({ rows: [{ wal_files: null, wal_size: null, is_replica: null, current_wal: null }] }));

		return { replication: replRes.rows, wal: walRes.rows[0] };
	}

	private static async fetchBloat(qe: QueryExecutor): Promise<any> {
		const res = await qe.executeQuery(`
			SELECT
				current_database() AS db,
				schemaname,
				tablename,
				ROUND(CASE WHEN otta=0 THEN 0.0 ELSE sml.relpages/otta::numeric END,1) AS tbloat,
				CASE WHEN relpages < otta THEN 0 ELSE (bs*(sml.relpages-otta))::bigint END AS wastedbytes,
				pg_size_pretty(CASE WHEN relpages < otta THEN 0 ELSE (bs*(sml.relpages-otta))::bigint END) AS wasted_size,
				iname,
				ROUND(CASE WHEN iotta=0 OR ipages=0 THEN 0.0 ELSE ipages/iotta::numeric END,1) AS ibloat,
				CASE WHEN ipages < iotta THEN 0 ELSE (bs*(ipages-iotta))::bigint END AS wastedibytes,
				pg_size_pretty(CASE WHEN ipages < iotta THEN 0 ELSE (bs*(ipages-iotta))::bigint END) AS wasted_isize
			FROM (
				SELECT
					schemaname, tablename, cc.reltuples, cc.relpages, bs,
					CEIL((cc.reltuples*((datahdr+ma- (CASE WHEN datahdr%ma=0 THEN ma ELSE datahdr%ma END))+nullhdr2+4))/(bs-20::float)) AS otta,
					COALESCE(c2.relname,'?') AS iname,
					COALESCE(c2.reltuples,0) AS ituples,
					COALESCE(c2.relpages,0) AS ipages,
					COALESCE(CEIL((c2.reltuples*(datahdr-12))/(bs-20::float)),0) AS iotta
				FROM (
					SELECT
						ma, bs, schemaname, tablename,
						(datawidth+(hdr+ma-(CASE WHEN hdr%ma=0 THEN ma ELSE hdr%ma END)))::numeric AS datahdr,
						(maxfracsum*(nullhdr+ma-(CASE WHEN nullhdr%ma=0 THEN ma ELSE nullhdr%ma END))) AS nullhdr2
					FROM (
						SELECT
							schemaname, tablename, hdr, ma, bs,
							SUM((1-null_frac)*avg_width) AS datawidth,
							MAX(null_frac) AS maxfracsum,
							hdr+(
								SELECT 1+count(*)/8 FROM pg_stats s2
								WHERE null_frac<>0 AND s2.schemaname = s.schemaname AND s2.tablename = s.tablename
							) AS nullhdr
						FROM pg_stats s, (
							SELECT
								(SELECT current_setting('block_size')::numeric) AS bs,
								CASE WHEN substring(split_part(v, ' ', 2) FROM '#"[0-9]+.[0-9]+#"%' FOR '#')
									IN ('8.0','8.1','8.2') THEN 27 ELSE 23 END AS hdr,
								CASE WHEN v ~ 'mingw32' THEN 8 ELSE 4 END AS ma
							FROM (SELECT version() AS v) AS foo
						) AS constants
						GROUP BY 1,2,3,4,5
					) AS foo
				) AS rs
				JOIN pg_class cc ON cc.relname = rs.tablename
				JOIN pg_namespace nn ON cc.relnamespace = nn.oid AND nn.nspname = rs.schemaname AND nn.nspname <> 'information_schema'
				LEFT JOIN pg_index i ON indrelid = cc.oid
				LEFT JOIN pg_class c2 ON c2.oid = i.indexrelid
			) AS sml
			WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
			ORDER BY wastedbytes DESC NULLS LAST
			LIMIT 20
		`).catch(() => ({ rows: [] }));

		return res.rows;
	}

	private static getHtml(connName: string): string {
		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
	*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

	:root {
		--accent: #4d9cf5;
		--accent-dim: rgba(77,156,245,0.15);
		--ok: #4ec9b0;
		--ok-bg: rgba(78,201,176,0.12);
		--warn: #d2a22a;
		--warn-bg: rgba(210,162,42,0.12);
		--crit: #e5534b;
		--crit-bg: rgba(229,83,75,0.12);
		--info: #7eb8f5;
		--info-bg: rgba(126,184,245,0.1);
		--border: var(--vscode-panel-border);
		--bg: var(--vscode-editor-background);
		--bg2: var(--vscode-editorGroupHeader-tabsBackground);
		--bg3: var(--vscode-sideBar-background, #1e1e1e);
		--fg: var(--vscode-foreground);
		--fg2: var(--vscode-descriptionForeground);
		--font: var(--vscode-font-family);
		--mono: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
		--font-size: var(--vscode-font-size, 13px);
	}

	html, body {
		width: 100%; height: 100%;
		font-family: var(--font);
		font-size: var(--font-size);
		background: var(--bg);
		color: var(--fg);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	/* ── TOP NAV ── */
	.topbar {
		display: flex;
		align-items: center;
		gap: 0;
		background: var(--bg2);
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.topbar::-webkit-scrollbar { display: none; }

	.nav-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 14px;
		font-size: 11px;
		font-weight: 500;
		cursor: pointer;
		border-bottom: 2px solid transparent;
		color: var(--fg2);
		white-space: nowrap;
		transition: all 0.15s;
		user-select: none;
	}
	.nav-item:hover { color: var(--fg); background: rgba(255,255,255,0.03); }
	.nav-item.active { color: var(--accent); border-bottom-color: var(--accent); }

	.nav-dot {
		width: 7px; height: 7px;
		border-radius: 50%;
		background: var(--fg2);
		opacity: 0.3;
		flex-shrink: 0;
	}
	.nav-dot.ok { background: var(--ok); opacity: 1; }
	.nav-dot.warn { background: var(--warn); opacity: 1; }
	.nav-dot.crit { background: var(--crit); opacity: 1; }
	.nav-dot.loading { background: var(--accent); opacity: 0.6; animation: pulse 1s infinite; }

	@keyframes pulse { 0%,100%{opacity:0.3} 50%{opacity:1} }
	@keyframes spin { to { transform: rotate(360deg); } }
	@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

	.refresh-btn {
		margin-left: auto;
		padding: 6px 14px;
		font-size: 11px;
		cursor: pointer;
		background: none;
		border: none;
		color: var(--fg2);
		display: flex;
		align-items: center;
		gap: 5px;
		flex-shrink: 0;
	}
	.refresh-btn:hover { color: var(--accent); }
	.refresh-btn.spinning .icon { animation: spin 1s linear infinite; }

	/* ── MAIN CONTENT ── */
	.content {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
	}

	.section {
		display: none;
		animation: fadeIn 0.2s ease;
		padding: 16px;
	}
	.section.active { display: block; }

	/* ── CARDS GRID ── */
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
		gap: 10px;
		margin-bottom: 16px;
	}

	.card {
		background: var(--bg2);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 12px 14px;
		position: relative;
		overflow: hidden;
	}
	.card::before {
		content: '';
		position: absolute;
		left: 0; top: 0; bottom: 0;
		width: 3px;
		border-radius: 6px 0 0 6px;
		background: var(--border);
	}
	.card.ok::before { background: var(--ok); }
	.card.warn::before { background: var(--warn); }
	.card.crit::before { background: var(--crit); }
	.card.accent::before { background: var(--accent); }

	.card-label {
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--fg2);
		margin-bottom: 6px;
	}

	.card-value {
		font-size: 22px;
		font-weight: 700;
		line-height: 1;
		color: var(--fg);
		font-family: var(--mono);
	}
	.card-value.large { font-size: 15px; }

	.card-sub {
		font-size: 10px;
		color: var(--fg2);
		margin-top: 4px;
	}

	/* ── GAUGE BAR ── */
	.gauge-wrap {
		margin-top: 8px;
	}
	.gauge-bar {
		height: 4px;
		background: rgba(255,255,255,0.08);
		border-radius: 2px;
		overflow: hidden;
	}
	.gauge-fill {
		height: 100%;
		border-radius: 2px;
		background: var(--ok);
		transition: width 0.5s ease;
	}
	.gauge-fill.warn { background: var(--warn); }
	.gauge-fill.crit { background: var(--crit); }

	/* ── SECTION HEADER ── */
	.section-header {
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.07em;
		color: var(--fg2);
		padding: 0 0 8px;
		border-bottom: 1px solid var(--border);
		margin-bottom: 12px;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.section-header .badge {
		background: var(--accent-dim);
		color: var(--accent);
		padding: 1px 7px;
		border-radius: 10px;
		font-size: 10px;
		font-weight: 600;
		font-family: var(--mono);
	}

	/* ── TABLE ── */
	.tbl-wrap {
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
		margin-bottom: 16px;
	}
	.tbl-wrap + .section-header { margin-top: 8px; }

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 11.5px;
	}

	thead { position: sticky; top: 0; z-index: 5; }

	th {
		background: var(--bg2);
		color: var(--fg2);
		font-weight: 600;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 7px 10px;
		text-align: left;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}

	td {
		padding: 5px 10px;
		border-bottom: 1px solid rgba(128,128,128,0.06);
		vertical-align: middle;
		max-width: 300px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	tr:last-child td { border-bottom: none; }
	tr:hover td { background: rgba(255,255,255,0.025); }

	.mono { font-family: var(--mono); font-size: 11px; }

	/* ── STATUS PILLS ── */
	.pill {
		display: inline-block;
		padding: 1px 8px;
		border-radius: 10px;
		font-size: 10px;
		font-weight: 600;
	}
	.pill.ok { background: var(--ok-bg); color: var(--ok); }
	.pill.warn { background: var(--warn-bg); color: var(--warn); }
	.pill.crit { background: var(--crit-bg); color: var(--crit); }
	.pill.info { background: var(--info-bg); color: var(--info); }
	.pill.active { background: rgba(77,156,245,0.15); color: var(--accent); }
	.pill.idle { background: rgba(255,255,255,0.06); color: var(--fg2); }

	/* ── NUM BARS ── */
	.num-bar-wrap { display: flex; align-items: center; gap: 7px; }
	.num-bar-bg { flex: 1; height: 3px; background: rgba(255,255,255,0.07); border-radius: 2px; overflow: hidden; min-width: 40px; }
	.num-bar-fg { height: 100%; border-radius: 2px; background: var(--accent); }
	.num-bar-fg.warn { background: var(--warn); }
	.num-bar-fg.crit { background: var(--crit); }

	/* ── EMPTY / LOADING ── */
	.loading-state {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 40px 20px;
		color: var(--fg2);
		font-size: 12px;
	}
	.spinner {
		width: 16px; height: 16px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 40px 20px;
		gap: 8px;
		color: var(--fg2);
		font-size: 12px;
		text-align: center;
	}
	.empty-icon { font-size: 28px; opacity: 0.4; }

	.error-state {
		padding: 12px 14px;
		background: var(--crit-bg);
		border: 1px solid rgba(229,83,75,0.2);
		border-radius: 6px;
		color: var(--crit);
		font-size: 11px;
		font-family: var(--mono);
		word-break: break-all;
		margin-bottom: 12px;
	}

	/* ── ALERT BANNER ── */
	.alert {
		padding: 10px 14px;
		border-radius: 6px;
		font-size: 11.5px;
		margin-bottom: 12px;
		border-left: 3px solid;
	}
	.alert.warn { background: var(--warn-bg); border-color: var(--warn); color: var(--warn); }
	.alert.info { background: var(--info-bg); border-color: var(--info); color: var(--info); }
	.alert code {
		font-family: var(--mono);
		background: rgba(255,255,255,0.08);
		padding: 1px 5px;
		border-radius: 3px;
		font-size: 11px;
	}

	/* ── KILL BUTTON ── */
	.kill-btn {
		background: none;
		border: 1px solid rgba(229,83,75,0.3);
		color: var(--crit);
		font-size: 10px;
		padding: 2px 7px;
		border-radius: 3px;
		cursor: pointer;
		transition: all 0.15s;
	}
	.kill-btn:hover { background: var(--crit-bg); border-color: var(--crit); }

	/* ── PROGRESS ROW (cache hit) ── */
	.progress-row {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 0;
		border-bottom: 1px solid rgba(128,128,128,0.06);
	}
	.progress-row:last-child { border-bottom: none; }
	.progress-label { font-size: 11px; min-width: 140px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.progress-bar-wrap { flex: 1; height: 6px; background: rgba(255,255,255,0.07); border-radius: 3px; overflow: hidden; }
	.progress-bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s ease; }
	.progress-val { font-size: 11px; font-family: var(--mono); min-width: 45px; text-align: right; }

	.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
	@media (max-width: 700px) { .two-col { grid-template-columns: 1fr; } }

	.subsection { margin-bottom: 20px; }

	.tag {
		display: inline-block;
		padding: 1px 6px;
		border-radius: 3px;
		font-size: 10px;
		font-family: var(--mono);
		background: rgba(255,255,255,0.06);
		color: var(--fg2);
	}
</style>
</head>
<body>

<div class="topbar">
	<div class="nav-item active" data-section="overview">
		<span class="nav-dot loading" id="dot-overview"></span>
		Overview
	</div>
	<div class="nav-item" data-section="connections">
		<span class="nav-dot loading" id="dot-connections"></span>
		Connections
	</div>
	<div class="nav-item" data-section="slowQueries">
		<span class="nav-dot loading" id="dot-slowQueries"></span>
		Slow Queries
	</div>
	<div class="nav-item" data-section="locks">
		<span class="nav-dot loading" id="dot-locks"></span>
		Locks
	</div>
	<div class="nav-item" data-section="tableStats">
		<span class="nav-dot loading" id="dot-tableStats"></span>
		Tables
	</div>
	<div class="nav-item" data-section="indexHealth">
		<span class="nav-dot loading" id="dot-indexHealth"></span>
		Indexes
	</div>
	<div class="nav-item" data-section="vacuum">
		<span class="nav-dot loading" id="dot-vacuum"></span>
		Vacuum
	</div>
	<div class="nav-item" data-section="cacheHit">
		<span class="nav-dot loading" id="dot-cacheHit"></span>
		Cache
	</div>
	<div class="nav-item" data-section="replication">
		<span class="nav-dot loading" id="dot-replication"></span>
		Replication
	</div>
	<div class="nav-item" data-section="bloat">
		<span class="nav-dot loading" id="dot-bloat"></span>
		Bloat
	</div>
	<button class="refresh-btn" id="refreshBtn">
		<span class="icon">↻</span> Refresh
	</button>
</div>

<div class="content">

	<!-- OVERVIEW -->
	<div class="section active" id="section-overview">
		<div id="overview-content">
			<div class="loading-state"><div class="spinner"></div> Loading overview…</div>
		</div>
	</div>

	<!-- CONNECTIONS -->
	<div class="section" id="section-connections">
		<div id="connections-content">
			<div class="loading-state"><div class="spinner"></div> Loading connections…</div>
		</div>
	</div>

	<!-- SLOW QUERIES -->
	<div class="section" id="section-slowQueries">
		<div id="slowQueries-content">
			<div class="loading-state"><div class="spinner"></div> Loading slow queries…</div>
		</div>
	</div>

	<!-- LOCKS -->
	<div class="section" id="section-locks">
		<div id="locks-content">
			<div class="loading-state"><div class="spinner"></div> Checking for locks…</div>
		</div>
	</div>

	<!-- TABLE STATS -->
	<div class="section" id="section-tableStats">
		<div id="tableStats-content">
			<div class="loading-state"><div class="spinner"></div> Loading table statistics…</div>
		</div>
	</div>

	<!-- INDEX HEALTH -->
	<div class="section" id="section-indexHealth">
		<div id="indexHealth-content">
			<div class="loading-state"><div class="spinner"></div> Analyzing indexes…</div>
		</div>
	</div>

	<!-- VACUUM -->
	<div class="section" id="section-vacuum">
		<div id="vacuum-content">
			<div class="loading-state"><div class="spinner"></div> Loading vacuum stats…</div>
		</div>
	</div>

	<!-- CACHE HIT -->
	<div class="section" id="section-cacheHit">
		<div id="cacheHit-content">
			<div class="loading-state"><div class="spinner"></div> Calculating cache hit ratios…</div>
		</div>
	</div>

	<!-- REPLICATION -->
	<div class="section" id="section-replication">
		<div id="replication-content">
			<div class="loading-state"><div class="spinner"></div> Checking replication…</div>
		</div>
	</div>

	<!-- BLOAT -->
	<div class="section" id="section-bloat">
		<div id="bloat-content">
			<div class="loading-state"><div class="spinner"></div> Calculating table bloat…</div>
		</div>
	</div>

</div>

<script>
const vscode = acquireVsCodeApi();
const connName = ${JSON.stringify(connName)};

// ── NAV ──
document.querySelectorAll('.nav-item').forEach(item => {
	item.addEventListener('click', () => {
		document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
		document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
		item.classList.add('active');
		document.getElementById('section-' + item.dataset.section).classList.add('active');
	});
});

// ── REFRESH ──
document.getElementById('refreshBtn').addEventListener('click', () => {
	const btn = document.getElementById('refreshBtn');
	btn.classList.add('spinning');
	// Reset all dots to loading
	document.querySelectorAll('.nav-dot').forEach(d => { d.className = 'nav-dot loading'; });
	vscode.postMessage({ command: 'fetchAll' });
	setTimeout(() => btn.classList.remove('spinning'), 2000);
});

// ── HELPERS ──
function esc(s) {
	return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function pill(label, cls) {
	return '<span class="pill ' + (cls||'') + '">' + esc(label) + '</span>';
}

function numBar(val, max, cls) {
	const pct = Math.min(100, (val / max) * 100);
	return '<div class="num-bar-wrap"><span class="mono">' + esc(String(val ?? 0)) + '</span><div class="num-bar-bg"><div class="num-bar-fg ' + (cls||'') + '" style="width:' + pct + '%"></div></div></div>';
}

function progressBar(val, max, label) {
	const pct = Math.min(100, parseFloat(val) || 0);
	const cls = pct >= 99 ? '' : pct >= 95 ? 'warn' : 'crit';
	const color = pct >= 99 ? '#4ec9b0' : pct >= 95 ? '#d2a22a' : '#e5534b';
	return '<div class="progress-row"><span class="progress-label">' + esc(label) + '</span><div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div><span class="progress-val mono">' + pct + '%</span></div>';
}

function setDot(section, status) {
	const dot = document.getElementById('dot-' + section);
	if (!dot) return;
	dot.className = 'nav-dot ' + (status || 'ok');
}

// ── RENDER FUNCTIONS ──

function renderOverview(data) {
	if (!data) { document.getElementById('overview-content').innerHTML = '<div class="error-state">Failed to load</div>'; return; }
	const db = data.db || {};
	const tx = data.tx || {};

	const connPct = db.total_connections && db.max_connections
		? Math.round(100 * db.total_connections / db.max_connections)
		: 0;
	const connCls = connPct > 80 ? 'crit' : connPct > 60 ? 'warn' : 'ok';

	const cacheRatio = parseFloat(tx.cache_hit_ratio) || 0;
	const cacheCls = cacheRatio >= 99 ? 'ok' : cacheRatio >= 95 ? 'warn' : 'crit';

	const waitingCls = (db.waiting_queries || 0) > 0 ? 'warn' : 'ok';

	// Overall health
	const issues = [];
	if (connPct > 80) issues.push('High connection usage');
	if ((db.waiting_queries || 0) > 0) issues.push(db.waiting_queries + ' waiting queries');
	if (cacheRatio < 95) issues.push('Low cache hit ratio');
	const overallCls = issues.length === 0 ? 'ok' : issues.length <= 1 ? 'warn' : 'crit';

	setDot('overview', overallCls);

	const startTime = db.start_time ? new Date(db.start_time) : null;
	const uptime = startTime ? formatUptime(Date.now() - startTime.getTime()) : 'N/A';
	const pgVersion = db.pg_version ? db.pg_version.split(' ').slice(0,2).join(' ') : 'N/A';

	let html = '<div class="cards">';
	html += cardHtml('Database', db.db_name || 'N/A', db.db_size || '', 'accent');
	html += cardHtml('PostgreSQL', pgVersion, 'Server version', 'accent');
	html += cardHtml('Uptime', uptime, 'Since ' + (startTime ? startTime.toLocaleDateString() : '?'), 'ok');
	html += cardHtml('Connections', db.total_connections || 0, db.active_connections + ' active / ' + db.max_connections + ' max', connCls, connPct);
	html += cardHtml('Waiting', db.waiting_queries || 0, 'lock-waiting queries', waitingCls);
	html += cardHtml('Cache Hit', cacheRatio + '%', 'Buffer cache hit ratio', cacheCls, cacheRatio);
	html += cardHtml('Tables', db.user_tables || 0, 'user tables', 'accent');
	html += cardHtml('Commits', formatNum(tx.commits || 0), 'total transactions committed', 'ok');
	html += '</div>';

	if (issues.length > 0) {
		html += '<div class="alert warn">⚠ Issues detected: ' + issues.map(i => '<strong>' + esc(i) + '</strong>').join(', ') + '. See relevant tabs for details.</div>';
	}

	// TX Stats
	html += '<div class="section-header">Transaction Statistics</div>';
	html += '<div class="cards">';
	html += cardHtml('Commits', formatNum(tx.commits || 0), 'successful', 'ok');
	html += cardHtml('Rollbacks', tx.xact_rollback || 0, 'transactions rolled back', (tx.xact_rollback || 0) > 0 ? 'warn' : 'ok');
	html += cardHtml('Blks Hit', formatNum(tx.blks_hit || 0), 'buffer cache hits', 'ok');
	html += cardHtml('Blks Read', formatNum(tx.blks_read || 0), 'disk reads', 'accent');
	html += '</div>';

	document.getElementById('overview-content').innerHTML = html;
}

function cardHtml(label, value, sub, cls, pct) {
	let gaugeHtml = '';
	if (pct !== undefined) {
		const gCls = pct > 80 ? 'crit' : pct > 60 ? 'warn' : '';
		gaugeHtml = '<div class="gauge-wrap"><div class="gauge-bar"><div class="gauge-fill ' + gCls + '" style="width:' + Math.min(100,pct) + '%"></div></div></div>';
	}
	const valClass = String(value).length > 8 ? 'card-value large' : 'card-value';
	return '<div class="card ' + (cls||'') + '"><div class="card-label">' + esc(label) + '</div><div class="' + valClass + '">' + esc(String(value)) + '</div>' + (sub ? '<div class="card-sub">' + esc(sub) + '</div>' : '') + gaugeHtml + '</div>';
}

function formatNum(n) {
	if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
	if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
	if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
	return String(n);
}

function formatUptime(ms) {
	const s = Math.floor(ms / 1000);
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d > 0) return d + 'd ' + h + 'h';
	if (h > 0) return h + 'h ' + m + 'm';
	return m + 'm';
}

function renderConnections(rows) {
	setDot('connections', rows.length === 0 ? 'ok' : (rows.some(r => r.wait_event_type === 'Lock') ? 'warn' : 'ok'));
	let html = '<div class="section-header">Active Sessions <span class="badge">' + rows.length + '</span></div>';
	if (rows.length === 0) {
		html += '<div class="empty-state"><div class="empty-icon">🔌</div><div>No other connections</div></div>';
		document.getElementById('connections-content').innerHTML = html;
		return;
	}
	html += '<div class="tbl-wrap"><table><thead><tr>';
	html += '<th>PID</th><th>User</th><th>App</th><th>State</th><th>Wait</th><th>Query (secs)</th><th>Query</th><th></th>';
	html += '</tr></thead><tbody>';
	for (const row of rows) {
		const stCls = row.state === 'active' ? 'active' : 'idle';
		const waitPill = row.wait_event ? pill(row.wait_event_type + ':' + row.wait_event, 'warn') : '';
		const secs = row.query_secs != null ? parseFloat(row.query_secs) : null;
		const secsCls = secs > 30 ? 'crit' : secs > 5 ? 'warn' : '';
		html += '<tr>';
		html += '<td class="mono">' + esc(row.pid) + '</td>';
		html += '<td>' + esc(row.usename || '') + '</td>';
		html += '<td><span class="tag">' + esc(row.application_name || '') + '</span></td>';
		html += '<td>' + pill(row.state || 'unknown', stCls) + '</td>';
		html += '<td>' + waitPill + '</td>';
		html += '<td class="mono ' + secsCls + '">' + (secs != null ? secs.toFixed(1) + 's' : '—') + '</td>';
		html += '<td class="mono" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">' + esc(row.query || '') + '</td>';
		html += '<td><button class="kill-btn" data-pid="' + esc(row.pid) + '">Kill</button></td>';
		html += '</tr>';
	}
	html += '</tbody></table></div>';
	document.getElementById('connections-content').innerHTML = html;

	// Kill buttons
	document.querySelectorAll('.kill-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			if (confirm('Terminate process ' + btn.dataset.pid + '?')) {
				vscode.postMessage({ command: 'killPid', pid: btn.dataset.pid });
			}
		});
	});
}

function renderSlowQueries(data) {
	if (!data) { document.getElementById('slowQueries-content').innerHTML = '<div class="error-state">Failed to load</div>'; return; }
	if (!data.available) {
		setDot('slowQueries', 'warn');
		document.getElementById('slowQueries-content').innerHTML =
			'<div class="alert info">ℹ pg_stat_statements extension is not enabled.<br><br>Enable it by running as superuser: <code>CREATE EXTENSION IF NOT EXISTS pg_stat_statements;</code><br><br>Then add <code>pg_stat_statements</code> to <code>shared_preload_libraries</code> in postgresql.conf and restart PostgreSQL.</div>';
		return;
	}
	const rows = data.rows || [];
	const maxMean = Math.max(...rows.map(r => parseFloat(r.mean_ms) || 0), 1);
	setDot('slowQueries', rows.length === 0 ? 'ok' : (parseFloat(rows[0]?.mean_ms) > 1000 ? 'warn' : 'ok'));

	let html = '<div class="section-header">Top Slow Queries by Mean Execution Time <span class="badge">' + rows.length + '</span></div>';
	if (rows.length === 0) {
		html += '<div class="empty-state"><div class="empty-icon">⚡</div><div>No slow query data yet</div></div>';
		document.getElementById('slowQueries-content').innerHTML = html;
		return;
	}

	html += '<div class="tbl-wrap"><table><thead><tr>';
	html += '<th>Query</th><th>Calls</th><th>Mean ms</th><th>Total ms</th><th>Min</th><th>Max</th><th>Rows/call</th><th>Cache %</th>';
	html += '</tr></thead><tbody>';
	for (const row of rows) {
		const meanMs = parseFloat(row.mean_ms) || 0;
		const meanCls = meanMs > 1000 ? 'crit' : meanMs > 100 ? 'warn' : '';
		const hitPct = parseFloat(row.hit_pct) || 0;
		const hitCls = hitPct < 90 ? 'crit' : hitPct < 95 ? 'warn' : '';
		html += '<tr>';
		html += '<td class="mono" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(row.query) + '">' + esc(row.query || '') + '</td>';
		html += '<td class="mono">' + formatNum(row.calls || 0) + '</td>';
		html += '<td class="mono ' + meanCls + '">' + row.mean_ms + '</td>';
		html += '<td class="mono">' + formatNum(Math.round(parseFloat(row.total_ms) || 0)) + '</td>';
		html += '<td class="mono">' + row.min_ms + '</td>';
		html += '<td class="mono">' + row.max_ms + '</td>';
		html += '<td class="mono">' + (row.calls > 0 ? (row.rows / row.calls).toFixed(1) : '0') + '</td>';
		html += '<td class="mono ' + hitCls + '">' + (row.hit_pct != null ? row.hit_pct + '%' : '—') + '</td>';
		html += '</tr>';
	}
	html += '</tbody></table></div>';
	document.getElementById('slowQueries-content').innerHTML = html;
}

function renderLocks(rows) {
	const dot = rows.length === 0 ? 'ok' : 'crit';
	setDot('locks', dot);
	let html = '<div class="section-header">Blocking Locks <span class="badge">' + rows.length + '</span></div>';
	if (rows.length === 0) {
		html += '<div class="empty-state"><div class="empty-icon">🔓</div><div>No blocking locks detected</div></div>';
		document.getElementById('locks-content').innerHTML = html;
		return;
	}
	html += '<div class="tbl-wrap"><table><thead><tr>';
	html += '<th>Blocked PID</th><th>User</th><th>Blocked (s)</th><th>Blocked Query</th><th>Blocking PID</th><th>Blocking User</th><th>Blocking Query</th>';
	html += '</tr></thead><tbody>';
	for (const row of rows) {
		const secsCls = parseFloat(row.blocked_secs) > 30 ? 'crit' : 'warn';
		html += '<tr>';
		html += '<td class="mono">' + esc(row.blocked_pid) + '</td>';
		html += '<td>' + esc(row.blocked_user || '') + '</td>';
		html += '<td class="mono ' + secsCls + '">' + esc(row.blocked_secs || '0') + 's</td>';
		html += '<td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">' + esc(row.blocked_query || '') + '</td>';
		html += '<td class="mono">' + esc(row.blocking_pid) + '</td>';
		html += '<td>' + esc(row.blocking_user || '') + '</td>';
		html += '<td class="mono" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">' + esc(row.blocking_query || '') + '</td>';
		html += '</tr>';
	}
	html += '</tbody></table></div>';
	document.getElementById('locks-content').innerHTML = html;
}

function renderTableStats(rows) {
	const hasProblems = rows.some(r => parseFloat(r.dead_pct) > 20);
	setDot('tableStats', hasProblems ? 'warn' : 'ok');
	let html = '<div class="section-header">Table Statistics <span class="badge">' + rows.length + '</span></div>';
	if (!rows.length) {
		html += '<div class="empty-state"><div class="empty-icon">📋</div><div>No user tables</div></div>';
		document.getElementById('tableStats-content').innerHTML = html;
		return;
	}
	html += '<div class="tbl-wrap"><table><thead><tr>';
	html += '<th>Schema</th><th>Table</th><th>Total Size</th><th>Table</th><th>Indexes</th><th>Live Rows</th><th>Dead Rows</th><th>Dead %</th><th>Seq Scans</th><th>Idx Scans %</th>';
	html += '</tr></thead><tbody>';
	const maxBytes = Math.max(...rows.map(r => r.total_bytes || 0), 1);
	for (const row of rows) {
		const deadPct = parseFloat(row.dead_pct) || 0;
		const deadCls = deadPct > 20 ? 'crit' : deadPct > 10 ? 'warn' : '';
		const idxPct = parseFloat(row.idx_scan_pct) || 0;
		const idxCls = idxPct < 50 && (row.seq_scan || 0) > 100 ? 'warn' : '';
		html += '<tr>';
		html += '<td><span class="tag">' + esc(row.schemaname) + '</span></td>';
		html += '<td class="mono">' + esc(row.table_name) + '</td>';
		html += '<td class="mono">' + esc(row.total_size || '') + '</td>';
		html += '<td class="mono">' + esc(row.table_size || '') + '</td>';
		html += '<td class="mono">' + esc(row.indexes_size || '') + '</td>';
		html += '<td class="mono">' + formatNum(row.live_tuples || 0) + '</td>';
		html += '<td class="mono ' + deadCls + '">' + formatNum(row.dead_tuples || 0) + '</td>';
		html += '<td class="mono ' + deadCls + '">' + (row.dead_pct != null ? row.dead_pct + '%' : '—') + '</td>';
		html += '<td class="mono">' + formatNum(row.seq_scan || 0) + '</td>';
		html += '<td class="mono ' + idxCls + '">' + (row.idx_scan_pct != null ? row.idx_scan_pct + '%' : '—') + '</td>';
		html += '</tr>';
	}
	html += '</tbody></table></div>';
	document.getElementById('tableStats-content').innerHTML = html;
}

function renderIndexHealth(data) {
	if (!data) { document.getElementById('indexHealth-content').innerHTML = '<div class="error-state">Failed to load</div>'; return; }
	const unused = data.unused || [];
	const neverUsed = unused.filter(r => (r.idx_scan || 0) === 0);
	setDot('indexHealth', neverUsed.length > 0 ? 'warn' : 'ok');

	let html = '<div class="section-header">Unused Indexes <span class="badge">' + unused.length + '</span></div>';
	if (unused.length === 0) {
		html += '<div class="empty-state"><div class="empty-icon">✅</div><div>All indexes appear to be used</div></div>';
	} else {
		html += '<div class="tbl-wrap"><table><thead><tr>';
		html += '<th>Schema</th><th>Table</th><th>Index</th><th>Size</th><th>Scans</th><th>Tup Read</th><th>Tup Fetch</th>';
		html += '</tr></thead><tbody>';
		for (const row of unused) {
			const cls = (row.idx_scan || 0) === 0 ? 'crit' : (row.idx_scan || 0) < 10 ? 'warn' : '';
			html += '<tr>';
			html += '<td><span class="tag">' + esc(row.schemaname) + '</span></td>';
			html += '<td class="mono">' + esc(row.tablename) + '</td>';
			html += '<td class="mono">' + esc(row.indexname) + '</td>';
			html += '<td class="mono">' + esc(row.index_size || '') + '</td>';
			html += '<td class="mono ' + cls + '">' + formatNum(row.idx_scan || 0) + '</td>';
			html += '<td class="mono">' + formatNum(row.idx_tup_read || 0) + '</td>';
			html += '<td class="mono">' + formatNum(row.idx_tup_fetch || 0) + '</td>';
			html += '</tr>';
		}
		html += '</tbody></table></div>';
	}

	const dups = data.duplicates || [];
	if (dups.length > 0) {
		html += '<div class="section-header" style="margin-top:8px">Duplicate Indexes <span class="badge">' + dups.length + '</span></div>';
		html += '<div class="tbl-wrap"><table><thead><tr><th>Table</th><th>Duplicate Indexes</th><th>Count</th></tr></thead><tbody>';
		for (const row of dups) {
			html += '<tr><td class="mono">' + esc(row.table_name) + '</td><td class="mono">' + esc(String(row.duplicate_indexes || '')) + '</td><td class="mono warn">' + esc(row.count) + '</td></tr>';
		}
		html += '</tbody></table></div>';
	}

	document.getElementById('indexHealth-content').innerHTML = html;
}

function renderVacuum(rows) {
	const critCount = rows.filter(r => r.status === 'critical').length;
	const warnCount = rows.filter(r => r.status === 'warning').length;
	setDot('vacuum', critCount > 0 ? 'crit' : warnCount > 0 ? 'warn' : 'ok');

	let html = '<div class="cards">';
	html += cardHtml('Critical', critCount, 'need immediate VACUUM', critCount > 0 ? 'crit' : 'ok');
	html += cardHtml('Warning', warnCount, 'need VACUUM soon', warnCount > 0 ? 'warn' : 'ok');
	html += cardHtml('Total', rows.length, 'user tables', 'accent');
	html += '</div>';
	html += '<div class="section-header">Vacuum / Analyze Status <span class="badge">' + rows.length + '</span></div>';

	html += '<div class="tbl-wrap"><table><thead><tr>';
	html += '<th>Status</th><th>Schema</th><th>Table</th><th>Dead Tuples</th><th>Bloat %</th><th>Last Vacuum</th><th>Last Auto</th><th>Last Analyze</th><th>Last Auto</th>';
	html += '</tr></thead><tbody>';
	for (const row of rows) {
		html += '<tr>';
		html += '<td>' + pill(row.status, row.status) + '</td>';
		html += '<td><span class="tag">' + esc(row.schemaname) + '</span></td>';
		html += '<td class="mono">' + esc(row.table_name) + '</td>';
		html += '<td class="mono ' + (row.status === 'critical' ? 'crit' : row.status === 'warning' ? 'warn' : '') + '">' + formatNum(row.dead_tuples || 0) + '</td>';
		html += '<td class="mono">' + (row.bloat_pct != null ? row.bloat_pct + '%' : '—') + '</td>';
		html += '<td class="mono">' + esc(row.last_vacuum || '—') + '</td>';
		html += '<td class="mono">' + esc(row.last_autovacuum || '—') + '</td>';
		html += '<td class="mono">' + esc(row.last_analyze || '—') + '</td>';
		html += '<td class="mono">' + esc(row.last_autoanalyze || '—') + '</td>';
		html += '</tr>';
	}
	html += '</tbody></table></div>';
	document.getElementById('vacuum-content').innerHTML = html;
}

function renderCacheHit(data) {
	if (!data) { document.getElementById('cacheHit-content').innerHTML = '<div class="error-state">Failed to load</div>'; return; }
	const dbs = data.databases || [];
	const tables = data.tables || [];
	const minRatio = dbs.length > 0 ? Math.min(...dbs.map(r => parseFloat(r.cache_hit_ratio) || 0)) : 100;
	setDot('cacheHit', minRatio < 95 ? 'warn' : 'ok');

	let html = '<div class="section-header">Database Cache Hit Ratios</div>';
	html += '<div style="margin-bottom:16px">';
	for (const row of dbs) {
		html += progressBar(row.cache_hit_ratio, 100, row.datname);
	}
	html += '</div>';

	html += '<div class="cards" style="margin-bottom:16px">';
	for (const row of dbs) {
		if (row.datname === (connName || '')) {
			html += cardHtml('Deadlocks', row.deadlocks || 0, 'total', (row.deadlocks || 0) > 0 ? 'crit' : 'ok');
			html += cardHtml('Temp Files', row.temp_files || 0, row.temp_size || '0 bytes', (row.temp_files || 0) > 0 ? 'warn' : 'ok');
		}
	}
	html += '</div>';

	html += '<div class="section-header">Table Cache Hit Ratios (top 20) <span class="badge">' + tables.length + '</span></div>';
	html += '<div style="margin-bottom:4px">';
	for (const row of tables.slice(0, 15)) {
		html += progressBar(row.cache_hit_ratio, 100, row.schemaname + '.' + row.table_name);
	}
	html += '</div>';

	document.getElementById('cacheHit-content').innerHTML = html;
}

function renderReplication(data) {
	if (!data) { document.getElementById('replication-content').innerHTML = '<div class="error-state">Failed to load</div>'; return; }
	const repl = data.replication || [];
	const wal = data.wal || {};
	setDot('replication', repl.length > 0 ? 'ok' : 'ok');

	let html = '<div class="cards" style="margin-bottom:16px">';
	html += cardHtml('Replicas', repl.length, 'connected standbys', repl.length > 0 ? 'ok' : 'accent');
	html += cardHtml('Role', wal.is_replica ? 'Replica' : 'Primary', '', 'accent');
	html += cardHtml('WAL Files', wal.wal_files || 'N/A', wal.wal_size || '', 'accent');
	if (wal.current_wal) html += cardHtml('Current WAL', String(wal.current_wal).slice(-8), '', 'accent');
	html += '</div>';

	if (repl.length === 0) {
		html += '<div class="empty-state"><div class="empty-icon">📡</div><div>No replication configured or not a primary</div></div>';
	} else {
		html += '<div class="section-header">Replication Slots <span class="badge">' + repl.length + '</span></div>';
		html += '<div class="tbl-wrap"><table><thead><tr>';
		html += '<th>Client</th><th>App</th><th>User</th><th>State</th><th>Sync</th><th>Lag Size</th><th>Write Lag</th><th>Flush Lag</th><th>Replay Lag</th>';
		html += '</tr></thead><tbody>';
		for (const row of repl) {
			html += '<tr>';
			html += '<td class="mono">' + esc(row.client_addr || '') + '</td>';
			html += '<td><span class="tag">' + esc(row.application_name || '') + '</span></td>';
			html += '<td>' + esc(row.usename || '') + '</td>';
			html += '<td>' + pill(row.state || '', row.state === 'streaming' ? 'ok' : 'warn') + '</td>';
			html += '<td>' + pill(row.sync_state || '', row.sync_state === 'sync' ? 'ok' : 'info') + '</td>';
			html += '<td class="mono">' + esc(row.replication_lag_size || '0 bytes') + '</td>';
			html += '<td class="mono">' + esc(String(row.write_lag || '—')) + '</td>';
			html += '<td class="mono">' + esc(String(row.flush_lag || '—')) + '</td>';
			html += '<td class="mono">' + esc(String(row.replay_lag || '—')) + '</td>';
			html += '</tr>';
		}
		html += '</tbody></table></div>';
	}

	document.getElementById('replication-content').innerHTML = html;
}

function renderBloat(rows) {
	const totalWaste = rows.reduce((sum, r) => sum + (r.wastedbytes || 0), 0);
	setDot('bloat', totalWaste > 1e9 ? 'warn' : 'ok');

	let html = '<div class="cards" style="margin-bottom:16px">';
	html += cardHtml('Total Waste', formatBytes(totalWaste), 'reclaimable space', totalWaste > 1e9 ? 'warn' : 'ok');
	html += cardHtml('Tables', rows.length, 'analyzed', 'accent');
	html += '</div>';

	html += '<div class="section-header">Table & Index Bloat <span class="badge">' + rows.length + '</span></div>';
	if (rows.length === 0) {
		html += '<div class="empty-state"><div class="empty-icon">🗜</div><div>No bloat data available</div></div>';
		document.getElementById('bloat-content').innerHTML = html;
		return;
	}
	html += '<div class="tbl-wrap"><table><thead><tr>';
	html += '<th>Schema</th><th>Table</th><th>Table Bloat</th><th>Wasted</th><th>Index</th><th>Idx Bloat</th><th>Idx Wasted</th>';
	html += '</tr></thead><tbody>';
	for (const row of rows) {
		const tBloat = parseFloat(row.tbloat) || 0;
		const iBloat = parseFloat(row.ibloat) || 0;
		const tCls = tBloat > 5 ? 'crit' : tBloat > 2 ? 'warn' : '';
		const iCls = iBloat > 5 ? 'crit' : iBloat > 2 ? 'warn' : '';
		html += '<tr>';
		html += '<td><span class="tag">' + esc(row.schemaname) + '</span></td>';
		html += '<td class="mono">' + esc(row.tablename || '') + '</td>';
		html += '<td class="mono ' + tCls + '">×' + esc(String(row.tbloat || '1')) + '</td>';
		html += '<td class="mono">' + esc(row.wasted_size || '0') + '</td>';
		html += '<td class="mono">' + esc(row.iname || '—') + '</td>';
		html += '<td class="mono ' + iCls + '">×' + esc(String(row.ibloat || '1')) + '</td>';
		html += '<td class="mono">' + esc(row.wasted_isize || '0') + '</td>';
		html += '</tr>';
	}
	html += '</tbody></table></div>';
	document.getElementById('bloat-content').innerHTML = html;
}

function formatBytes(b) {
	if (!b || b === 0) return '0 B';
	if (b >= 1e9) return (b/1e9).toFixed(1) + ' GB';
	if (b >= 1e6) return (b/1e6).toFixed(1) + ' MB';
	if (b >= 1e3) return (b/1e3).toFixed(1) + ' KB';
	return b + ' B';
}

// ── MESSAGE HANDLER ──
window.addEventListener('message', e => {
	const msg = e.data;

	if (msg.command === 'sectionData') {
		const el = document.getElementById(msg.section + '-content');
		if (!el) return;

		if (msg.error) {
			el.innerHTML = '<div class="error-state">Error: ' + esc(msg.error) + '</div>';
			setDot(msg.section, 'warn');
			return;
		}

		switch (msg.section) {
			case 'overview':     renderOverview(msg.data); break;
			case 'connections':  renderConnections(msg.data); break;
			case 'slowQueries':  renderSlowQueries(msg.data); break;
			case 'locks':        renderLocks(msg.data); break;
			case 'tableStats':   renderTableStats(msg.data); break;
			case 'indexHealth':  renderIndexHealth(msg.data); break;
			case 'vacuum':       renderVacuum(msg.data); break;
			case 'cacheHit':     renderCacheHit(msg.data); break;
			case 'replication':  renderReplication(msg.data); break;
			case 'bloat':        renderBloat(msg.data); break;
		}
	} else if (msg.command === 'killResult') {
		if (msg.success) {
			vscode.postMessage({ command: 'fetchSection', section: 'connections' });
		}
	}
});
</script>
</body>
</html>`;
	}
}