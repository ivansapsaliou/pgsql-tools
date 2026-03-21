"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerExplain = registerExplain;
const db_1 = require("../db");
function registerExplain(parent) {
    parent
        .command('explain <sql>')
        .description('Run EXPLAIN (or EXPLAIN ANALYZE) on a SQL query')
        .requiredOption('--db <url>', 'PostgreSQL connection URL (or DATABASE_URL env)')
        .option('--analyze', 'Include ANALYZE (actually executes the query)')
        .option('--buffers', 'Include BUFFERS information (requires --analyze)')
        .option('--format <fmt>', 'Output format: text or json (default: text)', 'text')
        .action(async (sql, opts) => {
        const url = opts.db || process.env['DATABASE_URL'] || '';
        if (!url) {
            console.error('Error: --db is required (or set DATABASE_URL)');
            process.exit(1);
        }
        if (!['text', 'json'].includes(opts.format)) {
            console.error('Error: --format must be "text" or "json"');
            process.exit(1);
        }
        if (opts.buffers && !opts.analyze) {
            console.error('Error: --buffers requires --analyze');
            process.exit(1);
        }
        const client = await (0, db_1.connect)(url).catch((err) => {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
        try {
            const options = [];
            if (opts.analyze)
                options.push('ANALYZE');
            if (opts.buffers)
                options.push('BUFFERS');
            options.push(`FORMAT ${opts.format.toUpperCase()}`);
            const explainSql = `EXPLAIN (${options.join(', ')}) ${sql}`;
            if (opts.format === 'json') {
                // pg returns a single row with a JSON column
                const rows = await (0, db_1.query)(client, explainSql);
                const plan = rows[0]?.['QUERY PLAN'];
                console.log(JSON.stringify(plan, null, 2));
            }
            else {
                const rows = await (0, db_1.query)(client, explainSql);
                console.log('\nQuery Plan:');
                console.log('-'.repeat(60));
                for (const row of rows) {
                    console.log(row['QUERY PLAN']);
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
//# sourceMappingURL=explain.js.map