import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import type { GitDdlObjectKind } from '../database/queryExecutor';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import { getObjectRefAtPosition } from './sqlObjectScanner';

export interface SqlObjectNavigationHandlers {
	showTableDetails: (
		schema: string,
		objectName: string,
		objectType: 'table' | 'view'
	) => Promise<void>;
	openRoutineDdl: (
		connectionName: string,
		schema: string,
		objectName: string,
		objectType: Extract<GitDdlObjectKind, 'function' | 'procedure'>
	) => Promise<void>;
}

export class SqlObjectDefinitionProvider implements vscode.DefinitionProvider {
	constructor(
		private registry: SqlSchemaRegistry,
		private connectionManager: ConnectionManager,
		private handlers: SqlObjectNavigationHandlers
	) {}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken
	): Promise<vscode.Definition | vscode.LocationLink[] | null> {
		if (document.uri.scheme === 'pgsql-tools-git') {
			return null;
		}

		await this.registry.ensureFresh();
		const ref = getObjectRefAtPosition(document, position, this.registry);
		if (!ref || ref.kind === 'column') {
			return null;
		}

		const connectionName = this.connectionManager.getActiveConnectionName();
		if (!connectionName) {
			void vscode.window.showWarningMessage(
				'Нет активного подключения PostgreSQL.'
			);
			return null;
		}

		if (ref.kind === 'function' || ref.kind === 'procedure') {
			await this.handlers.openRoutineDdl(
				connectionName,
				ref.schema,
				ref.name,
				ref.kind
			);
			return null;
		}

		if (ref.kind === 'table' || ref.kind === 'view') {
			await this.handlers.showTableDetails(ref.schema, ref.name, ref.kind);
			return null;
		}

		return null;
	}
}
