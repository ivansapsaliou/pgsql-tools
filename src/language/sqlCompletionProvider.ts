import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import {
	computeSqlCompletions,
	dtoToCompletionItem,
	isIntelliSenseEnabled,
} from './sqlCompletionService';

export class SQLCompletionProvider implements vscode.CompletionItemProvider {
	constructor(
		private registry: SqlSchemaRegistry,
		_connectionManager: ConnectionManager
	) {}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		_context: vscode.CompletionContext
	): Promise<vscode.CompletionItem[] | vscode.CompletionList> {
		if (!isIntelliSenseEnabled()) {
			return [];
		}

		const offset = document.offsetAt(position);
		const result = await computeSqlCompletions(this.registry, document.getText(), offset);
		const items = result.items.map((dto) => dtoToCompletionItem(dto, document, offset));
		return new vscode.CompletionList(items, result.isIncomplete);
	}

	async refresh(): Promise<void> {
		this.registry.clear();
		await this.registry.refresh();
	}
}
