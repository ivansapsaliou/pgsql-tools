import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SQLParser } from '../sqlParser';

describe('SQLParser.resolveSelectOutputColumns', () => {
	const tableIndex = new Map([['users', 'public']]);
	const resolver = {
		getColumnNames: (schema: string, rel: string) => {
			if (schema === 'public' && rel === 'users') {
				return ['id', 'name', 'email'];
			}
			return [];
		},
		getRelationSchema: (rel: string) => tableIndex.get(rel),
	};

	it('extracts explicit columns from subquery SELECT list', () => {
		const sql = 'SELECT id, name FROM users';
		const cols = SQLParser.resolveSelectOutputColumns(
			sql,
			new Map(),
			tableIndex,
			resolver
		);
		assert.deepEqual(cols, ['id', 'name']);
	});

	it('expands SELECT * from known table', () => {
		const sql = 'SELECT * FROM users u';
		const cols = SQLParser.resolveSelectOutputColumns(
			sql,
			new Map(),
			tableIndex,
			resolver
		);
		assert.deepEqual(cols.sort(), ['email', 'id', 'name']);
	});

	it('parses subquery alias columns in parseAliases', () => {
		const stmt =
			'SELECT sq.id FROM (SELECT id, name FROM users) sq';
		const ctes = SQLParser.parseCTEs(stmt);
		const aliases = SQLParser.parseAliases(
			stmt,
			new Set(ctes.keys()),
			tableIndex,
			false,
			ctes,
			resolver
		);
		assert.ok(aliases.sq);
		assert.equal(aliases.sq.kind, 'subquery');
		assert.deepEqual(aliases.sq.columns, ['id', 'name']);
	});

	it('parses CTE output columns', () => {
		const stmt =
			'WITH user_cte AS (SELECT id, email FROM users) SELECT user_cte.id FROM user_cte';
		const ctes = SQLParser.parseCTEs(stmt);
		assert.ok(ctes.has('user_cte'), 'CTE should be parsed');
		const aliases = SQLParser.parseAliases(
			stmt,
			new Set(ctes.keys()),
			tableIndex,
			true,
			ctes,
			resolver
		);
		assert.ok(aliases.user_cte, 'CTE alias should be registered');
		assert.equal(aliases.user_cte.kind, 'cte');
		assert.deepEqual(aliases.user_cte.columns, ['id', 'email']);
	});
});

describe('SQLParser.getCallContext', () => {
	it('returns active parameter index inside function call', () => {
		const text = 'SELECT coalesce(a, ';
		const ctx = SQLParser.getCallContext(text);
		assert.ok(ctx);
		assert.equal(ctx!.name, 'coalesce');
		assert.equal(ctx!.activeParameterIndex, 1);
		assert.equal(ctx!.isInsideCall, true);
	});

	it('handles schema-qualified call', () => {
		const text = 'SELECT public.my_func(1, ';
		const ctx = SQLParser.getCallContext(text);
		assert.ok(ctx);
		assert.equal(ctx!.schema, 'public');
		assert.equal(ctx!.name, 'my_func');
		assert.equal(ctx!.activeParameterIndex, 1);
	});

	it('counts nested parentheses in arguments', () => {
		const text = 'SELECT coalesce(a, substr(b, 1, 3), ';
		const ctx = SQLParser.getCallContext(text);
		assert.ok(ctx);
		assert.equal(ctx!.name, 'coalesce');
		assert.equal(ctx!.activeParameterIndex, 2);
	});
});

describe('SQLParser.getPrefixContext', () => {
	it('supports quoted identifier prefix', () => {
		const ctx = SQLParser.getPrefixContext('SELECT "My Col');
		assert.equal(ctx.triggerKind, 'word');
		assert.equal(ctx.prefix, 'my col');
		assert.equal(ctx.rawPrefix, 'My Col');
	});

	it('supports schema.table dot completion', () => {
		const ctx = SQLParser.getPrefixContext('SELECT public.use');
		assert.equal(ctx.triggerKind, 'dot');
		assert.equal(ctx.qualifier, 'public');
		assert.equal(ctx.prefix, 'use');
	});
});

describe('SQLParser.detectInsertTarget', () => {
	it('detects INSERT INTO target table', () => {
		const target = SQLParser.detectInsertTarget('INSERT INTO users (');
		assert.ok(target);
		assert.equal(target!.table, 'users');
	});

	it('detects schema-qualified INSERT target', () => {
		const target = SQLParser.detectInsertTarget('INSERT INTO public.users (');
		assert.deepEqual(target, { schema: 'public', table: 'users' });
	});
});
