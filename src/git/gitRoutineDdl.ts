/** Заменяет теги $function$ / $procedure$ на $$ в DDL из pg_get_functiondef. */
export function normalizeRoutineDollarQuotes(ddl: string): string {
	return ddl.replace(/\$function\$/gi, '$$').replace(/\$procedure\$/gi, '$$');
}
