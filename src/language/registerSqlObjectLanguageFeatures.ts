import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor } from '../database/queryExecutor';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import { SqlObjectHoverProvider } from './sqlObjectHoverProvider';
import { SqlObjectDocumentLinkProvider } from './sqlObjectDocumentLinkProvider';
import {
	navigateToSqlObject,
	type SqlObjectLinkTarget,
	type SqlObjectNavigationHandlers,
} from './sqlObjectNavigation';
import { registerSqlObjectUnderlineDecorations } from './sqlObjectUnderlineDecorations';

export interface SqlObjectLanguageFeatureDeps {
	schemaRegistry: SqlSchemaRegistry;
	queryExecutor: QueryExecutor;
	connectionManager: ConnectionManager;
	navigation: SqlObjectNavigationHandlers;
}

export function registerSqlObjectLanguageFeatures(
	context: vscode.ExtensionContext,
	deps: SqlObjectLanguageFeatureDeps
): void {
	const { schemaRegistry, queryExecutor, connectionManager, navigation } = deps;

	registerSqlObjectUnderlineDecorations(context, schemaRegistry);

	const documentLinkProvider = new SqlObjectDocumentLinkProvider(schemaRegistry);
	context.subscriptions.push(
		vscode.languages.registerHoverProvider(
			'sql',
			new SqlObjectHoverProvider(schemaRegistry, queryExecutor)
		),
		vscode.languages.registerDocumentLinkProvider('sql', documentLinkProvider),
		vscode.commands.registerCommand(
			'pgsql-tools.openSqlObjectFromLink',
			async (target: SqlObjectLinkTarget) => {
				await navigateToSqlObject(
					target,
					schemaRegistry,
					connectionManager,
					navigation
				);
			}
		)
	);
}
