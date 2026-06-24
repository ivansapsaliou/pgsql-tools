export interface BuiltinFunctionSig {
	name: string;
	params: string[];
	returnType?: string;
	documentation?: string;
}

export const SQL_BUILTIN_FUNCTIONS: BuiltinFunctionSig[] = [
	{ name: 'COUNT', params: ['expression'], documentation: 'Count rows or non-null values' },
	{ name: 'SUM', params: ['expression'], documentation: 'Sum of numeric values' },
	{ name: 'AVG', params: ['expression'], documentation: 'Average of numeric values' },
	{ name: 'MIN', params: ['expression'], documentation: 'Minimum value' },
	{ name: 'MAX', params: ['expression'], documentation: 'Maximum value' },
	{ name: 'COALESCE', params: ['val1', 'val2', '...'], documentation: 'First non-NULL value' },
	{ name: 'NULLIF', params: ['val1', 'val2'], documentation: 'NULL if equal, else val1' },
	{ name: 'NOW', params: [], returnType: 'timestamptz', documentation: 'Current timestamp' },
	{ name: 'CURRENT_DATE', params: [], returnType: 'date', documentation: 'Current date' },
	{ name: 'CURRENT_TIMESTAMP', params: [], returnType: 'timestamptz', documentation: 'Current timestamp' },
	{ name: 'LOWER', params: ['string'], documentation: 'Lowercase string' },
	{ name: 'UPPER', params: ['string'], documentation: 'Uppercase string' },
	{ name: 'TRIM', params: ['string'], documentation: 'Trim whitespace' },
	{ name: 'LENGTH', params: ['string'], documentation: 'String length' },
	{ name: 'SUBSTRING', params: ['string', 'from', 'count?'], documentation: 'Extract substring' },
	{ name: 'CONCAT', params: ['str1', 'str2', '...'], documentation: 'Concatenate strings' },
	{ name: 'TO_CHAR', params: ['value', 'format'], documentation: 'Format as string' },
	{ name: 'TO_DATE', params: ['string', 'format'], documentation: 'Parse date string' },
	{ name: 'TO_TIMESTAMP', params: ['string', 'format'], documentation: 'Parse timestamp string' },
	{ name: 'DATE_TRUNC', params: ['field', 'source'], documentation: 'Truncate timestamp/date' },
	{ name: 'EXTRACT', params: ['field FROM source'], documentation: 'Extract subfield' },
	{ name: 'CAST', params: ['expression AS type'], documentation: 'Cast expression' },
	{ name: 'ROW_NUMBER', params: ['OVER (window_spec)'], documentation: 'Window row number' },
	{ name: 'RANK', params: ['OVER (window_spec)'], documentation: 'Window rank' },
	{ name: 'DENSE_RANK', params: ['OVER (window_spec)'], documentation: 'Window dense rank' },
	{ name: 'JSONB_BUILD_OBJECT', params: ['key', 'value', '...'], documentation: 'Build JSONB object' },
	{ name: 'JSONB_AGG', params: ['expression'], documentation: 'Aggregate to JSONB array' },
	{ name: 'ARRAY_AGG', params: ['expression'], documentation: 'Aggregate to array' },
	{ name: 'GENERATE_SERIES', params: ['start', 'stop', 'step?'], documentation: 'Generate series' },
];

export function findBuiltinFunctions(name: string): BuiltinFunctionSig[] {
	const lower = name.toLowerCase();
	return SQL_BUILTIN_FUNCTIONS.filter((f) => f.name.toLowerCase() === lower);
}

export function builtinFunctionsByPrefix(prefix: string): BuiltinFunctionSig[] {
	const lower = prefix.toLowerCase();
	return SQL_BUILTIN_FUNCTIONS.filter((f) => f.name.toLowerCase().startsWith(lower));
}

export function formatBuiltinSignature(fn: BuiltinFunctionSig): string {
	if (fn.params.length === 0) {
		return `${fn.name}()`;
	}
	return `${fn.name}(${fn.params.join(', ')})`;
}
