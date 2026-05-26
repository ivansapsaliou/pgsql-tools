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
	missing_in_git: {
		badge: '!',
		color: 'gitDecoration.deletedResourceForeground',
		tooltip: 'Нет файла в Git',
	},
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

	private uriStatus = new Map<string, GitSyncStatus>();
	private uriTooltip = new Map<string, string>();

	setUriStatuses(
		entries: Array<{ uri: vscode.Uri; status: GitSyncStatus; tooltip?: string }>
	): void {
		const changed = new Set<string>([...this.uriStatus.keys(), ...entries.map((e) => e.uri.toString())]);
		this.uriStatus.clear();
		this.uriTooltip.clear();
		for (const e of entries) {
			const key = e.uri.toString();
			this.uriStatus.set(key, e.status);
			if (e.tooltip) {
				this.uriTooltip.set(key, e.tooltip);
			}
		}
		const uris = [...changed].map((k) => vscode.Uri.parse(k));
		if (uris.length > 0) {
			this.onDidChangeEmitter.fire(uris);
		}
	}

	clear(): void {
		const uris = [...this.uriStatus.keys()].map((k) => vscode.Uri.parse(k));
		this.uriStatus.clear();
		this.uriTooltip.clear();
		if (uris.length > 0) {
			this.onDidChangeEmitter.fire(uris);
		}
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		const status = this.uriStatus.get(uri.toString());
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
			tooltip: this.uriTooltip.get(uri.toString()) ?? spec.tooltip,
		};
	}

	register(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.window.registerFileDecorationProvider(this),
			this.onDidChangeEmitter
		);
	}
}
