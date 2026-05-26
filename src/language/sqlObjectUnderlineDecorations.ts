import * as vscode from 'vscode';
import { SqlSchemaRegistry } from './sqlSchemaRegistry';
import { scanObjectRefsInDocument, type SqlObjectRef } from './sqlObjectScanner';

type UnderlineKind = Exclude<SqlObjectRef['kind'], 'column'>;

const UNDERLINE_COLORS: Record<UnderlineKind, string> = {
	table: 'pgsqlTools.tableUnderline',
	view: 'pgsqlTools.viewUnderline',
	function: 'pgsqlTools.functionUnderline',
	procedure: 'pgsqlTools.procedureUnderline',
};

function underlineStyle(colorId: string): vscode.DecorationRenderOptions {
	return {
		borderWidth: '0 0 1px 0',
		borderStyle: 'solid',
		borderColor: new vscode.ThemeColor(colorId),
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	};
}

function isHighlightingEnabled(): boolean {
	return vscode.workspace.getConfiguration('pgsql-tools').get<boolean>('sqlObjectHighlighting', true);
}

export class SqlObjectUnderlineDecorator {
	private decorationTypes: Record<UnderlineKind, vscode.TextEditorDecorationType>;
	private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private registry: SqlSchemaRegistry) {
		this.decorationTypes = {
			table: vscode.window.createTextEditorDecorationType(underlineStyle(UNDERLINE_COLORS.table)),
			view: vscode.window.createTextEditorDecorationType(underlineStyle(UNDERLINE_COLORS.view)),
			function: vscode.window.createTextEditorDecorationType(
				underlineStyle(UNDERLINE_COLORS.function)
			),
			procedure: vscode.window.createTextEditorDecorationType(
				underlineStyle(UNDERLINE_COLORS.procedure)
			),
		};

		registry.onDidRefresh(() => this.scheduleRefreshAll());

		vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.languageId === 'sql') {
				this.scheduleRefresh(e.document.uri.toString());
			}
		});

		vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor?.document.languageId === 'sql') {
				void this.refreshEditor(editor);
			}
		});

		vscode.window.onDidChangeVisibleTextEditors(() => {
			this.scheduleRefreshAll();
		});

		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('pgsql-tools.sqlObjectHighlighting')) {
				this.scheduleRefreshAll();
			}
		});
	}

	dispose(): void {
		for (const t of Object.values(this.decorationTypes)) {
			t.dispose();
		}
	}

	private scheduleRefreshAll(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			if (editor.document.languageId === 'sql') {
				this.scheduleRefresh(editor.document.uri.toString());
			}
		}
	}

	private scheduleRefresh(uriKey: string): void {
		const prev = this.debounceTimers.get(uriKey);
		if (prev) {
			clearTimeout(prev);
		}
		this.debounceTimers.set(
			uriKey,
			setTimeout(() => {
				this.debounceTimers.delete(uriKey);
				const editor = vscode.window.visibleTextEditors.find(
					(e) => e.document.uri.toString() === uriKey
				);
				if (editor) {
					void this.refreshEditor(editor);
				}
			}, 400)
		);
	}

	async refreshEditor(editor: vscode.TextEditor): Promise<void> {
		const doc = editor.document;
		if (doc.languageId !== 'sql' || doc.uri.scheme === 'pgsql-tools-git') {
			this.clearEditor(editor);
			return;
		}
		if (!isHighlightingEnabled()) {
			this.clearEditor(editor);
			return;
		}

		await this.registry.ensureFresh();
		const refs = scanObjectRefsInDocument(doc, this.registry);

		const byKind: Record<UnderlineKind, vscode.Range[]> = {
			table: [],
			view: [],
			function: [],
			procedure: [],
		};

		for (const ref of refs) {
			if (ref.kind === 'column') {
				continue;
			}
			byKind[ref.kind].push(ref.range);
		}

		for (const kind of Object.keys(byKind) as UnderlineKind[]) {
			editor.setDecorations(this.decorationTypes[kind], byKind[kind]);
		}
	}

	private clearEditor(editor: vscode.TextEditor): void {
		for (const kind of Object.keys(this.decorationTypes) as UnderlineKind[]) {
			editor.setDecorations(this.decorationTypes[kind], []);
		}
	}
}

export function registerSqlObjectUnderlineDecorations(
	context: vscode.ExtensionContext,
	registry: SqlSchemaRegistry
): SqlObjectUnderlineDecorator {
	const decorator = new SqlObjectUnderlineDecorator(registry);
	context.subscriptions.push({ dispose: () => decorator.dispose() });

	for (const editor of vscode.window.visibleTextEditors) {
		if (editor.document.languageId === 'sql') {
			void decorator.refreshEditor(editor);
		}
	}

	return decorator;
}
