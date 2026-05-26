import * as vscode from 'vscode';
import { ConnectionManager } from '../database/connectionManager';
import { QueryExecutor, type GitDdlObjectKind } from '../database/queryExecutor';

export function ddlDocumentKey(
	connectionName: string,
	schema: string,
	objectType: GitDdlObjectKind,
	objectName: string
): string {
	return `${connectionName}:${schema}:${objectType}:${objectName}`;
}

export class ObjectDdlEditor {
	constructor(
		private connectionManager: ConnectionManager,
		private queryExecutor: QueryExecutor,
		private openDdlDocumentsByKey: Map<string, string>,
		private routineDdlOriginalText: Map<string, string>,
		private decorationType: vscode.TextEditorDecorationType,
		private onEditorOpened?: () => void
	) {}

	async open(
		connectionName: string,
		schema: string,
		objectName: string,
		objectType: GitDdlObjectKind
	): Promise<void> {
		try {
			const docKey = ddlDocumentKey(connectionName, schema, objectType, objectName);
			const existingUri = this.openDdlDocumentsByKey.get(docKey);
			if (existingUri) {
				const existing = vscode.workspace.textDocuments.find(
					(d) => d.uri.toString() === existingUri
				);
				if (existing) {
					const editor = await vscode.window.showTextDocument(existing, {
						viewColumn: vscode.ViewColumn.One,
						preview: true,
						preserveFocus: false,
					});
					if (!this.routineDdlOriginalText.has(existingUri)) {
						this.routineDdlOriginalText.set(existingUri, existing.getText());
					}
					this.updateDecorations(editor);
					this.onEditorOpened?.();
					return;
				}
				this.openDdlDocumentsByKey.delete(docKey);
			}

			const client = this.connectionManager.getConnectionByName(connectionName);
			if (!client) {
				vscode.window.showWarningMessage(
					`Подключение «${connectionName}» не активно. Подключитесь к БД и повторите.`
				);
				return;
			}
			const ddl = await this.queryExecutor.getObjectDdlOnClient(
				client,
				schema,
				objectName,
				objectType
			);
			const doc = await vscode.workspace.openTextDocument({
				language: 'sql',
				content: ddl,
			});
			const uriKey = doc.uri.toString();
			this.openDdlDocumentsByKey.set(docKey, uriKey);
			this.routineDdlOriginalText.set(uriKey, ddl);
			const editor = await vscode.window.showTextDocument(doc, {
				viewColumn: vscode.ViewColumn.One,
				preview: true,
				preserveFocus: false,
			});
			this.updateDecorations(editor);
			this.onEditorOpened?.();
		} catch (err) {
			vscode.window.showErrorMessage(
				`Не удалось открыть DDL: ${err instanceof Error ? err.message : String(err)}`
			);
		}
	}

	updateDecorationsForEditor(editor: vscode.TextEditor | undefined): void {
		if (!editor || editor.document.languageId !== 'sql') {
			return;
		}
		if (editor.document.uri.scheme === 'pgsql-tools-git') {
			return;
		}
		this.updateDecorations(editor);
	}

	private updateDecorations(editor: vscode.TextEditor): void {
		const key = editor.document.uri.toString();
		const original = this.routineDdlOriginalText.get(key);
		if (original === undefined) {
			return;
		}
		const current = editor.document.getText();
		if (current === original) {
			editor.setDecorations(this.decorationType, []);
			return;
		}
		const orig = original.split(/\r?\n/);
		const cur = current.split(/\r?\n/);
		const n = orig.length;
		const m = cur.length;
		const dp: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i][j] =
					orig[i] === cur[j]
						? dp[i + 1][j + 1] + 1
						: Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
		const unchanged = new Set<number>();
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (orig[i] === cur[j]) {
				unchanged.add(j + 1);
				i++;
				j++;
				continue;
			}
			if (dp[i + 1][j] >= dp[i][j + 1]) {
				i++;
			} else {
				j++;
			}
		}
		const decorations: vscode.Range[] = [];
		for (let line = 1; line <= m; line++) {
			if (!unchanged.has(line)) {
				const docLine = editor.document.lineAt(Math.max(0, line - 1));
				decorations.push(
					new vscode.Range(docLine.lineNumber, 0, docLine.lineNumber, docLine.text.length)
				);
			}
		}
		editor.setDecorations(this.decorationType, decorations);
	}
}
