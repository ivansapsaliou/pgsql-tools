import * as vscode from 'vscode';
import type { ConnectionManager } from '../database/connectionManager';
import type { QueryExecutor } from '../database/queryExecutor';
import type { GitDdlObjectKind } from '../database/queryExecutor';
import { DebugBreakpointStore } from '../debug/debugBreakpoints';
import { DebugControlConnection } from '../debug/debugConnection';
import {
	PlpgsqlDebugSession,
	type DebugSessionTarget,
	type DebugSessionOptions,
} from '../debug/debugSession';
import { getRoutineDebugMetadata, setRoutineDebugMetadata } from '../debug/debugMetadata';
import type { PlpgsqlDebugViewProvider } from '../views/plpgsqlDebugPanel';
import type { PlpgsqlDebugSidebarProvider } from '../views/plpgsqlDebugSidebar';
import type { TreeNode } from '../providers/treeDataProvider';
import type { InstrumentMode } from '../debug/plpgsqlInstrumenter';

export type OpenRoutineDdlFn = (
	connectionName: string,
	schema: string,
	objectName: string,
	objectType: GitDdlObjectKind,
	specificName?: string
) => Promise<void>;

export class PlpgsqlDebugCommands {
	private session: PlpgsqlDebugSession | null = null;
	readonly breakpoints: DebugBreakpointStore;
	private readonly control: DebugControlConnection;
	private breakpointDecorationType: vscode.TextEditorDecorationType;
	private currentLineDecorationType: vscode.TextEditorDecorationType;
	private openRoutineDdl: OpenRoutineDdlFn = async () => {};

