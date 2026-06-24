import { isSqlReservedWord } from './sqlReservedWords';

export interface AliasMap {
	[alias: string]: ResolvedSource;
}

export interface ResolvedSource {
	kind: 'table' | 'subquery' | 'cte';
	schema?: string;
	table?: string;
	columns?: string[];
}

export interface ColumnResolver {
	getColumnNames(schema: string, relation: string): string[];
	getRelationSchema(relation: string): string | undefined;
}

export interface CallContext {
	name: string;
	schema?: string;
	openParenOffset: number;
	activeParameterIndex: number;
	isInsideCall: boolean;
}

export type LexRegion = 'code' | 'line-comment' | 'block-comment' | 'string' | 'dollar';

export class SQLParser {
	static stripNoise(sql: string): string {
		let result = '';
		let i = 0;
		while (i < sql.length) {
			if (sql[i] === '/' && sql[i + 1] === '*') {
				const end = sql.indexOf('*/', i + 2);
				const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
				result += chunk.replace(/[^\n]/g, ' ');
				i += chunk.length;
				continue;
			}
			if (sql[i] === '-' && sql[i + 1] === '-') {
				const end = sql.indexOf('\n', i);
				const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end);
				result += chunk.replace(/./g, ' ');
				i += chunk.length;
				continue;
			}
			if (sql[i] === "'") {
				let j = i + 1;
				while (j < sql.length) {
					if (sql[j] === "'" && sql[j + 1] === "'") {
						j += 2;
						continue;
					}
					if (sql[j] === "'") {
						j++;
						break;
					}
					j++;
				}
				result += sql.slice(i, j).replace(/[^\n]/g, ' ');
				i = j;
				continue;
			}
			if (sql[i] === '$') {
				const tagMatch = sql.slice(i).match(/^\$([^$]*)\$/);
				if (tagMatch) {
					const tag = tagMatch[0];
					const endTag = sql.indexOf(tag, i + tag.length);
					const chunk = endTag === -1 ? sql.slice(i) : sql.slice(i, endTag + tag.length);
					result += chunk.replace(/[^\n]/g, ' ');
					i += chunk.length;
					continue;
				}
			}
			result += sql[i++];
		}
		return result;
	}

	/** Lexical region at offset (for object scan vs full SQL masking). */
	static getLexRegionAt(sql: string, offset: number): LexRegion {
		if (offset < 0 || offset >= sql.length) {
			return 'code';
		}
		let i = 0;
		while (i < sql.length) {
			if (i > offset) {
				break;
			}
			if (sql[i] === '/' && sql[i + 1] === '*') {
				const end = sql.indexOf('*/', i + 2);
				const endPos = end === -1 ? sql.length : end + 2;
				if (offset >= i && offset < endPos) {
					return 'block-comment';
				}
				i = endPos;
				continue;
			}
			if (sql[i] === '-' && sql[i + 1] === '-') {
				const end = sql.indexOf('\n', i);
				const endPos = end === -1 ? sql.length : end;
				if (offset >= i && offset < endPos) {
					return 'line-comment';
				}
				i = endPos;
				continue;
			}
			if (sql[i] === "'") {
				let j = i + 1;
				while (j < sql.length) {
					if (sql[j] === "'" && sql[j + 1] === "'") {
						j += 2;
						continue;
					}
					if (sql[j] === "'") {
						j++;
						break;
					}
					j++;
				}
				if (offset >= i && offset < j) {
					return 'string';
				}
				i = j;
				continue;
			}
			if (sql[i] === '$') {
				const tagMatch = sql.slice(i).match(/^\$([^$]*)\$/);
				if (tagMatch) {
					const tag = tagMatch[0];
					const close = sql.indexOf(tag, i + tag.length);
					const endPos = close === -1 ? sql.length : close + tag.length;
					if (offset >= i && offset < endPos) {
						return 'dollar';
					}
					i = endPos;
					continue;
				}
			}
			i++;
		}
		return 'code';
	}

	/**
	 * @param forObjectScan when true, identifiers inside $$...$$ (PL/pgSQL body) are scannable
	 */
	static isNoiseAt(sql: string, offset: number, forObjectScan = false): boolean {
		if (offset < 0 || offset >= sql.length) {
			return true;
		}
		if (forObjectScan) {
			const region = this.getLexRegionAt(sql, offset);
			return region === 'line-comment' || region === 'block-comment' || region === 'string';
		}
		const clean = this.stripNoise(sql);
		const c = sql[offset];
		if (c === ' ' || c === '\n' || c === '\r' || c === '\t') {
			return false;
		}
		return clean[offset] === ' ' && c !== ' ';
	}

	/** Like stripNoise but keeps dollar-quoted bodies (only masks comments/strings inside). */
	static stripNoiseForObjectScan(sql: string): string {
		let result = '';
		let i = 0;
		while (i < sql.length) {
			if (sql[i] === '/' && sql[i + 1] === '*') {
				const end = sql.indexOf('*/', i + 2);
				const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
				result += chunk.replace(/[^\n]/g, ' ');
				i += chunk.length;
				continue;
			}
			if (sql[i] === '-' && sql[i + 1] === '-') {
				const end = sql.indexOf('\n', i);
				const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end);
				result += chunk.replace(/./g, ' ');
				i += chunk.length;
				continue;
			}
			if (sql[i] === "'") {
				let j = i + 1;
				while (j < sql.length) {
					if (sql[j] === "'" && sql[j + 1] === "'") {
						j += 2;
						continue;
					}
					if (sql[j] === "'") {
						j++;
						break;
					}
					j++;
				}
				result += sql.slice(i, j).replace(/[^\n]/g, ' ');
				i = j;
				continue;
			}
			if (sql[i] === '$') {
				const tagMatch = sql.slice(i).match(/^\$([^$]*)\$/);
				if (tagMatch) {
					const tag = tagMatch[0];
					const close = sql.indexOf(tag, i + tag.length);
					if (close === -1) {
						result += sql.slice(i);
						break;
					}
					const openEnd = i + tag.length;
					const closeStart = close;
					const closeEnd = close + tag.length;
					result += sql.slice(i, openEnd);
					result += this.maskCommentsAndStringsOnly(sql.slice(openEnd, closeStart));
					result += sql.slice(closeStart, closeEnd);
					i = closeEnd;
					continue;
				}
			}
			result += sql[i++];
		}
		return result;
	}

	private static maskCommentsAndStringsOnly(sql: string): string {
		let result = '';
		let i = 0;
		while (i < sql.length) {
			if (sql[i] === '/' && sql[i + 1] === '*') {
				const end = sql.indexOf('*/', i + 2);
				const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
				result += chunk.replace(/[^\n]/g, ' ');
				i += chunk.length;
				continue;
			}
			if (sql[i] === '-' && sql[i + 1] === '-') {
				const end = sql.indexOf('\n', i);
				const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end);
				result += chunk.replace(/./g, ' ');
				i += chunk.length;
				continue;
			}
			if (sql[i] === "'") {
				let j = i + 1;
				while (j < sql.length) {
					if (sql[j] === "'" && sql[j + 1] === "'") {
						j += 2;
						continue;
					}
					if (sql[j] === "'") {
						j++;
						break;
					}
					j++;
				}
				result += sql.slice(i, j).replace(/[^\n]/g, ' ');
				i = j;
				continue;
			}
			result += sql[i++];
		}
		return result;
	}

	static findClosingParen(sql: string, openIndex: number): number {
		if (sql[openIndex] !== '(') {
			return -1;
		}
		let depth = 0;
		for (let i = openIndex; i < sql.length; i++) {
			if (sql[i] === '(') {
				depth++;
			} else if (sql[i] === ')') {
				depth--;
				if (depth === 0) {
					return i;
				}
			}
		}
		return -1;
	}

	/**
	 * Scope for resolving table aliases / columns.
	 * In PL/pgSQL ($$…$$) uses the current statement (…;), not innermost (SELECT …),
	 * so aliases from the outer INSERT…SELECT remain visible inside subqueries.
	 */
	static findQueryScopeAt(
		sql: string,
		offset: number,
		forObjectScan = false
	): { text: string; start: number } {
		return this.findActiveStatement(sql, offset, forObjectScan);
	}

	static findActiveStatement(
		sql: string,
		offset: number,
		forObjectScan = false
	): { text: string; start: number } {
		const clean = forObjectScan ? this.stripNoiseForObjectScan(sql) : this.stripNoise(sql);
		let depth = 0;
		let stmtStart = 0;

		for (let i = 0; i < clean.length; i++) {
			if (clean[i] === '(') {
				depth++;
			} else if (clean[i] === ')') {
				depth--;
			} else if (clean[i] === ';' && depth === 0) {
				if (i >= offset) {
					return { text: sql.slice(stmtStart, i), start: stmtStart };
				}
				stmtStart = i + 1;
			}
		}
		return { text: sql.slice(stmtStart), start: stmtStart };
	}

	static extractParens(sql: string, start: number): string {
		let depth = 0;
		for (let i = start; i < sql.length; i++) {
			if (sql[i] === '(') {
				depth++;
			} else if (sql[i] === ')') {
				depth--;
				if (depth === 0) {
					return sql.slice(start + 1, i);
				}
			}
		}
		return sql.slice(start + 1);
	}

	static parseCTEs(sql: string, forObjectScan = false): Map<string, string> {
		const ctes = new Map<string, string>();
		const clean = forObjectScan ? this.stripNoiseForObjectScan(sql) : this.stripNoise(sql);

		const withMatch = clean.match(/^\s*WITH\s+/i);
		if (!withMatch) {
			return ctes;
		}

		const re = /\b(\w+)\s+AS\s*\(/gi;
		re.lastIndex = withMatch[0].length;

		let m: RegExpExecArray | null;
		while ((m = re.exec(clean)) !== null) {
			const name = m[1].toLowerCase();
			const bodyStart = m.index + m[0].length - 1;
			const body = this.extractParens(sql, bodyStart);
			ctes.set(name, body);
		}

		return ctes;
	}

	private static registerTableAlias(
		aliases: AliasMap,
		schema: string | undefined,
		table: string,
		alias: string
	): void {
		aliases[alias] = { kind: 'table', schema, table };
		if (alias !== table) {
			aliases[table] = { kind: 'table', schema, table };
		}
	}

	/** JOIN variants — longest first when used in alternation. */
	private static readonly JOIN_PREFIX_RE =
		/^\s*(?:(?:INNER|LEFT|RIGHT|FULL|CROSS|NATURAL)(?:\s+OUTER)?\s+)?JOIN\s+/i;

	private static stripLeadingJoinKeyword(rest: string): string {
		return rest.replace(SQLParser.JOIN_PREFIX_RE, '');
	}

	/** Skip ON … until next JOIN / WHERE / GROUP / ORDER at top level. */
	private static skipOnClause(rest: string): string {
		if (!/^\s*ON\b/i.test(rest)) {
			return rest;
		}
		const onHead = rest.match(/^\s*ON\b/i);
		if (!onHead) {
			return rest;
		}
		let i = onHead[0].length;
		let depth = 0;
		while (i < rest.length) {
			const tail = rest.slice(i);
			if (depth === 0 && SQLParser.JOIN_PREFIX_RE.test(tail)) {
				return tail;
			}
			if (depth === 0 && /^\s*(?:WHERE|GROUP|ORDER|HAVING|LIMIT)\b/i.test(tail)) {
				return tail;
			}
			if (rest[i] === '(') {
				depth++;
			} else if (rest[i] === ')') {
				depth--;
			}
			i++;
		}
		return rest.slice(i);
	}

	private static splitTopLevelCommas(sql: string): string[] {
		const parts: string[] = [];
		let depth = 0;
		let start = 0;
		for (let i = 0; i < sql.length; i++) {
			if (sql[i] === '(') {
				depth++;
			} else if (sql[i] === ')') {
				depth--;
			} else if (sql[i] === ',' && depth === 0) {
				parts.push(sql.slice(start, i));
				start = i + 1;
			}
		}
		parts.push(sql.slice(start));
		return parts;
	}

	/** Output column names from a SELECT subquery/CTE body. */
	static resolveSelectOutputColumns(
		sql: string,
		ctes: Map<string, string>,
		tableIndex: Map<string, string>,
		resolver?: ColumnResolver,
		forObjectScan = false
	): string[] {
		const clean = forObjectScan ? this.stripNoiseForObjectScan(sql) : this.stripNoise(sql);
		const selectMatch = clean.match(/\bSELECT\s+([\s\S]+?)\s+FROM\b/i);
		if (!selectMatch) {
			return [];
		}

		const selectList = selectMatch[1];

		if (selectList.trim() === '*') {
			const aliases = this.parseAliases(
				sql,
				new Set(ctes.keys()),
				tableIndex,
				forObjectScan,
				ctes,
				resolver
			);
			const cols: string[] = [];
			for (const src of Object.values(aliases)) {
				if (src.kind === 'table' && src.table && resolver) {
					const schema =
						src.schema || resolver.getRelationSchema(src.table) || 'public';
					cols.push(...resolver.getColumnNames(schema, src.table));
				} else if (src.kind === 'cte' && src.table) {
					const body = ctes.get(src.table);
					if (body) {
						cols.push(
							...this.resolveSelectOutputColumns(
								body,
								ctes,
								tableIndex,
								resolver,
								forObjectScan
							)
						);
					}
				} else if (src.kind === 'subquery' && src.columns) {
					cols.push(...src.columns);
				}
			}
			return [...new Set(cols)];
		}

		return this.splitTopLevelCommas(selectList)
			.map((expr) => {
				expr = expr.trim();
				const asMatch = expr.match(/\bAS\s+"?(\w+)"?\s*$/i);
				if (asMatch) {
					return asMatch[1];
				}
				const colMatch = expr.match(/(?:"(\w+)"|(\w+))\s*$/);
				if (colMatch) {
					return colMatch[1] || colMatch[2];
				}
				const qualified = expr.match(/\.(?:"(\w+)"|(\w+))\s*$/);
				if (qualified) {
					return qualified[1] || qualified[2];
				}
				return null;
			})
			.filter((c): c is string => c !== null && c !== '*');
	}

	private static parseTableListAfterFrom(
		originalRest: string,
		knownCTEs: Set<string>,
		knownTables: Map<string, string>,
		aliases: AliasMap,
		ctes: Map<string, string>,
		resolver?: ColumnResolver,
		forObjectScan = false
	): void {
		let rest = originalRest;
		for (let guard = 0; guard < 48 && rest.length > 0; guard++) {
			rest = rest.replace(/^\s+/, '');
			if (!rest || rest[0] === ';') {
				break;
			}

			rest = this.stripLeadingJoinKeyword(rest);

			if (rest[0] === '(') {
				const close = this.findClosingParen(rest, 0);
				if (close < 0) {
					break;
				}
				const subqueryBody = rest.slice(1, close);
				const after = rest.slice(close + 1);
				const aliasMatch = after.match(/^\s*(?:AS\s+)?"?(\w+)"?/i);
				if (aliasMatch) {
					const columns = this.resolveSelectOutputColumns(
						subqueryBody,
						ctes,
						knownTables,
						resolver,
						forObjectScan
					);
					aliases[aliasMatch[1].toLowerCase()] = { kind: 'subquery', columns };
				}
				rest = this.skipOnClause(after.slice(aliasMatch ? aliasMatch[0].length : 0));
				rest = this.stripLeadingJoinKeyword(rest);
				continue;
			}

			const qualMatch = rest.match(
				/^\s*(?:"([^"]+)"|(\w+))\s*\.\s*(?:"([^"]+)"|(\w+))(?:\s+(?:AS\s+)?(?:"([^"]+)"|(\w+)))?(?=\s|,|$|\))/i
			);
			const simpleMatch = qualMatch
				? null
				: rest.match(
						/^\s*(?:"([^"]+)"|(\w+))(?:\s+(?:AS\s+)?(?:"([^"]+)"|(\w+)))?(?=\s|,|$|\)|;)/i
					);
			const tableMatch = qualMatch ?? simpleMatch;
			if (!tableMatch) {
				break;
			}

			let schema: string | undefined;
			let table: string;
			let alias: string;
			const consumed = tableMatch[0].length;

			if (qualMatch) {
				schema = (qualMatch[1] || qualMatch[2]).toLowerCase();
				table = (qualMatch[3] || qualMatch[4]).toLowerCase();
				alias = (qualMatch[5] || qualMatch[6] || table).toLowerCase();
			} else if (simpleMatch) {
				table = (simpleMatch[1] || simpleMatch[2]).toLowerCase();
				alias = (simpleMatch[3] || simpleMatch[4] || table).toLowerCase();
				if (knownCTEs.has(table)) {
					const cteBody = ctes.get(table);
					const columns = cteBody
						? this.resolveSelectOutputColumns(
								cteBody,
								ctes,
								knownTables,
								resolver,
								forObjectScan
							)
						: [];
					aliases[alias] = { kind: 'cte', table, columns };
					rest = rest.slice(consumed).replace(/^\s*,\s*/, '');
					rest = this.stripLeadingJoinKeyword(rest);
					continue;
				}
				schema = knownTables.get(table);
			} else {
				break;
			}

			if (isSqlReservedWord(table) || isSqlReservedWord(alias)) {
				rest = rest.slice(consumed);
				continue;
			}

			this.registerTableAlias(aliases, schema, table, alias);
			rest = rest.slice(consumed);
			rest = rest.replace(/^\s*,\s*/, '');
			rest = this.skipOnClause(rest);
			rest = this.stripLeadingJoinKeyword(rest);
		}
	}

	static parseAliases(
		sql: string,
		knownCTEs: Set<string>,
		knownTables: Map<string, string>,
		forObjectScan = false,
		ctesMap?: Map<string, string>,
		resolver?: ColumnResolver
	): AliasMap {
		const aliases: AliasMap = {};
		const ctes = ctesMap ?? this.parseCTEs(sql, forObjectScan);
		const clean = forObjectScan ? this.stripNoiseForObjectScan(sql) : this.stripNoise(sql);
		const upper = clean.toUpperCase();

		const fromJoinRe =
			/\b(?:FROM|INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN|NATURAL\s+JOIN|JOIN)\s+/gi;
		let m: RegExpExecArray | null;

		while ((m = fromJoinRe.exec(upper)) !== null) {
			const pos = m.index + m[0].length;
			this.parseTableListAfterFrom(
				sql.slice(pos),
				knownCTEs,
				knownTables,
				aliases,
				ctes,
				resolver,
				forObjectScan
			);
		}

		if (!forObjectScan) {
			const insertRe = /\bINSERT\s+INTO\s+(?:ONLY\s+)?/gi;
			while ((m = insertRe.exec(upper)) !== null) {
				const pos = m.index + m[0].length;
				this.parseTableListAfterFrom(
					sql.slice(pos),
					knownCTEs,
					knownTables,
					aliases,
					ctes,
					resolver,
					forObjectScan
				);
			}

			const updateRe = /\bUPDATE\s+(?:ONLY\s+)?/gi;
			while ((m = updateRe.exec(upper)) !== null) {
				const pos = m.index + m[0].length;
				this.parseTableListAfterFrom(
					sql.slice(pos),
					knownCTEs,
					knownTables,
					aliases,
					ctes,
					resolver,
					forObjectScan
				);
			}

			const deleteRe = /\bDELETE\s+FROM\s+/gi;
			while ((m = deleteRe.exec(upper)) !== null) {
				const pos = m.index + m[0].length;
				this.parseTableListAfterFrom(
					sql.slice(pos),
					knownCTEs,
					knownTables,
					aliases,
					ctes,
					resolver,
					forObjectScan
				);
			}
		}

		return aliases;
	}

	static getPrefixContext(textBeforeCursor: string): {
		qualifier: string | null;
		prefix: string;
		triggerKind: 'dot' | 'word';
		rawPrefix?: string;
	} {
		const quotedDot = textBeforeCursor.match(/"([^"]*)"\."([^"]*)$/);
		if (quotedDot) {
			return {
				qualifier: quotedDot[1].toLowerCase(),
				prefix: quotedDot[2].toLowerCase(),
				rawPrefix: quotedDot[2],
				triggerKind: 'dot',
			};
		}
		const mixedDot = textBeforeCursor.match(/(?:"([^"]+)"|(\w+))\.("([^"]*)"|(\w*))$/);
		if (mixedDot) {
			const qualifier = (mixedDot[1] || mixedDot[2] || '').toLowerCase();
			const prefix = (mixedDot[4] ?? mixedDot[5] ?? '').toLowerCase();
			return {
				qualifier,
				prefix,
				rawPrefix: mixedDot[4] ?? mixedDot[5],
				triggerKind: 'dot',
			};
		}

		const dotMatch = textBeforeCursor.match(/(\w+)\.(\w*)$/);
		if (dotMatch) {
			return {
				qualifier: dotMatch[1].toLowerCase(),
				prefix: dotMatch[2].toLowerCase(),
				rawPrefix: dotMatch[2],
				triggerKind: 'dot',
			};
		}

		const quotedWord = textBeforeCursor.match(/"([^"]*)$/);
		if (quotedWord) {
			return {
				qualifier: null,
				prefix: quotedWord[1].toLowerCase(),
				rawPrefix: quotedWord[1],
				triggerKind: 'word',
			};
		}

		const wordMatch = textBeforeCursor.match(/(\w*)$/);
		return {
			qualifier: null,
			prefix: wordMatch ? wordMatch[1].toLowerCase() : '',
			rawPrefix: wordMatch ? wordMatch[1] : '',
			triggerKind: 'word',
		};
	}

	/** Call-site context for Signature Help (cursor inside `func(a, |)`). */
	static getCallContext(textBeforeCursor: string): CallContext | null {
		if (textBeforeCursor.length === 0) {
			return null;
		}

		let depth = 0;
		let openParen = -1;
		for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
			const ch = textBeforeCursor[i];
			if (this.isInsideStringOrComment(textBeforeCursor, i)) {
				continue;
			}
			if (ch === ')') {
				depth++;
			} else if (ch === '(') {
				if (depth === 0) {
					openParen = i;
					break;
				}
				depth--;
			}
		}

		if (openParen < 0) {
			return null;
		}

		let end = openParen;
		while (end > 0 && /\s/.test(textBeforeCursor[end - 1])) {
			end--;
		}

		let start = end;
		while (start > 0 && /[\w"]/.test(textBeforeCursor[start - 1])) {
			start--;
		}

		const identRaw = textBeforeCursor.slice(start, end).trim();
		if (!identRaw || !/[\w"]/.test(identRaw)) {
			return null;
		}

		const parts = identRaw
			.split(/\s*\.\s*/)
			.map((p) => p.replace(/^"|"$/g, '').toLowerCase())
			.filter((p) => p.length > 0);

		if (parts.length === 0) {
			return null;
		}

		let schema: string | undefined;
		let name: string;
		if (parts.length >= 2) {
			schema = parts[parts.length - 2];
			name = parts[parts.length - 1];
		} else {
			name = parts[0];
		}

		// Extend identifier read to include schema qualifier (public.my_func)
		if (!schema && start > 0) {
			let pos = start;
			if (pos > 0 && textBeforeCursor[pos - 1] === '.') {
				pos--;
				while (pos > 0 && /[\w"]/.test(textBeforeCursor[pos - 1])) {
					pos--;
				}
				const qualParts = textBeforeCursor
					.slice(pos, start - 1)
					.split(/\s*\.\s*/)
					.map((p) => p.replace(/^"|"$/g, '').toLowerCase())
					.filter((p) => p.length > 0);
				if (qualParts.length >= 1) {
					schema = qualParts[0];
				}
			}
		}

		const argsText = textBeforeCursor.slice(openParen + 1);
		const activeParameterIndex = this.countCommasAtTopLevel(argsText);

		return {
			name,
			schema,
			openParenOffset: openParen,
			activeParameterIndex,
			isInsideCall: true,
		};
	}

	private static isInsideStringOrComment(sql: string, offset: number): boolean {
		const region = this.getLexRegionAt(sql, offset);
		return region !== 'code';
	}

	private static countCommasAtTopLevel(argsText: string): number {
		let depth = 0;
		let count = 0;
		for (let i = 0; i < argsText.length; i++) {
			if (this.isInsideStringOrComment(argsText, i)) {
				continue;
			}
			const ch = argsText[i];
			if (ch === '(') {
				depth++;
			} else if (ch === ')') {
				depth--;
			} else if (ch === ',' && depth === 0) {
				count++;
			}
		}
		return count;
	}

	static detectInsertTarget(textBeforeCursor: string): { schema?: string; table: string } | null {
		const upper = textBeforeCursor.toUpperCase();
		const idx = upper.lastIndexOf('INSERT INTO');
		if (idx === -1) {
			return null;
		}
		const after = textBeforeCursor.slice(idx + 'INSERT INTO'.length).trimStart();
		const onlySkip = after.replace(/^ONLY\s+/i, '');
		const match = onlySkip.match(
			/^"?(\w+)"?\s*\.\s*"?(\w+)"?(?:\s*\(|[\s,]|$)|^"?(\w+)"?(?:\s*\(|[\s,]|$)/i
		);
		if (!match) {
			return null;
		}
		if (match[1] && match[2]) {
			return { schema: match[1].toLowerCase(), table: match[2].toLowerCase() };
		}
		if (match[3]) {
			return { table: match[3].toLowerCase() };
		}
		return null;
	}

	static detectClause(textBeforeCursor: string): string {
		const upper = textBeforeCursor.toUpperCase();
		const clauses = [
			'ON',
			'SET',
			'HAVING',
			'ORDER BY',
			'GROUP BY',
			'WHERE',
			'JOIN',
			'FROM',
			'SELECT',
			'INSERT INTO',
			'UPDATE',
			'DELETE FROM',
		];
		for (const clause of clauses) {
			const idx = upper.lastIndexOf(clause);
			if (idx !== -1) {
				return clause;
			}
		}
		return 'SELECT';
	}

	/** Qualified identifier at offset: schema.table.col, alias.col, or single word. */
	static getQualifiedIdentifierAt(
		sql: string,
		offset: number,
		forObjectScan = false
	): { parts: string[]; start: number; end: number } | null {
		if (SQLParser.isNoiseAt(sql, offset, forObjectScan)) {
			return null;
		}

		let start = offset;
		while (start > 0) {
			const prev = sql[start - 1];
			if (/[\w"]/.test(prev) || prev === '.') {
				start--;
			} else {
				break;
			}
		}

		let end = offset;
		while (end < sql.length) {
			const ch = sql[end];
			if (/[\w"]/.test(ch) || ch === '.') {
				end++;
			} else {
				break;
			}
		}

		const raw = sql.slice(start, end);
		if (!raw || !/[\w]/.test(raw)) {
			return null;
		}

		const parts = raw
			.split('.')
			.map((p) => p.replace(/^"|"$/g, '').toLowerCase())
			.filter((p) => p.length > 0);

		if (parts.length === 0) {
			return null;
		}

		return { parts, start, end };
	}

	/** True if `(` follows identifier (allowing whitespace). */
	static isCallSite(sql: string, endOffset: number): boolean {
		let i = endOffset;
		while (i < sql.length && /\s/.test(sql[i])) {
			i++;
		}
		return sql[i] === '(';
	}
}
