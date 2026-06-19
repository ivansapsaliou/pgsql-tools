/** Можно ли сохранить RETURN в переменную внутри DO-блока отладки. */
export function canCaptureFunctionReturn(parsed: {
	hasReturn: boolean;
	returnType?: string;
}): boolean {
	if (!parsed.hasReturn || !parsed.returnType) {
		return false;
	}
	const t = parsed.returnType.trim();
	if (/^void(\s|$|\))/i.test(t)) {
		return false;
	}
	if (/^table\s*\(/i.test(t)) {
		return false;
	}
	if (/^setof\s/i.test(t)) {
		return false;
	}
	return true;
}

/** Тип для DECLARE (без DEFAULT и лишних пробелов). */
export function sanitizeTypeForDeclare(type: string): string {
	return type.trim().replace(/\s+DEFAULT\s+[\s\S]+$/i, '');
}
