import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSqlCompletionContextFromText } from '../sqlCompletionContext';
import type { ColumnInfo, RelationInfo } from '../sqlSchemaRegistry';

interface MockRegistry {
	isConnected(): boolean;
	ensureFresh(): Promise<boolean>;
	getAllRelations(): RelationInfo[];
	getTableIndex(): Map<string, string>;
	getRelationColumns(schema: string, name: string): ColumnInfo[];
	getTableSchema(name: string): string | undefined;
	hasSchema(name: string): boolean;
	getSchemas(): string[];
	findRelationsByPrefix(prefix: string): RelationInfo[];
	getAllRoutines(): [];
}

function createMockRegistry(relations: RelationInfo[]): MockRegistry {
	return {
		isConnected: () => true,
		ensureFresh: async () => true,
		getAllRelations: () => relations,
		getTableIndex: () => {
			const m = new Map<string, string>();
			for (const r of relations) {
				m.set(r.name.toLowerCase(), r.schema);
			}
			return m;
		},
		getRelationColumns: (schema, name) =>
			relations.find((r) => r.schema === schema && r.name === name)?.columns ?? [],
		getTableSchema: (name) =>
			relations.find((r) => r.name.toLowerCase() === name.toLowerCase())?.schema,
		hasSchema: (name) =>
			relations.some((r) => r.schema.toLowerCase() === name.toLowerCase()),
		getSchemas: () => [...new Set(relations.map((r) => r.schema))],
		findRelationsByPrefix: (prefix) => {
			const lower = prefix.toLowerCase();
			return relations.filter((r) => r.name.toLowerCase().startsWith(lower));
		},
		getAllRoutines: () => [],
	};
}

const usersRelation: RelationInfo = {
	schema: 'public',
	name: 'users',
	kind: 'table',
	columns: [
		{ name: 'id', type: 'integer', nullable: false, comment: null },
		{ name: 'name', type: 'text', nullable: true, comment: null },
		{ name: 'email', type: 'text', nullable: true, comment: null },
	],
};

describe('buildSqlCompletionContext', () => {
	const registry = createMockRegistry([usersRelation]);

	it('FROM clause suggests table context', () => {
		const sql = 'SELECT * FROM ';
		const ctx = buildSqlCompletionContextFromText(
			sql,
			sql.length,
			registry as unknown as import('../sqlSchemaRegistry').SqlSchemaRegistry
		);
		assert.equal(ctx.inNoise, false);
		assert.equal(ctx.kind, 'table');
		assert.equal(ctx.clause, 'FROM');
		assert.ok(ctx.scopeRelations.some((r) => r.name === 'users'));
	});

	it('WHERE clause exposes scope columns from aliased table', () => {
		const sql = 'SELECT * FROM users u WHERE ';
		const ctx = buildSqlCompletionContextFromText(
			sql,
			sql.length,
			registry as unknown as import('../sqlSchemaRegistry').SqlSchemaRegistry
		);
		assert.equal(ctx.kind, 'column');
		const names = ctx.scopeColumns.map((c) => c.name).sort();
		assert.deepEqual(names, ['email', 'id', 'name']);
	});

	it('INSERT column list context', () => {
		const sql = 'INSERT INTO users (';
		const ctx = buildSqlCompletionContextFromText(
			sql,
			sql.length,
			registry as unknown as import('../sqlSchemaRegistry').SqlSchemaRegistry
		);
		assert.equal(ctx.kind, 'insertColumn');
	});

	it('subquery alias columns appear in scope', () => {
		const sql = 'SELECT sq. FROM (SELECT id, name FROM users) sq';
		const offset = sql.indexOf('sq.') + 3;
		const ctx = buildSqlCompletionContextFromText(
			sql,
			offset,
			registry as unknown as import('../sqlSchemaRegistry').SqlSchemaRegistry
		);
		assert.equal(ctx.triggerKind, 'dot');
		assert.equal(ctx.qualifier, 'sq');
		const sqSource = ctx.aliases.sq;
		assert.ok(sqSource);
		assert.deepEqual(sqSource.columns, ['id', 'name']);
	});

	it('PL/pgSQL dollar-quoted body is not treated as noise', () => {
		const sql = [
			'CREATE OR REPLACE FUNCTION public.demo()',
			'RETURNS void LANGUAGE plpgsql AS $$',
			'BEGIN',
			'  SEL',
		].join('\n');
		const offset = sql.length;
		const ctx = buildSqlCompletionContextFromText(
			sql,
			offset,
			registry as unknown as import('../sqlSchemaRegistry').SqlSchemaRegistry
		);
		assert.equal(ctx.inNoise, false);
		assert.notEqual(ctx.kind, 'connectHint');
	});
});
