/** В replacement-строке JS `$$` = один `$`; для литерала `$$` нужно `$$$$`. */
const DOLLAR_QUOTE = '$$$$';

/** Заменяет теги $function$ / $procedure$ на $$ в DDL из pg_get_functiondef. */
export function normalizeRoutineDollarQuotes(ddl: string): string {
	return ddl
		.replace(/\$function\$/gi, DOLLAR_QUOTE)
		.replace(/\$procedure\$/gi, DOLLAR_QUOTE);
}

/** Убирает IN у параметров процедуры (значение по умолчанию в PostgreSQL). */
export function stripProcedureInParams(ddl: string): string {
	return ddl.replace(/\(\s*IN\s+/gi, '(').replace(/,\s*IN\s+/gi, ', ');
}
