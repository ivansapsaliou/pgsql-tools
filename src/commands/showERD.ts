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
		const disposables: vscode.Disposable[] = [];

		// ── Полная схема / выбор режима ──────────────────────────
		disposables.push(
			vscode.commands.registerCommand(
				'pgsql-tools.showERD',
				async (node?: { connectionName?: string; label?: string }) => {
					const connName = node?.connectionName ?? connectionManager.getActiveConnectionName() ?? undefined;
					await ERDPanel.show(context, queryExecutor, connectionManager, connName);
				}
			)
		);

		// ── От конкретной таблицы (из контекстного меню дерева) ──
		disposables.push(
			vscode.commands.registerCommand(
				'pgsql-tools.showERDFromTable',
				async (node?: { connectionName?: string; parentSchema?: string; parentTable?: string; label?: string }) => {
					const connName  = node?.connectionName ?? connectionManager.getActiveConnectionName() ?? undefined;
					const schema    = node?.parentSchema ?? 'public';
					const tableName = node?.parentTable  ?? node?.label ?? '';
					if (!tableName) {
						vscode.window.showErrorMessage('No table selected.');
						return;
					}
					await ERDPanel.showFromTable(
						context, queryExecutor, connectionManager,
						schema, tableName, connName
					);
				}
			)
		);

		return disposables;
	}
}