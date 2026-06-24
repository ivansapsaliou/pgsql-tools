import * as vscode from 'vscode';
import { CommandLogSettings } from '../services/commandLogSettings';
import { CommandLogService } from '../services/commandLogService';
import { CommandLogSettingsWebview } from '../views/commandLogSettingsWebview';

function connectionNameFromNode(node: unknown): string | undefined {
	const n = node as { connectionName?: string; label?: string } | undefined;
	const name = n?.connectionName ?? String(n?.label ?? '').replace(/^● /, '').trim();
	return name || undefined;
}

export function registerCommandLogCommands(
	context: vscode.ExtensionContext,
	commandLogSettings: CommandLogSettings,
	commandLogService: CommandLogService
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('pgsql-tools.configureCommandLog', () => {
			CommandLogSettingsWebview.show(context, commandLogSettings);
		}),

		vscode.commands.registerCommand('pgsql-tools.viewConnectionCommandLog', async (node) => {
			const name = connectionNameFromNode(node);
			if (!name) {
				vscode.window.showWarningMessage('Select a connection in the tree.');
				return;
			}
			await commandLogService.openLog(name);
		})
	);
}
