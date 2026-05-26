import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor } from '../database/queryExecutor';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import { SqlObjectHoverProvider } from './sqlObjectHoverProvider';
import { SqlObjectDefinitionProvider, type SqlObjectNavigationHandlers } from './sqlObjectDefinitionProvider';
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
	context.subscriptions.push(
		vscode.languages.registerHoverProvider(
			'sql',
			new SqlObjectHoverProvider(schemaRegistry, queryExecutor)
		),
		vscode.languages.registerDefinitionProvider(
			'sql',
			new SqlObjectDefinitionProvider(schemaRegistry, connectionManager, navigation)
		)
	);
}
