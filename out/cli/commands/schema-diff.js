"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSchemaDiff = registerSchemaDiff;
const db_1 = require("../db");
// ── SQL helpers ───────────────────────────────────────────────────────────────
async function introspectSchema(client, schemaName) {
    const tables = await (0, db_1.query)(client, `
    SELECT table_name, table_schema
    FROM information_schema.tables
    WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `, [schemaName]);
    const columns = {};
    for (const t of tables) {
        const key = `${t.table_schema}.${t.table_name}`;
        columns[key] = await (0, db_1.query)(client, `
      SELECT column_name, data_type, is_nullable, column_default,
             character_maximum_length, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schemaName, t.table_name]);
    }
    const indexes = await (0, db_1.query)(client, `
    SELECT i.relname AS index_name, t.relname AS table_name,
           pg_get_indexdef(ix.indexrelid, 0, true) AS indexdef
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = $1
    ORDER BY t.relname, i.relname
  `, [schemaName]);
    const constraints = await (0, db_1.query)(client, `
    SELECT c.conname AS constraint_name,
           t.relname AS table_name,
           CASE c.contype
             WHEN 'p' THEN 'PRIMARY KEY'
             WHEN 'u' THEN 'UNIQUE'
             WHEN 'f' THEN 'FOREIGN KEY'
             WHEN 'c' THEN 'CHECK'
             ELSE c.contype::text
           END AS constraint_type,
           pg_get_constraintdef(c.oid, true) AS constraint_def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = $1
    ORDER BY t.relname, c.conname
  `, [schemaName]);
    const enums = await (0, db_1.query)(client, `
    SELECT t.typname AS type_name,
           string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS enum_values
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = $1
    GROUP BY t.typname
    ORDER BY t.typname
  `, [schemaName]);
    const views = await (0, db_1.query)(client, `
    SELECT table_name AS view_name,
           view_definition
    FROM information_schema.views
    WHERE table_schema = $1
    ORDER BY table_name
  `, [schemaName]);
    return { tables, columns, indexes, constraints, enums, views };
}
function diffSchemas(a, b, labelA, labelB) {
    // Tables
    const tableNamesA = new Set(a.tables.map(t => t.table_name));
    const tableNamesB = new Set(b.tables.map(t => t.table_name));
    const addedTables = [...tableNamesB].filter(t => !tableNamesA.has(t));
    const removedTables = [...tableNamesA].filter(t => !tableNamesB.has(t));
    const commonTables = [...tableNamesA].filter(t => tableNamesB.has(t));
    const changedTables = [];
    for (const tbl of commonTables) {
        const keyA = `${labelA}.${tbl}`;
        const keyB = `${labelB}.${tbl}`;
        const colsA = a.columns[keyA] ?? [];
        const colsB = b.columns[keyB] ?? [];
        const colNamesA = new Set(colsA.map(c => c.column_name));
        const colNamesB = new Set(colsB.map(c => c.column_name));
        const addedColumns = [...colNamesB].filter(c => !colNamesA.has(c));
        const removedColumns = [...colNamesA].filter(c => !colNamesB.has(c));
        const changedColumns = [];
        for (const col of [...colNamesA].filter(c => colNamesB.has(c))) {
            const cA = colsA.find(c => c.column_name === col);
            const cB = colsB.find(c => c.column_name === col);
            if (cA.data_type !== cB.data_type ||
                cA.is_nullable !== cB.is_nullable ||
                cA.column_default !== cB.column_default) {
                changedColumns.push(col);
            }
        }
        if (addedColumns.length || removedColumns.length || changedColumns.length) {
            changedTables.push({ name: tbl, addedColumns, removedColumns, changedColumns });
        }
    }
    // Enums
    const enumNamesA = new Map(a.enums.map(e => [e.type_name, e.enum_values]));
    const enumNamesB = new Map(b.enums.map(e => [e.type_name, e.enum_values]));
    const addedEnums = [...enumNamesB.keys()].filter(k => !enumNamesA.has(k));
    const removedEnums = [...enumNamesA.keys()].filter(k => !enumNamesB.has(k));
    const changedEnums = [...enumNamesA.keys()].filter(k => enumNamesB.has(k) && enumNamesA.get(k) !== enumNamesB.get(k));
    // Views
    const viewNamesA = new Map(a.views.map(v => [v.view_name, v.view_definition]));
    const viewNamesB = new Map(b.views.map(v => [v.view_name, v.view_definition]));
    const addedViews = [...viewNamesB.keys()].filter(k => !viewNamesA.has(k));
    const removedViews = [...viewNamesA.keys()].filter(k => !viewNamesB.has(k));
    const changedViews = [...viewNamesA.keys()].filter(k => viewNamesB.has(k) && normalizeWs(viewNamesA.get(k)) !== normalizeWs(viewNamesB.get(k)));
    // Indexes
    const idxKeyA = new Map(a.indexes.map(i => [i.index_name, i.indexdef]));
    const idxKeyB = new Map(b.indexes.map(i => [i.index_name, i.indexdef]));
    const addedIndexes = [...idxKeyB.keys()].filter(k => !idxKeyA.has(k));
    const removedIndexes = [...idxKeyA.keys()].filter(k => !idxKeyB.has(k));
    const changedIndexes = [...idxKeyA.keys()].filter(k => idxKeyB.has(k) && idxKeyA.get(k) !== idxKeyB.get(k));
    // Constraints
    const conKeyA = new Map(a.constraints.map(c => [`${c.table_name}.${c.constraint_name}`, c.constraint_def]));
    const conKeyB = new Map(b.constraints.map(c => [`${c.table_name}.${c.constraint_name}`, c.constraint_def]));
    const addedConstraints = [...conKeyB.keys()].filter(k => !conKeyA.has(k));
    const removedConstraints = [...conKeyA.keys()].filter(k => !conKeyB.has(k));
    const changedConstraints = [...conKeyA.keys()].filter(k => conKeyB.has(k) && conKeyA.get(k) !== conKeyB.get(k));
    return {
        tables: { added: addedTables, removed: removedTables, changed: changedTables },
        enums: { added: addedEnums, removed: removedEnums, changed: changedEnums },
        views: { added: addedViews, removed: removedViews, changed: changedViews },
        indexes: { added: addedIndexes, removed: removedIndexes, changed: changedIndexes },
        constraints: { added: addedConstraints, removed: removedConstraints, changed: changedConstraints },
    };
}
function normalizeWs(s) {
    return s.replace(/\s+/g, ' ').trim();
}
// ── Human-readable output ─────────────────────────────────────────────────────
function printDiff(diff, labelA, labelB) {
    let hasChanges = false;
    function section(title) {
        console.log(`\n── ${title} ──`);
    }
    function added(msg) {
        hasChanges = true;
        console.log(`  + ${msg}`);
    }
    function removed(msg) {
        hasChanges = true;
        console.log(`  - ${msg}`);
    }
    function changed(msg) {
        hasChanges = true;
        console.log(`  ~ ${msg}`);
    }
    // Tables
    if (diff.tables.added.length || diff.tables.removed.length || diff.tables.changed.length) {
        section('TABLES');
        for (const t of diff.tables.added)
            added(`table ${t} (only in ${labelB})`);
        for (const t of diff.tables.removed)
            removed(`table ${t} (only in ${labelA})`);
        for (const t of diff.tables.changed) {
            changed(`table ${t.name}`);
            for (const c of t.addedColumns)
                console.log(`      + column ${c} (only in ${labelB})`);
            for (const c of t.removedColumns)
                console.log(`      - column ${c} (only in ${labelA})`);
            for (const c of t.changedColumns)
                console.log(`      ~ column ${c} (type/nullable/default changed)`);
        }
    }
    // Enums
    if (diff.enums.added.length || diff.enums.removed.length || diff.enums.changed.length) {
        section('ENUMS');
        for (const e of diff.enums.added)
            added(`enum ${e} (only in ${labelB})`);
        for (const e of diff.enums.removed)
            removed(`enum ${e} (only in ${labelA})`);
        for (const e of diff.enums.changed)
            changed(`enum ${e} (values changed)`);
    }
    // Views
    if (diff.views.added.length || diff.views.removed.length || diff.views.changed.length) {
        section('VIEWS');
        for (const v of diff.views.added)
            added(`view ${v} (only in ${labelB})`);
        for (const v of diff.views.removed)
            removed(`view ${v} (only in ${labelA})`);
        for (const v of diff.views.changed)
            changed(`view ${v} (definition changed)`);
    }
    // Indexes
    if (diff.indexes.added.length || diff.indexes.removed.length || diff.indexes.changed.length) {
        section('INDEXES');
        for (const i of diff.indexes.added)
            added(`index ${i} (only in ${labelB})`);
        for (const i of diff.indexes.removed)
            removed(`index ${i} (only in ${labelA})`);
        for (const i of diff.indexes.changed)
            changed(`index ${i} (definition changed)`);
    }
    // Constraints
    if (diff.constraints.added.length || diff.constraints.removed.length || diff.constraints.changed.length) {
        section('CONSTRAINTS');
        for (const c of diff.constraints.added)
            added(`constraint ${c} (only in ${labelB})`);
        for (const c of diff.constraints.removed)
            removed(`constraint ${c} (only in ${labelA})`);
        for (const c of diff.constraints.changed)
            changed(`constraint ${c} (definition changed)`);
    }
    if (!hasChanges) {
        console.log('\nNo differences found. Schemas are identical.');
    }
}
// ── Commander command registration ────────────────────────────────────────────
function registerSchemaDiff(parent) {
    parent
        .command('diff')
        .description('Compare two PostgreSQL schemas or databases')
        .requiredOption('--db1 <url>', 'Connection URL for the first database (or DATABASE_URL env)')
        .option('--db2 <url>', 'Connection URL for the second database (defaults to --db1 if --schema2 provided)')
        .option('--schema1 <name>', 'Schema name in db1 to compare (default: public)', 'public')
        .option('--schema2 <name>', 'Schema name in db2 to compare (default: same as --schema1)')
        .option('--json', 'Output diff as JSON for CI')
        .action(async (opts) => {
        const urlA = opts.db1 || process.env['DATABASE_URL'] || '';
        const urlB = opts.db2 || urlA;
        const schemaA = opts.schema1;
        const schemaB = opts.schema2 ?? schemaA;
        if (!urlA) {
            console.error('Error: --db1 is required (or set DATABASE_URL)');
            process.exit(1);
        }
        let clientA = null;
        let clientB = null;
        try {
            clientA = await (0, db_1.connect)(urlA);
            clientB = urlB === urlA ? clientA : await (0, db_1.connect)(urlB);
            const snapshotA = await introspectSchema(clientA, schemaA);
            const snapshotB = await introspectSchema(clientB, schemaB);
            // Rekey columns using schema label for diff
            const rekeyedA = {
                ...snapshotA,
                columns: Object.fromEntries(Object.entries(snapshotA.columns).map(([k, v]) => [k.replace(/^[^.]+\./, `${schemaA}.`), v])),
            };
            const rekeyedB = {
                ...snapshotB,
                columns: Object.fromEntries(Object.entries(snapshotB.columns).map(([k, v]) => [k.replace(/^[^.]+\./, `${schemaB}.`), v])),
            };
            const diff = diffSchemas(rekeyedA, rekeyedB, schemaA, schemaB);
            if (opts.json) {
                console.log(JSON.stringify(diff, null, 2));
            }
            else {
                console.log(`Comparing schema "${schemaA}" (db1) vs "${schemaB}" (db2)`);
                printDiff(diff, schemaA, schemaB);
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`Error: ${message}`);
            process.exit(1);
        }
        finally {
            if (clientA)
                await (0, db_1.disconnect)(clientA);
            if (clientB && clientB !== clientA)
                await (0, db_1.disconnect)(clientB);
        }
    });
}
//# sourceMappingURL=schema-diff.js.map