	constructor(
		_context: vscode.ExtensionContext,
		private readonly connectionManager: ConnectionManager,
		private readonly queryExecutor: QueryExecutor,
		private readonly debugPanel: PlpgsqlDebugViewProvider,
		private readonly debugSidebar: PlpgsqlDebugSidebarProvider,
		breakpointStore: DebugBreakpointStore
	) {
		this.breakpoints = breakpointStore;
		this.control = new DebugControlConnection(connectionManager);
		this.breakpointDecorationType = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			gutterIconPath: this.getGutterIconUri(),
			gutterIconSize: 'contain',
		});
		this.currentLineDecorationType = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
			borderWidth: '0 0 0 2px',
			borderStyle: 'solid',
			borderColor: new vscode.ThemeColor('debugIcon.pauseForeground'),
		});
		_context.subscriptions.push(this.breakpointDecorationType, this.currentLineDecorationType);

		this.debugSidebar.setHandlers({
			onRun: (target, opts) => this.runSession(target, opts),
			onGoToLine: (line) => this.goToLineInRoutineEditor(line),
			onToggleBreakpoint: () => this.toggleBreakpoint(),
			onRemoveBreakpoint: () => this.debugSidebar.refreshBreakpoints(),
			onContinue: () => this.continue(),
			onStop: () => this.stop(),
		});
	}

	setOpenRoutineDdl(fn: OpenRoutineDdlFn): void {
		this.openRoutineDdl = fn;
	}

	register(): vscode.Disposable[] {
		return [
			vscode.commands.registerCommand('pgsql-tools.debugRoutine', (node?: TreeNode) => {
				if (
					node &&
					(node.contextValue === 'function' ||
						node.contextValue === 'procedure' ||
						(node.contextValue && /^(function|procedure)\+git-/.test(node.contextValue)))
				) {
					return this.openDebugFromTreeNode(node);
				}
				return this.openDebugFromEditor();
			}),
			vscode.commands.registerCommand('pgsql-tools.openDebugSidebar', () =>
				this.debugSidebar.focus()
			),
			vscode.commands.registerCommand('pgsql-tools.debugContinue', () => this.continue()),
			vscode.commands.registerCommand('pgsql-tools.debugStop', () => this.stop()),
			vscode.commands.registerCommand('pgsql-tools.toggleDebugBreakpoint', () =>
				this.toggleBreakpoint()
			),
			vscode.commands.registerCommand('pgsql-tools.debugGoToLine', (line: number) =>
				this.goToLineInRoutineEditor(line)
			),
			vscode.window.onDidChangeTextEditorSelection((e) =>
				this.updateBreakpointDecorations(e.textEditor)
			),
			vscode.workspace.onDidOpenTextDocument(() => this.updateAllBreakpointDecorations()),
		];
	}

	async openDebugFromTreeNode(node: TreeNode): Promise<void> {
		const schema = node.parentSchema || 'public';
		const name = node.parentTable || String(node.label);
		const kind: GitDdlObjectKind =
			node.contextValue === 'procedure' ? 'procedure' : 'function';
		const connectionName = node.connectionName ?? this.connectionManager.getActiveConnectionName();
		if (!connectionName) {
			vscode.window.showWarningMessage('Нет активного подключения');
			return;
		}
		const specificName = node.meta?.specificName as string | undefined;
		await this.openDebugWorkspace(
			{
				connectionName,
				schema,
				routineName: name,
				kind,
				specificName,
			},
			specificName
		);
	}

	private async openDebugFromEditor(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const meta = editor ? getRoutineDebugMetadata(editor.document.uri) : undefined;
		if (!meta) {
			vscode.window.showInformationMessage(
				'Откройте DDL функции/процедуры из дерева PostgreSQL Tools или выберите объект в дереве.'
			);
			return;
		}
		await this.openDebugWorkspace(
			{
				connectionName: meta.connectionName,
				schema: meta.schema,
				routineName: meta.objectName,
				kind: meta.objectType,
				specificName: meta.specificName,
			},
			meta.specificName,
			editor!.document.uri
		);
	}

	private async openDebugWorkspace(
		target: DebugSessionTarget,
		knownSpecificName?: string,
		existingUri?: vscode.Uri
	): Promise<void> {
		if (!existingUri) {
			await this.openRoutineDdl(
				target.connectionName,
				target.schema,
				target.routineName,
				target.kind,
				knownSpecificName
			);
		}

		const client = this.connectionManager.getConnectionByName(target.connectionName);
		if (!client) {
			vscode.window.showWarningMessage('Подключение не активно');
			return;
		}

		let specificName = knownSpecificName;
		if (!specificName) {
			const resolved = await this.queryExecutor.resolveRoutineOnClient(
				client,
				target.schema,
				target.routineName,
				target.kind
			);
			if (resolved.length === 0) {
				vscode.window.showErrorMessage('Routine не найден');
				return;
			}
			if (resolved.length > 1) {
				const pick = await vscode.window.showQuickPick(
					resolved.map((r) => ({
						label: r.specificName,
						description: `oid ${r.oid}`,
						value: r.specificName,
					})),
					{ title: 'Выберите перегрузку для отладки' }
				);
				if (!pick) {
					return;
				}
				specificName = pick.value;
			} else {
				specificName = resolved[0].specificName;
			}
		}

		const ddlUri =
			existingUri ??
			vscode.window.activeTextEditor?.document.uri ??
			vscode.workspace.textDocuments.find((d) => {
				const m = getRoutineDebugMetadata(d.uri);
				return (
					m?.connectionName === target.connectionName &&
					m.schema === target.schema &&
					m.objectName === target.routineName
				);
			})?.uri;

		await this.debugSidebar.loadRoutine(target, specificName, ddlUri);
		await vscode.commands.executeCommand('workbench.view.extension.pgsql-tools-debug');
	}

	private async runSession(
		target: DebugSessionTarget,
		options: { mode: InstrumentMode; argAssignments: string[]; specificName: string }
	): Promise<void> {
		await this.debugPanel.focus();
		this.debugPanel.clear();
		this.debugPanel.setSessionLabel(`${target.schema}.${target.routineName}`);

		if (this.session) {
			await this.session.stop();
		}
		this.session = new PlpgsqlDebugSession(
			this.connectionManager,
			this.queryExecutor,
			this.control,
			this.breakpoints,
			{
				onStateChange: (s) => {
					this.debugPanel.setState(s);
					this.debugSidebar.setStatus(s);
					if (s === 'completed' || s === 'stopped' || s === 'error') {
						this.clearCurrentLineHighlight();
					}
				},
				onPrepared: (varNames) => {
					this.debugPanel.initTraceVariables(varNames);
				},
				onTrace: (ev) => {
					this.debugPanel.addTrace(ev);
					if (ev.line > 0) {
						if (ev.type === 'pause') {
							this.highlightLine(ev.line);
						}
					}
				},
				onError: (msg) => {
					void vscode.window
						.showErrorMessage(`Отладка: ${msg}`, 'Показать SQL')
						.then((choice) => {
							if (choice === 'Показать SQL' && this.session?.getLastDebugSql()) {
								const doc = vscode.workspace.openTextDocument({
									content: this.session.getLastDebugSql()!,
									language: 'sql',
								});
								void doc.then((d) =>
									vscode.window.showTextDocument(d, { preview: true })
								);
							}
						});
				},
			}
		);

		const sessionOptions: DebugSessionOptions = {
			mode: options.mode,
			argAssignments: options.argAssignments,
			specificName: options.specificName,
		};

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Отладка ${target.schema}.${target.routineName}`,
				cancellable: true,
			},
			async (_progress, token) => {
				token.onCancellationRequested(() => {
					void this.session?.stop();
				});
				await this.session!.start(target, sessionOptions);
			}
		);
	}

	private async continue(): Promise<void> {
		await this.session?.continue();
		this.clearCurrentLineHighlight();
	}

	private async stop(): Promise<void> {
		await this.session?.stop();
		this.clearCurrentLineHighlight();
	}

	toggleBreakpoint(): void {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const meta = getRoutineDebugMetadata(editor.document.uri);
		if (!meta) {
			vscode.window.showWarningMessage(
				'Breakpoints: откройте DDL функции/процедуры из PostgreSQL Tools (Shift+F9)'
			);
			return;
		}
		const line = editor.selection.active.line + 1;
		const key = {
			connectionName: meta.connectionName,
			schema: meta.schema,
			specificName: meta.specificName,
		};
		const enabled = this.breakpoints.toggle(key, line);
		this.updateBreakpointDecorations(editor);
		this.debugSidebar.refreshBreakpoints();
		vscode.window.setStatusBarMessage(
			enabled ? `Breakpoint на строке ${line} (DDL)` : `Breakpoint снят: строка ${line}`,
			2500
		);
	}

	goToLineInRoutineEditor(line: number): void {
		const editor =
			vscode.window.activeTextEditor &&
			getRoutineDebugMetadata(vscode.window.activeTextEditor.document.uri)
				? vscode.window.activeTextEditor
				: vscode.window.visibleTextEditors.find((e) =>
						getRoutineDebugMetadata(e.document.uri)
					);

		if (!editor || line < 1) {
			return;
		}
		const range = new vscode.Range(line - 1, 0, line - 1, 0);
		void vscode.window.showTextDocument(editor.document, {
			viewColumn: editor.viewColumn,
			preserveFocus: false,
		});
		editor.selection = new vscode.Selection(range.start, range.start);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
		if (this.session?.getPausedLine() === line) {
			this.highlightLine(line);
		}
	}

	attachRoutineMetadata(
		uri: vscode.Uri,
		meta: {
			connectionName: string;
			schema: string;
			objectName: string;
			objectType: 'function' | 'procedure';
			specificName: string;
			oid?: number;
		}
	): void {
		setRoutineDebugMetadata(uri, meta);
		void vscode.commands.executeCommand('setContext', 'pgsqlToolsRoutineDdl', true);
	}

	updateBreakpointDecorations(editor?: vscode.TextEditor): void {
		if (editor) {
			this.applyBreakpointDecorations(editor);
		} else {
			this.updateAllBreakpointDecorations();
		}
	}

	private updateAllBreakpointDecorations(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.applyBreakpointDecorations(editor);
		}
	}

	private applyBreakpointDecorations(editor: vscode.TextEditor): void {
		const meta = getRoutineDebugMetadata(editor.document.uri);
		if (!meta) {
			editor.setDecorations(this.breakpointDecorationType, []);
			return;
		}
		const lines = this.breakpoints.getLinesFor({
			connectionName: meta.connectionName,
			schema: meta.schema,
			specificName: meta.specificName,
		});
		const ranges = [...lines].map(
			(ln) => new vscode.Range(Math.max(0, ln - 1), 0, Math.max(0, ln - 1), 0)
		);
		editor.setDecorations(this.breakpointDecorationType, ranges);
	}

	private highlightLine(line: number): void {
		const editor = vscode.window.visibleTextEditors.find((e) =>
			getRoutineDebugMetadata(e.document.uri)
		);
		if (!editor) {
			return;
		}
		const range = new vscode.Range(line - 1, 0, line - 1, 0);
		editor.setDecorations(this.currentLineDecorationType, [range]);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
	}

	private clearCurrentLineHighlight(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(this.currentLineDecorationType, []);
		}
	}

	private getGutterIconUri(): vscode.Uri {
		return vscode.Uri.parse(
			'data:image/svg+xml;base64,' +
				Buffer.from(
					'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="5" fill="#e51400"/></svg>'
				).toString('base64')
		);
	}
}
