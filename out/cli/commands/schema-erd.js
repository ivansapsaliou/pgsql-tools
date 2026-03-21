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
exports.registerSchemaErd = registerSchemaErd;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const db_1 = require("../db");
// ── Mermaid generation ────────────────────────────────────────────────────────
function generateMermaid(tables, columns, foreignKeys) {
    const lines = ['erDiagram'];
    // Group columns by table
    const colsByTable = new Map();
    for (const col of columns) {
        const key = col.table_name;
        if (!colsByTable.has(key))
            colsByTable.set(key, []);
        colsByTable.get(key).push(col);
    }
    // Emit table definitions
    for (const table of tables) {
        const cols = colsByTable.get(table.table_name) ?? [];
        lines.push(`  ${sanitizeMermaid(table.table_name)} {`);
        for (const col of cols) {
            const pk = col.constraint_type === 'PRIMARY KEY' ? ' PK' : '';
            const fk = col.constraint_type === 'FOREIGN KEY' ? ' FK' : '';
            const nullable = col.is_nullable === 'YES' ? '' : ' "NOT NULL"';
            const typeName = sanitizeMermaid(col.data_type.replace(/\s+/g, '_'));
            lines.push(`    ${typeName} ${sanitizeMermaid(col.column_name)}${pk}${fk}${nullable}`);
        }
        lines.push('  }');
    }
    // Emit relationships
    const seenRels = new Set();
    for (const fk of foreignKeys) {
        const rel = `  ${sanitizeMermaid(fk.from_table)} }o--|| ${sanitizeMermaid(fk.to_table)} : "${sanitizeMermaid(fk.constraint_name)}"`;
        const key = `${fk.from_table}|${fk.to_table}|${fk.constraint_name}`;
        if (!seenRels.has(key)) {
            seenRels.add(key);
            lines.push(rel);
        }
    }
    return lines.join('\n');
}
// ── Graphviz DOT generation ───────────────────────────────────────────────────
function generateDot(tables, columns, foreignKeys) {
    const lines = [
        'digraph erd {',
        '  graph [rankdir=LR fontname="Helvetica"];',
        '  node [shape=record fontname="Helvetica" fontsize=10];',
        '  edge [fontname="Helvetica" fontsize=9];',
    ];
    const colsByTable = new Map();
    for (const col of columns) {
        const key = col.table_name;
        if (!colsByTable.has(key))
            colsByTable.set(key, []);
        colsByTable.get(key).push(col);
    }
    for (const table of tables) {
        const cols = colsByTable.get(table.table_name) ?? [];
        const colDefs = cols
            .map(c => {
            const pk = c.constraint_type === 'PRIMARY KEY' ? ' [PK]' : '';
            const fk = c.constraint_type === 'FOREIGN KEY' ? ' [FK]' : '';
            return `${escDot(c.column_name)} : ${escDot(c.data_type)}${pk}${fk}`;
        })
            .join('\\n');
        const label = `{${escDot(table.table_name)}|${colDefs}}`;
        lines.push(`  ${dotId(table.table_name)} [label="${label}"];`);
    }
    const seenEdges = new Set();
    for (const fk of foreignKeys) {
        const edgeKey = `${fk.from_table}->${fk.to_table}->${fk.constraint_name}`;
        if (!seenEdges.has(edgeKey)) {
            seenEdges.add(edgeKey);
            lines.push(`  ${dotId(fk.from_table)} -> ${dotId(fk.to_table)} [label="${escDot(fk.constraint_name)}"];`);
        }
    }
    lines.push('}');
    return lines.join('\n');
}
// ── String helpers ────────────────────────────────────────────────────────────
function sanitizeMermaid(s) {
    // Mermaid identifiers must not contain spaces or special chars
    return s.replace(/[^a-zA-Z0-9_]/g, '_');
}
function dotId(s) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function escDot(s) {
    return s.replace(/["{}<>|\\]/g, '\\$&');
}
// ── Commander command ─────────────────────────────────────────────────────────
function registerSchemaErd(parent) {
    parent
        .command('erd')
        .description('Export an ER diagram of the database schema')
        .requiredOption('--db <url>', 'PostgreSQL connection URL (or DATABASE_URL env)')
        .option('--schema <name>', 'Schema to diagram (default: public)', 'public')
        .option('--format <fmt>', 'Output format: mermaid or dot (default: mermaid)', 'mermaid')
        .option('--out <file>', 'Write output to a file instead of stdout')
        .action(async (opts) => {
        const url = opts.db || process.env['DATABASE_URL'] || '';
        if (!url) {
            console.error('Error: --db is required (or set DATABASE_URL)');
            process.exit(1);
        }
        if (!['mermaid', 'dot'].includes(opts.format)) {
            console.error('Error: --format must be "mermaid" or "dot"');
            process.exit(1);
        }
        const client = await (0, db_1.connect)(url).catch((err) => {
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(1);
        });
        try {
            const tables = await (0, db_1.query)(client, `
          SELECT table_name, table_schema
          FROM information_schema.tables
          WHERE table_schema = $1 AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `, [opts.schema]);
            const columns = await (0, db_1.query)(client, `
          SELECT
            c.table_name,
            c.column_name,
            c.data_type,
            c.is_nullable,
            tc.constraint_type
          FROM information_schema.columns c
          LEFT JOIN information_schema.key_column_usage kcu
            ON kcu.table_schema = c.table_schema
           AND kcu.table_name   = c.table_name
           AND kcu.column_name  = c.column_name
          LEFT JOIN information_schema.table_constraints tc
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema    = kcu.table_schema
           AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')
          WHERE c.table_schema = $1
          ORDER BY c.table_name, c.ordinal_position
        `, [opts.schema]);
            const foreignKeys = await (0, db_1.query)(client, `
          SELECT
            kcu.table_name      AS from_table,
            kcu.column_name     AS from_column,
            ccu.table_name      AS to_table,
            ccu.column_name     AS to_column,
            tc.constraint_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name
           AND kcu.table_schema    = tc.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema    = $1
          ORDER BY from_table, constraint_name
        `, [opts.schema]);
            let output;
            if (opts.format === 'dot') {
                output = generateDot(tables, columns, foreignKeys);
            }
            else {
                output = generateMermaid(tables, columns, foreignKeys);
            }
            if (opts.out) {
                const outPath = path.resolve(opts.out);
                fs.writeFileSync(outPath, output + '\n', 'utf8');
                console.log(`ERD written to ${outPath}`);
            }
            else {
                console.log(output);
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
//# sourceMappingURL=schema-erd.js.map