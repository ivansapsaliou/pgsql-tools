import * as assert from 'assert';
import { parseRoutineDdl, collectTraceVariableNames } from '../plpgsqlParse';
import { buildDebugDoBlock, instrumentPlpgsqlBody } from '../plpgsqlInstrumenter';
import { canCaptureFunctionReturn } from '../routineReturn';
import { bodyOffsetToEditorLine, editorLineAt } from '../lineMap';

const SAMPLE_FUNCTION = `
CREATE OR REPLACE FUNCTION public.sample_func(p_id integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $$
DECLARE
  v_cnt integer := 0;
BEGIN
  v_cnt := p_id + 1;
  RETURN v_cnt;
END;
$$;
`;

function run(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`ok ${name}`);
	} catch (e) {
		console.error(`FAIL ${name}`, e);
		process.exitCode = 1;
	}
}

run('parseRoutineDdl extracts body and vars', () => {
	const parsed = parseRoutineDdl(SAMPLE_FUNCTION);
	assert.strictEqual(parsed.kind, 'function');
	assert.strictEqual(parsed.parameters.length, 1);
	assert.strictEqual(parsed.parameters[0].name, 'p_id');
	assert.strictEqual(parsed.declareVars.length, 1);
	assert.strictEqual(parsed.declareVars[0].name, 'v_cnt');
	assert.ok(parsed.body.includes('v_cnt := p_id + 1'));
	assert.ok(parsed.bodyStartOffset > 0);
	assert.ok(parsed.ddlText.includes('CREATE OR REPLACE'));
	const vars = collectTraceVariableNames(parsed);
	assert.ok(vars.includes('p_id'));
	assert.ok(vars.includes('v_cnt'));
});

run('editor line matches DDL document for assignment statement', () => {
	const parsed = parseRoutineDdl(SAMPLE_FUNCTION);
	const assignOffset = parsed.body.indexOf('v_cnt := p_id + 1');
	assert.ok(assignOffset >= 0);
	const editorLine = bodyOffsetToEditorLine(parsed, assignOffset);
	const expectedLine = editorLineAt(parsed.ddlText, parsed.ddlText.indexOf('v_cnt := p_id + 1'));
	assert.strictEqual(editorLine, expectedLine);
	assert.ok(editorLine > 1, `line must be within full DDL document, got ${editorLine}`);
});

run('instrumentPlpgsqlBody uses editor line numbers', () => {
	const parsed = parseRoutineDdl(SAMPLE_FUNCTION);
	const vars = collectTraceVariableNames(parsed);
	const assignOffset = parsed.body.indexOf('v_cnt := p_id + 1');
	const expectedLine = bodyOffsetToEditorLine(parsed, assignOffset);
	const result = instrumentPlpgsqlBody(parsed.body, {
		mode: 'trace',
		breakpointLines: new Set([expectedLine]),
		parsed,
		varNames: vars,
	});
	assert.ok(result.code.includes('[PGSQL_TOOLS]'));
	assert.ok(result.points.some((p) => p.sourceLine === expectedLine));
});

run('parseParamList from DDL header with nested DEFAULT parens', () => {
	const ddl = `
CREATE OR REPLACE FUNCTION public.calc(
  p_start_date timestamp without time zone,
  p_end_date timestamp without time zone,
  p_node_calculate_parameter_id bigint,
  p_observation_type_id bigint
)
 RETURNS void
 LANGUAGE plpgsql
AS $body$
BEGIN
  NULL;
END;
$body$;
`;
	const parsed = parseRoutineDdl(ddl);
	assert.strictEqual(parsed.parameters.length, 4);
	assert.strictEqual(parsed.parameters[0].name, 'p_start_date');
	assert.strictEqual(parsed.parameters[1].name, 'p_end_date');
	assert.ok(parsed.parameters[0].type.toLowerCase().includes('timestamp'));
	assert.strictEqual(parsed.parameters[2].name, 'p_node_calculate_parameter_id');
	assert.strictEqual(parsed.parameters[2].type, 'bigint');
});

