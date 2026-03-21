#!/usr/bin/env node
import { Command } from 'commander';
import { registerSchemaDiff } from './commands/schema-diff';
import { registerSchemaErd } from './commands/schema-erd';
import {
  registerHealthSlowQueries,
  registerHealthLocks,
  registerHealthSizes,
  registerHealthVacuum,
} from './commands/health';
import { registerExplain } from './commands/explain';

const program = new Command();

program
  .name('pgsql-tools')
  .description('PostgreSQL introspection, diagnostics, and health CLI')
  .version('0.1.0');

// ── schema ────────────────────────────────────────────────────────────────────
const schema = program
  .command('schema')
  .description('Schema introspection and generation commands');

registerSchemaDiff(schema);
registerSchemaErd(schema);

// ── health ────────────────────────────────────────────────────────────────────
const health = program
  .command('health')
  .description('Database health and diagnostics commands');

registerHealthSlowQueries(health);
registerHealthLocks(health);
registerHealthSizes(health);
registerHealthVacuum(health);

// ── explain ───────────────────────────────────────────────────────────────────
registerExplain(program);

program.parse(process.argv);
