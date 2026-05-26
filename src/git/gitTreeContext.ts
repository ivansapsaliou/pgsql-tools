import type { GitSyncStatus } from './gitStatusCache';

/** Суффикс для viewItem / contextValue — включает inline-кнопку сравнения. */
export function gitStatusContextSuffix(status: GitSyncStatus): string | undefined {
	if (status === 'in_sync' || status === 'diff' || status === 'missing_in_git') {
		return `+git-${status}`;
	}
	return undefined;
}

export function withGitStatusContextValue(baseContext: string, status?: GitSyncStatus): string {
	const suffix = status ? gitStatusContextSuffix(status) : undefined;
	return suffix ? `${baseContext}${suffix}` : baseContext;
}

export function stripGitStatusContextValue(contextValue: string | undefined): string {
	if (!contextValue) {
		return '';
	}
	const idx = contextValue.indexOf('+git-');
	return idx >= 0 ? contextValue.slice(0, idx) : contextValue;
}
