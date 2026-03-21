"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHealthSlowQueries = registerHealthSlowQueries;
exports.registerHealthLocks = registerHealthLocks;
exports.registerHealthSizes = registerHealthSizes;
exports.registerHealthVacuum = registerHealthVacuum;
const db_1 = require("../db");
function registerHealthSlowQueries(parent) {
    parent
        .command('slow-queries')
        .description('Show slowest queries from pg_stat_statements')
        .requiredOption('--db <url>', 'PostgreSQL connection URL (or DATABASE_URL env)')
        .option('--limit <n>', 'Number of queries to show (default: 20)', '20')
        .option('--min-mean-ms <ms>', 'Minimum mean execution time in ms')
        .option('--min-total-ms <ms>', 'Minimum total execution time in ms')
        .option('--json', 'Output as JSON')
        .action(async (opts) => {
        const url = opts.db || process.env['DATABASE_URL'] || '';
        if (!url) {
            console.error('Error: --db is required (or set DATABASE_URL)');
            process.exit(1);
        }
        const client = await (0, db_1.connect)(url).catch((err) => {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
        try {
            // Check pg_stat_statements availability
            const extCheck = await (0, db_1.query)(client, `
          SELECT COUNT(*) AS count FROM pg_extension WHERE extname = 'pg_stat_statements'
        `);
            if (extCheck[0]?.count === '0') {
                console.error('Error: pg_stat_statements extension is not installed.\n' +
                    'To enable it:\n' +
                    '  1. Add "pg_stat_statements" to shared_preload_libraries in postgresql.conf\n' +
                    '  2. Restart PostgreSQL\n' +
                    '  3. Run: CREATE EXTENSION pg_stat_statements;');
                process.exit(1);
            }
            const limit = parseInt(opts.limit, 10) || 20;
            const minMean = opts.minMeanMs ? parseFloat(opts.minMeanMs) : 0;
            const minTotal = opts.minTotalMs ? parseFloat(opts.minTotalMs) : 0;
            const rows = await (0, db_1.query)(client, `
          SELECT
            calls::text,
            round(mean_exec_time::numeric, 2)::text  AS mean_exec_time,
            round(total_exec_time::numeric, 2)::text AS total_exec_time,
            query
          FROM pg_stat_statements
          WHERE mean_exec_time  >= $1
            AND total_exec_time >= $2
          ORDER BY mean_exec_time DESC
          LIMIT $3
        `, [minMean, minTotal, limit]);
            if (opts.json) {
                console.log(JSON.stringify(rows, null, 2));
                return;
            }
            if (rows.length === 0) {
                console.log('No queries found matching the criteria.');
                return;
            }
            console.log(`\nTop ${rows.length} slow queries by mean execution time:\n`);
            console.log('Rank'.padEnd(5) +
                'Calls'.padEnd(10) +
                'Mean ms'.padEnd(12) +
                'Total ms'.padEnd(14) +
                'Query');
            console.log('-'.repeat(80));
            rows.forEach((row, i) => {
                const q = row.query.replace(/\s+/g, ' ').slice(0, 60);
                console.log(String(i + 1).padEnd(5) +
                    String(row.calls).padEnd(10) +
                    String(row.mean_exec_time).padEnd(12) +
                    String(row.total_exec_time).padEnd(14) +
                    q);
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${message}`);
            process.exit(1);
        }
        finally {
            await (0, db_1.disconnect)(client);
        }
    });
}
function registerHealthLocks(parent) {
    parent
        .command('locks')
        .description('Show current lock conflicts (blocking/waiting processes)')
        .requiredOption('--db <url>', 'PostgreSQL connection URL (or DATABASE_URL env)')
        .option('--json', 'Output as JSON')
        .action(async (opts) => {
        const url = opts.db || process.env['DATABASE_URL'] || '';
        if (!url) {
            console.error('Error: --db is required (or set DATABASE_URL)');
            process.exit(1);
        }
        const client = await (0, db_1.connect)(url).catch((err) => {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
        try {
            const rows = await (0, db_1.query)(client, `
          SELECT
            blocking.pid::text                                    AS blocking_pid,
            left(blocking_act.query, 100)                        AS blocking_query,
            waiting.pid::text                                     AS waiting_pid,
            left(waiting_act.query, 100)                         AS waiting_query,
            now() - waiting_act.query_start                      AS wait_duration,
            waiting.locktype                                      AS lock_type
          FROM pg_catalog.pg_locks AS waiting
          JOIN pg_catalog.pg_stat_activity AS waiting_act
            ON waiting_act.pid = waiting.pid
          JOIN pg_catalog.pg_locks AS blocking
            ON blocking.relation = waiting.relation
           AND blocking.locktype = waiting.locktype
           AND blocking.pid     != waiting.pid
           AND blocking.granted = true
          JOIN pg_catalog.pg_stat_activity AS blocking_act
            ON blocking_act.pid = blocking.pid
          WHERE NOT waiting.granted
          ORDER BY wait_duration DESC
        `);
            if (opts.json) {
                console.log(JSON.stringify(rows, null, 2));
                return;
            }
            if (rows.length === 0) {
                console.log('No lock conflicts detected.');
                return;
            }
            console.log(`\nFound ${rows.length} lock conflict(s):\n`);
            for (const row of rows) {
                console.log(`Blocking PID : ${row.blocking_pid}`);
                console.log(`  Query      : ${row.blocking_query}`);
                console.log(`Waiting PID  : ${row.waiting_pid}`);
                console.log(`  Query      : ${row.waiting_query}`);
                console.log(`  Waiting for: ${row.wait_duration}`);
                console.log(`  Lock type  : ${row.lock_type}`);
                console.log('-'.repeat(60));
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${message}`);
            process.exit(1);
        }
        finally {
            await (0, db_1.disconnect)(client);
        }
    });
}
function registerHealthSizes(parent) {
    parent
        .command('sizes')
        .description('Show table/index sizes and approximate bloat')
        .requiredOption('--db <url>', 'PostgreSQL connection URL (or DATABASE_URL env)')
        .option('--limit <n>', 'Number of tables to show (default: 20)', '20')
        .option('--schema <name>', 'Filter by schema (default: all user schemas)')
        .option('--json', 'Output as JSON')
        .action(async (opts) => {
        const url = opts.db || process.env['DATABASE_URL'] || '';
        if (!url) {
            console.error('Error: --db is required (or set DATABASE_URL)');
            process.exit(1);
        }
        const client = await (0, db_1.connect)(url).catch((err) => {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
        try {
            const limit = parseInt(opts.limit, 10) || 20;
            const schemaParam = opts.schema ?? null;
            const rows = await (0, db_1.query)(client, `
          SELECT
            n.nspname                                               AS schema_name,
            c.relname                                               AS table_name,
            pg_size_pretty(pg_total_relation_size(c.oid))          AS total_size,
            pg_size_pretty(pg_relation_size(c.oid))                AS table_size,
            pg_size_pretty(
              pg_total_relation_size(c.oid) - pg_relation_size(c.oid)
            )                                                       AS index_size,
            s.n_live_tup::text                                      AS live_tuples,
            s.n_dead_tup::text                                      AS dead_tuples,
            CASE
              WHEN s.n_live_tup > 0
                THEN round(
                  (s.n_dead_tup * 100.0) / (s.n_live_tup + s.n_dead_tup), 1
                )::text || '%'
              ELSE '0%'
            END                                                     AS bloat_ratio
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_stat_user_tables s
            ON s.schemaname = n.nspname AND s.relname = c.relname
          WHERE c.relkind = 'r'
            AND (
              $2::text IS NOT NULL AND n.nspname = $2
              OR $2::text IS NULL AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            )
          ORDER BY pg_total_relation_size(c.oid) DESC
          LIMIT $1
        `, [limit, schemaParam]);
            if (opts.json) {
                console.log(JSON.stringify(rows, null, 2));
                return;
            }
            if (rows.length === 0) {
                console.log('No tables found.');
                return;
            }
            console.log(`\nTop ${rows.length} tables by total size:\n`);
            const header = 'Schema'.padEnd(16) +
                'Table'.padEnd(30) +
                'Total'.padEnd(12) +
                'Table'.padEnd(12) +
                'Indexes'.padEnd(12) +
                'Live'.padEnd(10) +
                'Dead'.padEnd(10) +
                'Bloat';
            console.log(header);
            console.log('-'.repeat(header.length + 8));
            for (const row of rows) {
                console.log(row.schema_name.padEnd(16) +
                    row.table_name.slice(0, 28).padEnd(30) +
                    row.total_size.padEnd(12) +
                    row.table_size.padEnd(12) +
                    row.index_size.padEnd(12) +
                    row.live_tuples.padEnd(10) +
                    row.dead_tuples.padEnd(10) +
                    row.bloat_ratio);
            }
            // Highlight high bloat
            const highBloat = rows.filter(r => parseFloat(r.bloat_ratio) >= 20);
            if (highBloat.length > 0) {
                console.log('\n⚠ Tables with high bloat (≥20% dead tuples):');
                for (const r of highBloat) {
                    console.log(`  ${r.schema_name}.${r.table_name} — ${r.bloat_ratio} dead tuples`);
                    console.log(`    Consider running: VACUUM ANALYZE "${r.schema_name}"."${r.table_name}";`);
                }
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${message}`);
            process.exit(1);
        }
        finally {
            await (0, db_1.disconnect)(client);
        }
    });
}
function registerHealthVacuum(parent) {
    parent
        .command('vacuum')
        .description('Show vacuum/analyze recommendations based on pg_stat_user_tables')
        .requiredOption('--db <url>', 'PostgreSQL connection URL (or DATABASE_URL env)')
        .option('--limit <n>', 'Number of tables to show (default: 20)', '20')
        .option('--schema <name>', 'Filter by schema (default: all user schemas)')
        .option('--json', 'Output as JSON')
        .action(async (opts) => {
        const url = opts.db || process.env['DATABASE_URL'] || '';
        if (!url) {
            console.error('Error: --db is required (or set DATABASE_URL)');
            process.exit(1);
        }
        const client = await (0, db_1.connect)(url).catch((err) => {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
        try {
            const limit = parseInt(opts.limit, 10) || 20;
            const schemaParam = opts.schema ?? null;
            const rows = await (0, db_1.query)(client, `
          SELECT
            schemaname                                             AS schema_name,
            relname                                               AS table_name,
            to_char(last_vacuum,       'YYYY-MM-DD HH24:MI')     AS last_vacuum,
            to_char(last_autovacuum,   'YYYY-MM-DD HH24:MI')     AS last_autovacuum,
            to_char(last_analyze,      'YYYY-MM-DD HH24:MI')     AS last_analyze,
            to_char(last_autoanalyze,  'YYYY-MM-DD HH24:MI')     AS last_autoanalyze,
            n_dead_tup::text                                      AS dead_tuples,
            n_live_tup::text                                      AS live_tuples,
            n_mod_since_analyze::text                             AS mod_since_analyze,
            CASE
              WHEN n_dead_tup > 10000
                   AND (last_vacuum IS NULL AND last_autovacuum IS NULL)
                THEN 'VACUUM urgently needed (many dead tuples, never vacuumed)'
              WHEN n_dead_tup > 10000
                THEN 'VACUUM recommended (high dead tuples)'
              WHEN n_mod_since_analyze > 10000
                   AND (last_analyze IS NULL AND last_autoanalyze IS NULL)
                THEN 'ANALYZE urgently needed (many modifications, never analyzed)'
              WHEN n_mod_since_analyze > 10000
                THEN 'ANALYZE recommended (many unanalyzed modifications)'
              ELSE 'OK'
            END                                                   AS recommendation
          FROM pg_stat_user_tables
          WHERE ($2::text IS NULL OR schemaname = $2)
          ORDER BY n_dead_tup DESC, n_mod_since_analyze DESC
          LIMIT $1
        `, [limit, schemaParam]);
            if (opts.json) {
                console.log(JSON.stringify(rows, null, 2));
                return;
            }
            if (rows.length === 0) {
                console.log('No tables found.');
                return;
            }
            const urgent = rows.filter(r => r.recommendation !== 'OK');
            console.log(`\nVacuum/Analyze status for ${rows.length} tables:`);
            if (urgent.length === 0) {
                console.log('All tables look healthy (no urgent vacuum/analyze needed).');
            }
            console.log('');
            for (const row of rows) {
                const status = row.recommendation === 'OK' ? '✓' : '⚠';
                console.log(`${status} ${row.schema_name}.${row.table_name}`);
                console.log(`    Live: ${row.live_tuples}  Dead: ${row.dead_tuples}  Unanalyzed mods: ${row.mod_since_analyze}`);
                console.log(`    Last vacuum: ${row.last_vacuum ?? row.last_autovacuum ?? 'never'}`);
                console.log(`    Last analyze: ${row.last_analyze ?? row.last_autoanalyze ?? 'never'}`);
                if (row.recommendation !== 'OK') {
                    console.log(`    ⚠ ${row.recommendation}`);
                    const deadNum = parseInt(row.dead_tuples, 10);
                    const modNum = parseInt(row.mod_since_analyze, 10);
                    if (deadNum > 10000) {
                        console.log(`    → Run: VACUUM ANALYZE "${row.schema_name}"."${row.table_name}";`);
                    }
                    else if (modNum > 10000) {
                        console.log(`    → Run: ANALYZE "${row.schema_name}"."${row.table_name}";`);
                    }
                }
            }
            if (urgent.length > 0) {
                console.log('\nTip: If autovacuum is not keeping up, consider tuning:\n' +
                    '  autovacuum_vacuum_scale_factor (default 0.2)\n' +
                    '  autovacuum_analyze_scale_factor (default 0.1)\n' +
                    '  autovacuum_vacuum_cost_delay (default 2ms)');
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${message}`);
            process.exit(1);
        }
        finally {
            await (0, db_1.disconnect)(client);
        }
    });
}
//# sourceMappingURL=health.js.map