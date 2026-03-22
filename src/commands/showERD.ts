import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { ERDPanel } from '../views/erdPanel';

export class ShowERDCommand {
	static register(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		context: vscode.ExtensionContext
	) {
		return vscode.commands.registerCommand('pgsql-tools.showERD', async (node?: { connectionName?: string; label?: string }) => {
			const connName = node?.connectionName ?? connectionManager.getActiveConnectionName() ?? undefined;
			await ERDPanel.show(context, queryExecutor, connectionManager, connName);
		});
	}
}