import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor } from '../database/queryExecutor';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import { SQLCompletionProvider } from './sqlCompletionProvider';
import { SQLSignatureHelpProvider } from './sqlSignatureHelpProvider';

export interface SqlIntelliSenseDeps {
	schemaRegistry: SqlSchemaRegistry;
	connectionManager: ConnectionManager;
	queryExecutor: QueryExecutor;
}

const SQL_DOCUMENT_SELECTOR: vscode.DocumentSelector = [
	{ language: 'sql', scheme: 'file' },
	{ language: 'sql', scheme: 'untitled' },
	{ language: 'sql', scheme: 'pgsql-tools-git' },
];

export function registerSqlIntelliSense(
	context: vscode.ExtensionContext,
	deps: SqlIntelliSenseDeps
): SQLCompletionProvider {
	const completionProvider = new SQLCompletionProvider(
		deps.schemaRegistry,
		deps.connectionManager
	);
	const signatureProvider = new SQLSignatureHelpProvider(deps.schemaRegistry);

	context.subscriptions.push(
		vscode.languages.registerCompletionItemProvider(
			SQL_DOCUMENT_SELECTOR,
			completionProvider,
			'.',
			' ',
			'\t',
			'(',
			'"'
		),
		vscode.languages.registerSignatureHelpProvider(
			SQL_DOCUMENT_SELECTOR,
			signatureProvider,
			'(',
			','
		),
		vscode.workspace.onDidOpenTextDocument((doc) => {
			if (doc.languageId === 'sql') {
				void deps.schemaRegistry.ensureFresh();
			}
		})
	);

	return completionProvider;
}
