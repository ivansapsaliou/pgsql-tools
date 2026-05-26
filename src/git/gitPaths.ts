import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { GitDdlObjectKind } from '../database/queryExecutor';

/** Порядок: сначала вариант из вашего Git (Tables / Function / Procedures). */
const KIND_FOLDER_CANDIDATES: Record<GitDdlObjectKind, string[]> = {
	table: ['Tables', 'tables'],
	function: ['Function', 'function'],
	procedure: ['Procedures', 'procedures'],
};

export function getKindFolderCandidates(kind: GitDdlObjectKind): string[] {
	return KIND_FOLDER_CANDIDATES[kind];
}

export function getPreferredGitFolder(kind: GitDdlObjectKind): string {
	return KIND_FOLDER_CANDIDATES[kind][0];
}

export function getGitRepositoryPath(): string {
	return String(
		vscode.workspace.getConfiguration('pgsql-tools').get<string>('gitRepositoryPath') ?? ''
	).trim();
}

export async function setGitRepositoryPath(folderPath: string): Promise<void> {
	const cfg = vscode.workspace.getConfiguration('pgsql-tools');
	const target = vscode.workspace.workspaceFolders?.length
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
	await cfg.update('gitRepositoryPath', folderPath, target);
}

export function resolveGitFolderForKind(root: string, kind: GitDdlObjectKind): string {
	return path.join(root, getPreferredGitFolder(kind));
}

export async function resolveExistingGitFolderForKind(
	root: string,
	kind: GitDdlObjectKind
): Promise<string> {
	for (const folder of getKindFolderCandidates(kind)) {
		const full = path.join(root, folder);
		try {
			const st = await fs.promises.stat(full);
			if (st.isDirectory()) {
				return full;
			}
		} catch {
			// try next candidate
		}
	}
	return resolveGitFolderForKind(root, kind);
}

export function resolveGitFilePath(root: string, kind: GitDdlObjectKind, objectName: string): string {
	const base = resolveGitFolderForKind(root, kind);
	const fileName = objectName.endsWith('.sql') ? objectName : `${objectName}.sql`;
	return path.join(base, fileName);
}
