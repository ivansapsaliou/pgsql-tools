import * as assert from 'assert';
import {
	TraceVariableTracker,
	collectTraceableVariableNames,
	isUntraceableVarType,
} from '../traceVariables';
import { parseRoutineDdl } from '../plpgsqlParse';

function run(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`ok ${name}`);
	} catch (e) {
		console.error(`FAIL ${name}`, e);
		process.exitCode = 1;
	}
}

run('excludes record variables', () => {
	assert.strictEqual(isUntraceableVarType('record'), true);
	const ddl = `
CREATE OR REPLACE PROCEDURE public.p()
 LANGUAGE plpgsql
AS $$
DECLARE
  row_record record;
  v integer;
BEGIN
  v := 1;
END;
$$;
`;
	const parsed = parseRoutineDdl(ddl);
	const names = collectTraceableVariableNames(parsed);
	assert.ok(names.includes('v'));
	assert.ok(!names.includes('row_record'));
});

run('tracker records only value changes', () => {
	const t = new TraceVariableTracker(['v_days']);
	t.applyVars(10, '12:00:00', { v_days: '1' });
	assert.strictEqual(t.getOrderedEntries()[0].changes.length, 0);
	assert.strictEqual(t.applyVars(20, '12:00:01', { v_days: '1' }), 0);
	assert.strictEqual(t.applyVars(30, '12:00:02', { v_days: '5' }), 1);
	assert.strictEqual(t.getOrderedEntries()[0].changes.length, 1);
	assert.strictEqual(t.getOrderedEntries()[0].changes[0].line, 30);
});
