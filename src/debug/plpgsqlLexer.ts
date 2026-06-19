/** Лексические регионы для обхода PL/pgSQL-тела. */
export type LexRegion = 'code' | 'line-comment' | 'block-comment' | 'string' | 'dollar';

export interface LexState {
	region: LexRegion;
	dollarTag?: string;
	blockDepth: number;
}

export function forEachCodePosition(
	body: string,
	onPosition: (index: number, state: LexState) => void
): void {
	let i = 0;
	let blockDepth = 0;
	while (i < body.length) {
		const region = getRegionAt(body, i);
		if (region === 'code') {
			const word = readWordAt(body, i);
			if (word && /^begin$/i.test(word)) {
				blockDepth++;
			} else if (word && /^end$/i.test(word)) {
				blockDepth = Math.max(0, blockDepth - 1);
			}
			onPosition(i, { region, blockDepth });
		}
		i = advancePast(body, i);
	}
}

export function getRegionAt(body: string, offset: number): LexRegion {
	let i = 0;
	while (i < body.length) {
		if (i > offset) {
			break;
		}
		const start = i;
		const next = advancePast(body, i);
		if (offset >= start && offset < next) {
			if (body[i] === '/' && body[i + 1] === '*') {
				return 'block-comment';
			}
			if (body[i] === '-' && body[i + 1] === '-') {
				return 'line-comment';
			}
			if (body[i] === "'") {
				return 'string';
			}
			if (body[i] === '$') {
				return 'dollar';
			}
			return 'code';
		}
		i = next;
	}
	return 'code';
}

export function advancePast(body: string, i: number): number {
	if (body[i] === '/' && body[i + 1] === '*') {
		const end = body.indexOf('*/', i + 2);
		return end === -1 ? body.length : end + 2;
	}
	if (body[i] === '-' && body[i + 1] === '-') {
		const end = body.indexOf('\n', i);
		return end === -1 ? body.length : end;
	}
	if (body[i] === "'") {
		let j = i + 1;
		while (j < body.length) {
			if (body[j] === "'" && body[j + 1] === "'") {
				j += 2;
				continue;
			}
			if (body[j] === "'") {
				return j + 1;
			}
			j++;
		}
		return body.length;
	}
	if (body[i] === '$') {
		const tagMatch = body.slice(i).match(/^\$([^$]*)\$/);
		if (tagMatch) {
			const tag = tagMatch[0];
			const endTag = body.indexOf(tag, i + tag.length);
			return endTag === -1 ? body.length : endTag + tag.length;
		}
	}
	return i + 1;
}

export function readWordAt(body: string, offset: number): string | null {
	if (getRegionAt(body, offset) !== 'code') {
		return null;
	}
	const m = body.slice(offset).match(/^([a-zA-Z_][a-zA-Z0-9_$]*)/);
	return m ? m[1] : null;
}

/** Номера строк (1-based) внутри body для каждого индекса. */
export function buildLineIndex(body: string): number[] {
	const lines: number[] = new Array(body.length);
	let line = 1;
	for (let i = 0; i < body.length; i++) {
		lines[i] = line;
		if (body[i] === '\n') {
			line++;
		}
	}
	return lines;
}

export function lineAt(body: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < body.length; i++) {
		if (body[i] === '\n') {
			line++;
		}
	}
	return line;
}
