import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionManager } from '../database/connectionManager';
import type { QueryExecutor } from '../database/queryExecutor';
import type { GitDdlObjectKind } from '../database/queryExecutor';
import { DebugBreakpointStore, type BreakpointKey } from '../debug/debugBreakpoints';
import {
	classifyParameterType,
	parameterInfoToFormField,
	toSqlLiteral,
	validateParameterValue,
} from '../debug/parameterTypes';
import type { DebugSessionState, DebugSessionTarget } from '../debug/debugSession';
import type { InstrumentMode } from '../debug/plpgsqlInstrumenter';
import {
	filterInputParameters,
	parametersFromDdl,
} from '../debug/routineParameters';

export interface DebugSidebarParameterField {
	name: string;
	mode: string;
	dataType: string;
	widgetKind: string;
	value: string;
	error?: string;
}

export interface DebugSidebarBreakpointItem {
	line: number;
	preview: string;
}

export interface DebugSidebarSession {
	target: DebugSessionTarget;
	specificName: string;
	oid?: number;
	breakpointKey: BreakpointKey;
	ddlUri?: string;
}

export type DebugSidebarRunHandler = (
	target: DebugSessionTarget,
	options: { mode: InstrumentMode; argAssignments: string[]; specificName: string }
) => Promise<void>;

