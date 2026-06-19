import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import type { GitDdlObjectKind } from '../database/queryExecutor';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import { getObjectRefAtPosition, type SqlObjectRef } from './sqlObjectScanner';

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

export type SqlObjectLinkTarget = {
	schema: string;
	name: string;
	kind: Exclude<SqlObjectRef['kind'], 'column'>;
};

export function buildSqlObjectLinkCommandUri(target: SqlObjectLinkTarget): vscode.Uri {
	return vscode.Uri.parse(
		`command:pgsql-tools.openSqlObjectFromLink?${encodeURIComponent(JSON.stringify([target]))}`
	);
}

export async function navigateToSqlObject(
	target: SqlObjectLinkTarget,
	registry: SqlSchemaRegistry,
	connectionManager: ConnectionManager,
	handlers: SqlObjectNavigationHandlers
): Promise<void> {
	await registry.ensureFresh();

	const connectionName = connectionManager.getActiveConnectionName();
	if (!connectionName) {
		void vscode.window.showWarningMessage('Нет активного подключения PostgreSQL.');
		return;
	}

	if (target.kind === 'function' || target.kind === 'procedure') {
		await handlers.openRoutineDdl(
			connectionName,
			target.schema,
			target.name,
			target.kind
		);
		return;
	}

	if (target.kind === 'table' || target.kind === 'view') {
		await handlers.showTableDetails(target.schema, target.name, target.kind);
	}
}

export async function navigateToSqlObjectAtPosition(
	document: vscode.TextDocument,
	position: vscode.Position,
	registry: SqlSchemaRegistry,
	connectionManager: ConnectionManager,
	handlers: SqlObjectNavigationHandlers
): Promise<void> {
	if (document.uri.scheme === 'pgsql-tools-git') {
		return;
	}

	const ref = getObjectRefAtPosition(document, position, registry);
	if (!ref || ref.kind === 'column') {
		return;
	}

	await navigateToSqlObject(
		{ schema: ref.schema, name: ref.name, kind: ref.kind },
		registry,
		connectionManager,
		handlers
	);
}
