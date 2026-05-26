import * as vscode from 'vscode';
import type { GitDdlObjectKind } from '../database/queryExecutor';

const SCHEME = 'pgsql-tools-git';

export function buildGitDdlUri(
	connectionName: string,
	schema: string,
	kind: GitDdlObjectKind,
	objectName: string
): vscode.Uri {
	const path = `${encodeURIComponent(connectionName)}/${encodeURIComponent(schema)}/${kind}/${encodeURIComponent(objectName)}.sql`;
	return vscode.Uri.parse(`${SCHEME}:/${path}`);
}

export function parseGitDdlUri(uri: vscode.Uri): {
	connectionName: string;
	schema: string;
	kind: GitDdlObjectKind;
	objectName: string;
} | undefined {
	if (uri.scheme !== SCHEME) {
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
	const objectName = decodeURIComponent(parts[3].replace(/\.sql$/i, ''));
	return {
		connectionName: decodeURIComponent(parts[0]),
		schema: decodeURIComponent(parts[1]),
		kind,
		objectName,
	};
}

export class GitDdlDocumentProvider implements vscode.TextDocumentContentProvider {
	private content = new Map<string, string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	setContent(uri: vscode.Uri, text: string): void {
		this.content.set(uri.toString(), text);
		this.onDidChangeEmitter.fire(uri);
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return this.content.get(uri.toString()) ?? '';
	}

	register(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.workspace.registerTextDocumentContentProvider(SCHEME, this)
		);
	}
}
