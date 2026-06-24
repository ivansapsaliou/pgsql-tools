import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CommandLogSettings } from './commandLogSettings';

const MAX_OPEN_BYTES = 2 * 1024 * 1024;

function sanitizeConnectionName(name: string): string {
	return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'connection';
}

function formatDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

/** True when SQL (after leading comments/whitespace) is a read query. */
export function isSelectLikeQuery(query: string): boolean {
	let sql = query.trim();
	for (let guard = 0; guard < 50 && sql.length > 0; guard++) {
		if (sql.startsWith('--')) {
			const nl = sql.indexOf('\n');
			sql = (nl === -1 ? '' : sql.slice(nl + 1)).trimStart();
			continue;
		}
		if (sql.startsWith('/*')) {
			const end = sql.indexOf('*/');
			sql = (end === -1 ? '' : sql.slice(end + 2)).trimStart();
			continue;
		}
		break;
	}
	return /^(SELECT|WITH)\b/i.test(sql);
}

export class CommandLogService {
	constructor(private settings: CommandLogSettings) {}

	sanitizeConnectionName(name: string): string {
		return sanitizeConnectionName(name);
	}

	getLogFilePath(connectionName: string, date = new Date()): string | undefined {
		const root = this.settings.getDirectory();
		if (!root) {
			return undefined;
		}
		return path.join(
			root,
			sanitizeConnectionName(connectionName),
			`${formatDate(date)}.log`
		);
	}

	async listLogDates(connectionName: string): Promise<string[]> {
		const root = this.settings.getDirectory();
		if (!root) {
			return [];
		}
		const dir = path.join(root, sanitizeConnectionName(connectionName));
		try {
			const entries = await fs.promises.readdir(dir, { withFileTypes: true });
			return entries
				.filter((e) => e.isFile() && e.name.endsWith('.log'))
				.map((e) => e.name.replace(/\.log$/, ''))
				.sort((a, b) => b.localeCompare(a));
		} catch {
			return [];
		}
	}

	async logCommand(connectionName: string, commandId: string, detail?: string): Promise<void> {
		if (!this.settings.isEnabled()) {
			return;
		}
		const line = `${new Date().toISOString()} | COMMAND | ${commandId}${
			detail ? ` | ${detail}` : ''
		}\n`;
		await this.append(connectionName, line);
	}

	async logSql(
		connectionName: string,
		query: string,
		meta: { durationMs: number; rowCount?: number; error?: string }
	): Promise<void> {
		if (!this.settings.isEnabled()) {
			return;
		}
		if (!this.settings.shouldLogSelectQueries() && isSelectLikeQuery(query)) {
			return;
		}
		const parts = [`duration=${meta.durationMs}ms`];
		if (meta.rowCount !== undefined) {
			parts.push(`rows=${meta.rowCount}`);
		}
		if (meta.error) {
			parts.push(`error=${meta.error}`);
		}
		const header = `${new Date().toISOString()} | SQL | ${parts.join(' | ')}\n`;
		const body = `${query.trim()}\n---\n`;
		await this.append(connectionName, header + body);
	}

	private async append(connectionName: string, text: string): Promise<void> {
		const filePath = this.getLogFilePath(connectionName);
		if (!filePath) {
			return;
		}
		try {
			await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
			await fs.promises.appendFile(filePath, text, 'utf8');
		} catch (err) {
			console.error('pgsql-tools: command log write failed', err);
		}
	}

	async openLog(connectionName: string, dateStr?: string): Promise<void> {
		const dates = await this.listLogDates(connectionName);
		let picked = dateStr;
		if (!picked) {
			const today = formatDate(new Date());
			if (dates.includes(today)) {
				picked = today;
			} else if (dates.length === 1) {
				picked = dates[0];
			} else if (dates.length > 1) {
				const item = await vscode.window.showQuickPick(
					dates.map((d) => ({ label: d })),
					{ title: `Command log: ${connectionName}`, placeHolder: 'Select date' }
				);
				picked = item?.label;
			} else {
				picked = today;
			}
		}
		if (!picked) {
			vscode.window.showInformationMessage(`No command log found for «${connectionName}».`);
			return;
		}
		const filePath = this.getLogFilePath(
			connectionName,
			new Date(`${picked}T12:00:00`)
		);
		if (!filePath) {
			vscode.window.showWarningMessage('Command log directory is not configured.');
			return;
		}
		try {
			const stat = await fs.promises.stat(filePath);
			if (stat.size > MAX_OPEN_BYTES) {
				const open = await vscode.window.showWarningMessage(
					`Log file is large (${Math.round(stat.size / 1024 / 1024)} MB). Open anyway?`,
					'Open',
					'Cancel'
				);
				if (open !== 'Open') {
					return;
				}
			}
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
			await vscode.window.showTextDocument(doc, { preview: true });
		} catch {
			vscode.window.showInformationMessage(
				`No log file for ${connectionName} on ${picked}.`
			);
		}
	}
}
