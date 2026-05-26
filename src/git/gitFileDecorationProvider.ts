import * as vscode from 'vscode';
import type { GitSyncStatus } from './gitStatusCache';

const BADGE: Record<GitSyncStatus, { badge: string; color: string; tooltip: string } | undefined> = {
	in_sync: {
		badge: '✓',
		color: 'testing.iconPassed',
		tooltip: 'DDL совпадает с Git',
	},
	diff: {
		badge: '≠',
		color: 'gitDecoration.modifiedResourceForeground',
		tooltip: 'DDL отличается от Git',
	},
	missing_in_git: undefined,
	pending: {
		badge: '…',
		color: 'progressBar.background',
		tooltip: 'Сравнение с Git…',
	},
	error: {
		badge: '!',
		color: 'errorForeground',
		tooltip: 'Ошибка сравнения с Git',
	},
};

export class GitDdlFileDecorationProvider implements vscode.FileDecorationProvider {
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri[]>();
	readonly onDidChangeFileDecorations = this.onDidChangeEmitter.event;

	private pathStatus = new Map<string, GitSyncStatus>();
	private pathTooltip = new Map<string, string>();

	setPathStatuses(entries: Array<{ filePath: string; status: GitSyncStatus; tooltip?: string }>): void {
		const changed = new Set<string>([...this.pathStatus.keys(), ...entries.map((e) => e.filePath)]);
		this.pathStatus.clear();
		this.pathTooltip.clear();
		for (const e of entries) {
			this.pathStatus.set(e.filePath, e.status);
			if (e.tooltip) {
				this.pathTooltip.set(e.filePath, e.tooltip);
			}
		}
		const uris = [...changed].map((p) => vscode.Uri.file(p));
		if (uris.length > 0) {
			this.onDidChangeEmitter.fire(uris);
		}
	}

	clear(): void {
		const uris = [...this.pathStatus.keys()].map((p) => vscode.Uri.file(p));
		this.pathStatus.clear();
		this.pathTooltip.clear();
		if (uris.length > 0) {
			this.onDidChangeEmitter.fire(uris);
		}
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		const status = this.pathStatus.get(uri.fsPath);
		if (!status) {
			return undefined;
		}
		const spec = BADGE[status];
		if (!spec) {
			return undefined;
		}
		return {
			badge: spec.badge,
			color: new vscode.ThemeColor(spec.color),
			tooltip: this.pathTooltip.get(uri.fsPath) ?? spec.tooltip,
		};
	}

	register(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.window.registerFileDecorationProvider(this),
			this.onDidChangeEmitter
		);
	}
}
