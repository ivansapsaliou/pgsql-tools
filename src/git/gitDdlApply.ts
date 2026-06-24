import type * as pg from 'pg';
import type { QueryExecutor, GitDdlObjectKind } from '../database/queryExecutor';

function quoteIdent(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Выполняет DDL из Git-файла в БД.
 * Для таблиц — DROP CASCADE и полное пересоздание; для routines — CREATE OR REPLACE.
 */
export async function applyGitDdlOnClient(
	queryExecutor: QueryExecutor,
	client: pg.Client,
	schema: string,
	objectName: string,
	kind: GitDdlObjectKind,
	ddl: string
): Promise<void> {
	const script = ddl.replace(/^\uFEFF/, '').trim();
	if (!script) {
		throw new Error('DDL в Git-файле пустой');
	}

	if (kind === 'table') {
		await queryExecutor.executeQueryOnClient(
			client,
			`DROP TABLE IF EXISTS ${quoteIdent(schema)}.${quoteIdent(objectName)} CASCADE`
		);
	}

	await queryExecutor.executeQueryOnClient(client, script);
}
