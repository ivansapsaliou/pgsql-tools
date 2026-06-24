import type { GitDdlObjectKind } from '../database/queryExecutor';

export interface GitCompareKinds {
	table: boolean;
	function: boolean;
	procedure: boolean;
}

export const DEFAULT_COMPARE_KINDS: GitCompareKinds = {
	table: true,
	function: true,
	procedure: true,
};

export function normalizeCompareKinds(kinds?: Partial<GitCompareKinds>): GitCompareKinds {
	return {
		table: kinds?.table !== false,
		function: kinds?.function !== false,
		procedure: kinds?.procedure !== false,
	};
}

export function isGitDdlKind(kind: string): kind is GitDdlObjectKind {
	return kind === 'table' || kind === 'function' || kind === 'procedure';
}
