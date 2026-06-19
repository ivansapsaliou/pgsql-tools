import * as assert from 'assert';
import type { RoutineParameterInfo } from '../../database/queryExecutor';
import {
	classifyParameterType,
	getArrayTypeInfo,
	parseArrayElements,
	toSqlLiteral,
	validateParameterValue,
} from '../parameterTypes';

function run(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`ok ${name}`);
	} catch (e) {
		console.error(`FAIL ${name}`, e);
		process.exitCode = 1;
	}
}

function param(type: string): RoutineParameterInfo {
	return {
		name: 'p',
		dataType: type,
		udtName: type,
		mode: 'IN',
		ordinalPosition: 1,
	};
}

run('detects bigint[] from DDL type', () => {
	const info = getArrayTypeInfo(param('bigint[]'));
	assert.ok(info);
	assert.strictEqual(info!.elementType, 'bigint');
	assert.strictEqual(info!.pgArrayType, 'bigint[]');
	const c = classifyParameterType(param('bigint[]'));
	assert.strictEqual(c.kind, 'array');
});

run('detects _int8 catalog array type', () => {
	const p: RoutineParameterInfo = {
		name: 'p',
		dataType: 'ARRAY',
		udtName: '_int8',
		mode: 'IN',
		ordinalPosition: 1,
	};
	const c = classifyParameterType(p);
	assert.strictEqual(c.kind, 'array');
	assert.strictEqual(c.pgArrayType, 'int8[]');
});

run('toSqlLiteral comma-separated bigint array', () => {
	const c = classifyParameterType(param('bigint[]'));
	const sql = toSqlLiteral('1, 2, 3', c);
	assert.strictEqual(sql, 'ARRAY[1, 2, 3]::bigint[]');
});

run('toSqlLiteral json array text[]', () => {
	const c = classifyParameterType(param('text[]'));
	const sql = toSqlLiteral('["a", "b"]', c);
	assert.strictEqual(sql, "ARRAY['a', 'b']::text[]");
});

run('validate rejects bad numeric array element', () => {
	const c = classifyParameterType(param('integer[]'));
	const r = validateParameterValue('1, x, 3', c, false);
	assert.strictEqual(r.valid, false);
});
