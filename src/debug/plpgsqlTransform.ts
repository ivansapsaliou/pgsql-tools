import { advancePast, getRegionAt, readWordAt } from './plpgsqlLexer';

/** Заменяет RETURN expr; на присвоение resultVar (для DO-блока). */
export function rewriteReturnsForDo(body: string, resultVar: string): string {
	const replacements: { start: number; end: number; text: string }[] = [];
	let blockDepth = 0;
	let i = 0;

	while (i < body.length) {
		if (getRegionAt(body, i) !== 'code') {
			i = advancePast(body, i);
			continue;
		}
		const word = readWordAt(body, i);
		if (word) {
			if (/^BEGIN$/i.test(word)) {
				blockDepth++;
				i += word.length;
				continue;
			}
			if (/^END$/i.test(word)) {
				blockDepth = Math.max(0, blockDepth - 1);
				i += word.length;
				continue;
			}
			if (blockDepth <= 1 && /^RETURN$/i.test(word)) {
				const afterReturn = i + word.length;
				const semi = findSemicolon(body, afterReturn);
				if (semi > 0) {
					const expr = body.slice(afterReturn, semi).trim();
					const text =
						expr.length === 0
							? `-- return removed for debug DO`
							: `${resultVar} := ${expr};`;
					replacements.push({ start: i, end: semi + 1, text });
					i = semi + 1;
					continue;
				}
			}
		}
		i++;
	}

	let out = body;
	for (const r of replacements.sort((a, b) => b.start - a.start)) {
		out = out.slice(0, r.start) + r.text + out.slice(r.end);
	}
	return out;
}

function findSemicolon(body: string, from: number): number {
	let i = from;
	while (i < body.length) {
		if (getRegionAt(body, i) === 'code' && body[i] === ';') {
			return i;
		}
		i = advancePast(body, i);
		if (getRegionAt(body, i) === 'code' && i < body.length && body[i] !== ';') {
			i++;
		}
	}
	return -1;
}
