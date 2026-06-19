import type { RoutineParameterInfo } from '../database/queryExecutor';
import { parseRoutineDdl, type RoutineParam } from './plpgsqlParse';

/** Входной параметр (включая INOUT, VARIADIC). */
export function isInputParameterMode(mode: string): boolean {
	const m = mode.toUpperCase();
	return m === 'IN' || m === 'INOUT' || m === 'VARIADIC';
}

export function filterInputParameters(params: RoutineParameterInfo[]): RoutineParameterInfo[] {
	return params.filter((p) => isInputParameterMode(p.mode));
}

/** Входные параметры из текста DDL (CREATE FUNCTION/PROCEDURE …). */
export function parametersFromDdl(ddl: string): RoutineParameterInfo[] {
	const parsed = parseRoutineDdl(ddl);
	return parametersFromParsedRoutine(parsed.parameters);
}

/** Параметры из уже разобранного списка. */
export function parametersFromParsedRoutine(
	parsedParams: RoutineParam[],
	startOrdinal = 1
): RoutineParameterInfo[] {
	return parsedParams
		.filter((p) => isInputParameterMode(p.mode))
		.map((p, i) => ({
			name: p.name,
			dataType: p.type,
			udtName: p.type,
			mode: p.mode,
			ordinalPosition: startOrdinal + i,
		}));
}