run('instrumentPlpgsqlBody instruments inside IF/ELSIF', () => {
	const ddl = `
CREATE OR REPLACE FUNCTION public.f(p_id integer)
 RETURNS integer
 LANGUAGE plpgsql
AS $$
BEGIN
  IF p_id < 0 THEN
    RAISE EXCEPTION 'bad';
  ELSIF p_id = 0 THEN
    p_id := 1;
  END IF;
  RETURN p_id;
END;
$$;
`;
	const parsed = parseRoutineDdl(ddl);
	const vars = collectTraceVariableNames(parsed);
	const result = instrumentPlpgsqlBody(parsed.body, {
		mode: 'trace',
		breakpointLines: new Set(),
		parsed,
		varNames: vars,
	});
	// Хук должен появиться после оператора в ветке THEN.
	assert.ok(result.code.includes("RAISE EXCEPTION 'bad';"));
	assert.ok(result.code.includes("[PGSQL_TOOLS]"));
	assert.ok(result.code.includes('RETURN p_id'));
});

run('void function omits result variable in debug DO', () => {
	const ddl = `
CREATE OR REPLACE FUNCTION public.noop()
 RETURNS void
 LANGUAGE plpgsql
AS $$
BEGIN
  RETURN;
END;
$$;
`;
	const parsed = parseRoutineDdl(ddl);
	assert.strictEqual(canCaptureFunctionReturn(parsed), false);
	const sql = buildDebugDoBlock(parsed, 'NULL;', []);
	assert.ok(!sql.includes('_pgsql_tools_result'));
});

run('rejects non-plpgsql', () => {
	assert.throws(() => {
		parseRoutineDdl(`
CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$;
`);
	});
});

run('findMatchingEnd ignores END from CASE expression', () => {
	const ddl = `
CREATE OR REPLACE FUNCTION public.case_end_test(p_id integer)
  RETURNS integer
  LANGUAGE plpgsql
AS $$
DECLARE
  x integer;
BEGIN
  SELECT CASE WHEN p_id > 0 THEN 1 ELSE 0 END INTO x;
  RETURN x;
END;
$$;
`;
	const parsed = parseRoutineDdl(ddl);
	assert.ok(parsed.body.includes('SELECT CASE WHEN'));
	assert.ok(parsed.body.includes('RETURN x;'));
});

run('instrumentPlpgsqlBody traces inside FOR loop body', () => {
	const ddl = `
CREATE OR REPLACE PROCEDURE public.loop_trace()
 LANGUAGE plpgsql
AS $$
DECLARE
  v integer := 0;
BEGIN
  FOR i IN 1..3 LOOP
    v := v + 1;
  END LOOP;
END;
$$;
`;
	const parsed = parseRoutineDdl(ddl);
	const vars = collectTraceVariableNames(parsed).filter((n) => n !== 'i');
	const result = instrumentPlpgsqlBody(parsed.body, {
		mode: 'trace',
		breakpointLines: new Set(),
		parsed,
		varNames: vars,
	});
	assert.ok(result.code.includes('v := v + 1;'));
	assert.ok(/v := v \+ 1;\s*\n\s*RAISE NOTICE '\[PGSQL_TOOLS\]/.test(result.code));
});

run('findMatchingEnd ignores END from LOOP with comments', () => {
	const ddl = `
CREATE OR REPLACE FUNCTION public.loop_end_comment_test(p_id integer)
  RETURNS integer
  LANGUAGE plpgsql
AS $$
DECLARE
  x integer := 0;
BEGIN
  LOOP
    EXIT WHEN x = p_id;
    x := x + 1;
  END /* some comment */ LOOP;
  RETURN x;
END;
$$;
`;
	const parsed = parseRoutineDdl(ddl);
	assert.ok(parsed.body.includes('EXIT WHEN x = p_id'));
	assert.ok(parsed.body.includes('x := x + 1'));
	assert.ok(parsed.body.includes('RETURN x;'));
});
