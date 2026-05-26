import * as vscode from 'vscode';
import type { GitDdlObjectKind } from '../database/queryExecutor';
import type { GitObjectRef } from './gitStatusCache';

export const GIT_STATUS_TREE_SCHEME = 'pgsql-tools-git-status';

export function buildGitStatusTreeUri(ref: GitObjectRef): vscode.Uri {
	const path = [
		encodeURIComponent(ref.connectionName),
		encodeURIComponent(ref.schema),
		ref.kind,
		encodeURIComponent(ref.objectName),
	].join('/');
	return vscode.Uri.parse(`${GIT_STATUS_TREE_SCHEME}:/${path}`);
}

export function parseGitStatusTreeUri(uri: vscode.Uri): GitObjectRef | undefined {
	if (uri.scheme !== GIT_STATUS_TREE_SCHEME) {
		return undefined;
	}
	const parts = uri.path.replace(/^\//, '').split('/');
	if (parts.length < 4) {
		return undefined;
	}
	const kind = parts[2] as GitDdlObjectKind;
	if (kind !== 'table' && kind !== 'function' && kind !== 'procedure') {
		return undefined;
	}
	return {
		connectionName: decodeURIComponent(parts[0]),
		schema: decodeURIComponent(parts[1]),
		kind,
		objectName: decodeURIComponent(parts.slice(3).join('/')),
	};
}

export function parseCacheKey(key: string): GitObjectRef | undefined {
	const match = key.match(/^([^:]+):([^:]+):(table|function|procedure):([\s\S]+)$/);
	if (!match) {
		return undefined;
	}
	return {
		connectionName: match[1],
		schema: match[2],
		kind: match[3] as GitDdlObjectKind,
		objectName: match[4],
	};
}
