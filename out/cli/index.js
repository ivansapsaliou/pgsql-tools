#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const schema_diff_1 = require("./commands/schema-diff");
const schema_erd_1 = require("./commands/schema-erd");
const health_1 = require("./commands/health");
const explain_1 = require("./commands/explain");
const program = new commander_1.Command();
program
    .name('pgsql-tools')
    .description('PostgreSQL introspection, diagnostics, and health CLI')
    .version('0.1.0');
// ── schema ────────────────────────────────────────────────────────────────────
const schema = program
    .command('schema')
    .description('Schema introspection and generation commands');
(0, schema_diff_1.registerSchemaDiff)(schema);
(0, schema_erd_1.registerSchemaErd)(schema);
// ── health ────────────────────────────────────────────────────────────────────
const health = program
    .command('health')
    .description('Database health and diagnostics commands');
(0, health_1.registerHealthSlowQueries)(health);
(0, health_1.registerHealthLocks)(health);
(0, health_1.registerHealthSizes)(health);
(0, health_1.registerHealthVacuum)(health);
// ── explain ───────────────────────────────────────────────────────────────────
(0, explain_1.registerExplain)(program);
program.parse(process.argv);
//# sourceMappingURL=index.js.map