import * as vscode from 'vscode';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import { buildSqlObjectLinkCommandUri } from './sqlObjectNavigation';
import { scanObjectRefsInDocument, type SqlObjectRef } from './sqlObjectScanner';

function isHighlightingEnabled(): boolean {
	return vscode.workspace.getConfiguration('pgsql-tools').get<boolean>('sqlObjectHighlighting', true);
}

function linkTooltip(ref: Exclude<SqlObjectRef, { kind: 'column' }>): string {
	const qualified =
		ref.schema && ref.schema !== 'public' ? `${ref.schema}.${ref.name}` : ref.name;
	switch (ref.kind) {
		case 'table':
			return `Открыть таблицу ${qualified} (Ctrl+клик)`;
		case 'view':
			return `Открыть представление ${qualified} (Ctrl+клик)`;
		case 'function':
			return `Открыть функцию ${qualified} (Ctrl+клик)`;
		case 'procedure':
			return `Открыть процедуру ${qualified} (Ctrl+клик)`;
	}
}

export class SqlObjectDocumentLinkProvider implements vscode.DocumentLinkProvider {
	private readonly onDidChangeDocumentLinksEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeDocumentLinks = this.onDidChangeDocumentLinksEmitter.event;

	constructor(private readonly registry: SqlSchemaRegistry) {
		registry.onDidRefresh(() => this.onDidChangeDocumentLinksEmitter.fire());
	}

	async provideDocumentLinks(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken
	): Promise<vscode.DocumentLink[]> {
		if (document.languageId !== 'sql' || document.uri.scheme === 'pgsql-tools-git') {
			return [];
		}
		if (!isHighlightingEnabled()) {
			return [];
		}

		await this.registry.ensureFresh();
		const refs = scanObjectRefsInDocument(document, this.registry);

		return refs
			.filter((ref): ref is Exclude<SqlObjectRef, { kind: 'column' }> => ref.kind !== 'column')
			.map((ref) => {
				const link = new vscode.DocumentLink(
					ref.range,
					buildSqlObjectLinkCommandUri({
						schema: ref.schema,
						name: ref.name,
						kind: ref.kind,
					})
				);
				link.tooltip = linkTooltip(ref);
				return link;
			});
	}
}
