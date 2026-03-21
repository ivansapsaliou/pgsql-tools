import * as vscode from 'vscode';
import { QueryExecutor } from '../database/queryExecutor';
import { ConnectionManager } from '../database/connectionManager';
import { DatabaseHealthPanel } from '../views/databaseHealthPanel';

export class HealthCommands {
	static registerAll(
		queryExecutor: QueryExecutor,
		connectionManager: ConnectionManager,
		context: vscode.ExtensionContext
	): vscode.Disposable[] {
		return [
			// Main health panel command
			vscode.commands.registerCommand('pgsql-tools.showHealth', async (node?: { label?: string }) => {
				const connName = node?.label || connectionManager.getActiveConnectionName() || undefined;
				await DatabaseHealthPanel.show(context, queryExecutor, connectionManager, connName);
			}),

			// Legacy shortcut commands (redirect to the panel)
			vscode.commands.registerCommand('pgsql-tools.healthSlowQueries', async () => {
				await DatabaseHealthPanel.show(context, queryExecutor, connectionManager);
			}),
			vscode.commands.registerCommand('pgsql-tools.healthLocks', async () => {
				await DatabaseHealthPanel.show(context, queryExecutor, connectionManager);
			}),
			vscode.commands.registerCommand('pgsql-tools.healthSizes', async () => {
				await DatabaseHealthPanel.show(context, queryExecutor, connectionManager);
			}),
			vscode.commands.registerCommand('pgsql-tools.healthVacuum', async () => {
				await DatabaseHealthPanel.show(context, queryExecutor, connectionManager);
			}),
		];
	}
}