export class PlpgsqlDebugSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'pgsqlPlpgsqlDebugSidebar';

	private _view?: vscode.WebviewView;
	private session: DebugSidebarSession | null = null;
	private paramValues = new Map<string, string>();
	private mode: InstrumentMode = 'trace';
	private onRun?: DebugSidebarRunHandler;
	private onGoToLine?: (line: number) => void;
	private onToggleBreakpoint?: () => void;
	private onRemoveBreakpoint?: (line: number) => void;
	private onContinue?: () => void;
	private onStop?: () => void;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		private readonly queryExecutor: QueryExecutor,
		private readonly breakpoints: DebugBreakpointStore
	) {}

	setHandlers(handlers: {
		onRun: DebugSidebarRunHandler;
		onGoToLine: (line: number) => void;
		onToggleBreakpoint: () => void;
		onRemoveBreakpoint: (line: number) => void;
		onContinue: () => void;
		onStop: () => void;
	}): void {
		this.onRun = handlers.onRun;
		this.onGoToLine = handlers.onGoToLine;
		this.onToggleBreakpoint = handlers.onToggleBreakpoint;
		this.onRemoveBreakpoint = handlers.onRemoveBreakpoint;
		this.onContinue = handlers.onContinue;
		this.onStop = handlers.onStop;
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.command) {
				case 'ready':
					this.postInit();
					break;
				case 'paramChange':
					if (msg.name) {
						this.paramValues.set(String(msg.name), String(msg.value ?? ''));
					}
					break;
				case 'setMode':
					this.mode = msg.mode === 'breakpoints_only' ? 'breakpoints_only' : 'trace';
					break;
				case 'run':
					if (msg.paramValues && typeof msg.paramValues === 'object') {
						for (const [name, value] of Object.entries(
							msg.paramValues as Record<string, string>
						)) {
							this.paramValues.set(name, String(value ?? ''));
						}
					}
					await this.handleRun();
					break;
				case 'continue':
					this.onContinue?.();
					break;
				case 'stop':
					this.onStop?.();
					break;
				case 'goToLine':
					if (typeof msg.line === 'number') {
						this.onGoToLine?.(msg.line);
					}
					break;
				case 'toggleBreakpointCurrent':
					this.onToggleBreakpoint?.();
					this.refreshBreakpoints();
					break;
				case 'showHelp':
					void vscode.window.showInformationMessage('PL/pgSQL Debug', {
						detail:
							'1. Заполните параметры и выберите режим Trace или Breakpoints only.\n' +
							'2. Точки останова: в редакторе DDL — Shift+F9 или кнопка в панели.\n' +
							'3. Нажмите «Запустить» — трассировка в нижней панели, номера строк совпадают с DDL.',
						modal: true,
					});
					break;
				case 'removeBreakpoint':
					if (this.session && typeof msg.line === 'number') {
						this.breakpoints.toggle(this.session.breakpointKey, msg.line);
						this.onRemoveBreakpoint?.(msg.line);
						this.refreshBreakpoints();
					}
					break;
			}
		});
	}

	async focus(): Promise<void> {
		await vscode.commands.executeCommand('pgsqlPlpgsqlDebugSidebar.focus');
	}

	async loadRoutine(
		target: DebugSessionTarget,
		specificName: string,
		ddlUri?: vscode.Uri
	): Promise<void> {
		const client = this.connectionManager.getConnectionByName(target.connectionName);
		if (!client) {
			vscode.window.showWarningMessage('Подключение не активно');
			return;
		}

		const { inputs, oid } = await this.fetchInputParameters(client, target, specificName);

		this.paramValues.clear();
		for (const p of inputs) {
			if (!this.paramValues.has(p.name)) {
				this.paramValues.set(p.name, '');
			}
		}

		this.session = {
			target,
			specificName,
			oid,
			breakpointKey: {
				connectionName: target.connectionName,
				schema: target.schema,
				specificName,
			},
			ddlUri: ddlUri?.toString(),
		};

		await this.focus();
		this.postInit(inputs);
	}

	setStatus(status: DebugSessionState): void {
		this._view?.webview.postMessage({ command: 'setStatus', status });
	}

	refreshBreakpoints(): void {
		if (!this.session) {
			return;
		}
		const lines = [...this.breakpoints.getLinesFor(this.session.breakpointKey)].sort(
			(a, b) => a - b
		);
		const items: DebugSidebarBreakpointItem[] = lines.map((line) => ({
			line,
			preview: this.getLinePreview(line),
		}));
		this._view?.webview.postMessage({ command: 'setBreakpoints', breakpoints: items });
	}

	private getLinePreview(line: number): string {
		if (!this.session?.ddlUri) {
			return '';
		}
		const doc = vscode.workspace.textDocuments.find(
			(d) => d.uri.toString() === this.session!.ddlUri
		);
		if (!doc || line < 1 || line > doc.lineCount) {
			return '';
		}
		return doc.lineAt(line - 1).text.trim().slice(0, 80);
	}

	private async handleRun(): Promise<void> {
		if (!this.session || !this.onRun) {
			return;
		}

		const client = this.connectionManager.getConnectionByName(this.session.target.connectionName);
		if (!client) {
			vscode.window.showErrorMessage('Подключение не активно');
			return;
		}

		const { inputs } = await this.fetchInputParameters(
			client,
			this.session.target,
			this.session.specificName
		);

		const errors: { name: string; error: string }[] = [];
		const argAssignments: string[] = [];

		for (const p of inputs) {
			const classified = classifyParameterType(p);
			const raw = this.paramValues.get(p.name) ?? '';
			const validation = validateParameterValue(raw, classified, true);
			if (!validation.valid) {
				errors.push({ name: p.name, error: validation.error || 'Ошибка' });
				continue;
			}
			argAssignments.push(toSqlLiteral(raw, classified));
		}

		if (errors.length > 0) {
			this._view?.webview.postMessage({ command: 'setParamErrors', errors });
			return;
		}

		this._view?.webview.postMessage({ command: 'clearParamErrors' });

		if (this.mode === 'breakpoints_only') {
			const bp = this.breakpoints.getLinesFor(this.session.breakpointKey);
			if (bp.size === 0) {
				vscode.window.showWarningMessage(
					'Добавьте хотя бы одну точку останова (Shift+F9) или выберите режим Trace'
				);
				return;
			}
		}

		await this.onRun(this.session.target, {
			mode: this.mode,
			argAssignments,
			specificName: this.session.specificName,
		});
	}

	private async fetchInputParameters(
		client: import('pg').Client,
		target: DebugSessionTarget,
		specificName: string
	): Promise<{
		inputs: import('../database/queryExecutor').RoutineParameterInfo[];
		oid?: number;
	}> {
		const resolved = await this.queryExecutor.resolveRoutineOnClient(
			client,
			target.schema,
			target.routineName,
			target.kind,
			specificName
		);
		const routine = resolved.find((r) => r.specificName === specificName) ?? resolved[0];
		if (!routine) {
			return { inputs: [] };
		}

		let inputs: import('../database/queryExecutor').RoutineParameterInfo[] = [];
		try {
			inputs = parametersFromDdl(routine.ddl);
		} catch {
			/* DDL не разобрался — резерв из каталога */
		}

		if (inputs.length === 0) {
			const params = await this.queryExecutor.getRoutineParametersOnClient(
				client,
				target.schema,
				specificName,
				routine.oid
			);
			inputs = filterInputParameters(params);
		}

		return { inputs, oid: routine.oid };
	}

	private postInit(params?: import('../database/queryExecutor').RoutineParameterInfo[]): void {
		if (!this.session) {
			return;
		}
		const t = this.session.target;
		const title = `${t.schema}.${t.routineName}`;
		const meta = `${t.kind} · ${t.connectionName}`;

		let parameters: DebugSidebarParameterField[] = [];
		if (params) {
			parameters = params.map((p) => {
					const f = parameterInfoToFormField(p);
					return {
						name: f.name,
						mode: f.mode,
						dataType: f.dataType,
						widgetKind: f.classified.kind,
						value: this.paramValues.get(p.name) ?? '',
					};
				});
		}

		const lines = [...this.breakpoints.getLinesFor(this.session.breakpointKey)].sort(
			(a, b) => a - b
		);
		const breakpoints: DebugSidebarBreakpointItem[] = lines.map((line) => ({
			line,
			preview: this.getLinePreview(line),
		}));

		this._view?.webview.postMessage({
			command: 'init',
			title,
			meta,
			parameters,
			breakpoints,
			mode: this.mode,
			status: 'ready',
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const htmlPath = path.join(this.extensionUri.fsPath, 'resources', 'debug', 'sidebar.html');
		const cssUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'resources', 'debug', 'sidebar.css')
		);
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'resources', 'debug', 'sidebar.js')
		);
		let html = fs.readFileSync(htmlPath, 'utf8');
		html = html
			.replace(/\{\{cspSource\}\}/g, webview.cspSource)
			.replace(/\{\{styleUri\}\}/g, cssUri.toString())
			.replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
		return html;
	}
}
