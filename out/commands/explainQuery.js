"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExplainQueryCommand = void 0;
const vscode = __importStar(require("vscode"));
function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/** Recursively render a plan node tree as HTML */
function renderPlanNode(node, depth = 0) {
    if (!node || typeof node !== 'object')
        return '';
    const indent = depth * 20;
    const nodeType = node['Node Type'] ?? 'Unknown';
    const relation = node['Relation Name'] ? ` on <em>${escHtml(node['Relation Name'])}</em>` : '';
    const alias = node['Alias'] && node['Alias'] !== node['Relation Name'] ? ` (alias: ${escHtml(node['Alias'])})` : '';
    const cost = node['Total Cost'] !== undefined
        ? `<span style="color:var(--vscode-descriptionForeground);font-size:10px;margin-left:6px;">cost=..${node['Total Cost']} rows=${node['Plan Rows']} width=${node['Plan Width']}</span>`
        : '';
    const actualTime = node['Actual Total Time'] !== undefined
        ? `<span style="color:var(--vscode-charts-orange,#d2a22a);font-size:10px;margin-left:6px;">actual=${node['Actual Total Time']}ms rows=${node['Actual Rows']} loops=${node['Actual Loops']}</span>`
        : '';
    const filter = node['Filter'] ? `<div style="margin-left:${indent + 16}px;font-size:10px;color:var(--vscode-descriptionForeground);">Filter: ${escHtml(node['Filter'])}</div>` : '';
    const indexName = node['Index Name'] ? ` using <em>${escHtml(node['Index Name'])}</em>` : '';
    const header = `<div style="margin-left:${indent}px;padding:2px 0;">
		<span style="font-weight:600;">${escHtml(nodeType)}</span>${relation}${indexName}${alias}${cost}${actualTime}
	</div>${filter}`;
    const children = (node['Plans'] ?? []).map((child) => renderPlanNode(child, depth + 1)).join('');
    return header + children;
}
class ExplainQueryCommand {
    static register(queryExecutor, connectionManager, resultsViewProvider) {
        return vscode.commands.registerCommand('pgsql-tools.explainQuery', async () => {
            const activeConn = connectionManager.getActiveConnectionName();
            if (!activeConn) {
                vscode.window.showErrorMessage('No active database connection. Please select a connection first.');
                return;
            }
            // Get SQL from editor selection or InputBox
            let sql = '';
            const editor = vscode.window.activeTextEditor;
            if (editor && !editor.selection.isEmpty) {
                sql = editor.document.getText(editor.selection).trim();
            }
            if (!sql) {
                const input = await vscode.window.showInputBox({
                    title: 'Explain Query — Enter SQL',
                    prompt: 'Enter the SQL query to explain (or select text in the editor first)',
                    placeHolder: 'SELECT ...',
                    ignoreFocusOut: true
                });
                if (input === undefined)
                    return;
                sql = input.trim();
            }
            if (!sql) {
                vscode.window.showErrorMessage('No SQL query provided.');
                return;
            }
            // Pick ANALYZE flag
            const analyzeItem = await vscode.window.showQuickPick([
                { label: '$(debug-step-over) EXPLAIN only', description: 'Show estimated plan (no query execution)', value: false },
                { label: '$(run) EXPLAIN ANALYZE', description: 'Execute query and show actual timings', value: true }
            ], { title: 'Explain Query — Analyze', placeHolder: 'Run EXPLAIN ANALYZE?' });
            if (!analyzeItem)
                return;
            const analyze = analyzeItem.value;
            // Pick BUFFERS flag (only relevant with ANALYZE)
            let buffers = false;
            if (analyze) {
                const buffersItem = await vscode.window.showQuickPick([
                    { label: 'Without BUFFERS', value: false },
                    { label: 'With BUFFERS', description: 'Show buffer usage statistics', value: true }
                ], { title: 'Explain Query — Buffers', placeHolder: 'Include BUFFERS?' });
                if (!buffersItem)
                    return;
                buffers = buffersItem.value;
            }
            try {
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Running EXPLAIN…', cancellable: false }, async () => {
                    const options = ['FORMAT JSON'];
                    if (analyze)
                        options.push('ANALYZE');
                    if (buffers)
                        options.push('BUFFERS');
                    const explainSql = `EXPLAIN (${options.join(', ')}) ${sql}`;
                    const result = await queryExecutor.executeQuery(explainSql);
                    const planJson = result.rows[0]?.['QUERY PLAN'] ?? result.rows[0];
                    const planStr = typeof planJson === 'string' ? planJson : JSON.stringify(planJson, null, 2);
                    // Try to parse and render as tree
                    let treeHtml = '';
                    let parseError = false;
                    try {
                        const planArray = typeof planJson === 'string' ? JSON.parse(planJson) : planJson;
                        const plan = Array.isArray(planArray) ? planArray[0]?.Plan : planArray?.Plan;
                        if (plan) {
                            treeHtml = renderPlanNode(plan);
                        }
                    }
                    catch {
                        parseError = true;
                    }
                    const treeSection = (!parseError && treeHtml) ? `
							<div class="diff-section" style="margin-bottom:16px;">
								<h3>Plan Tree</h3>
								<div style="font-family:var(--vscode-editor-font-family,monospace);font-size:12px;padding:8px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:3px;overflow:auto;">
									${treeHtml}
								</div>
							</div>` : '';
                    const flagsLabel = [
                        analyze ? 'ANALYZE' : '',
                        buffers ? 'BUFFERS' : ''
                    ].filter(Boolean).join(', ') || 'estimate only';
                    const sqlPreview = sql.length > 120 ? sql.slice(0, 120) + '…' : sql;
                    const content = `<div class="rich-body">
							<p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:10px;">
								Connection: <strong>${escHtml(activeConn)}</strong> · ${escHtml(flagsLabel)}
							</p>
							<div class="diff-section" style="margin-bottom:12px;">
								<h3>SQL</h3>
								<pre style="font-size:11px;padding:6px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:3px;white-space:pre-wrap;word-break:break-all;">${escHtml(sqlPreview)}</pre>
							</div>
							${treeSection}
							<div class="diff-section">
								<h3>Raw JSON Plan</h3>
								<pre style="font-family:var(--vscode-editor-font-family,monospace);font-size:11px;padding:8px;background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:3px;overflow:auto;white-space:pre-wrap;word-break:break-all;">${escHtml(planStr)}</pre>
							</div>
						</div>`;
                    const titleFlags = analyze ? ` (ANALYZE${buffers ? ', BUFFERS' : ''})` : '';
                    await resultsViewProvider.showRichContent({
                        type: 'html',
                        title: `EXPLAIN${titleFlags}: ${sqlPreview}`,
                        content
                    });
                });
            }
            catch (err) {
                vscode.window.showErrorMessage(`EXPLAIN failed: ${err}`);
            }
        });
    }
}
exports.ExplainQueryCommand = ExplainQueryCommand;
//# sourceMappingURL=explainQuery.js.map