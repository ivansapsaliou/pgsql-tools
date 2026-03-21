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
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShowERDCommand = void 0;
const vscode = __importStar(require("vscode"));
function escHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function generateErdHtml(schema, tables, columns, pks, fks) {
    const pkSet = new Set(pks.map(p => `${p.table_name}.${p.column_name}`));
    const fkSet = new Set(fks.map(f => `${f.source_table}.${f.source_column}`));
    // Group columns by table
    const colsByTable = new Map();
    for (const t of tables)
        colsByTable.set(t, []);
    for (const c of columns) {
        if (colsByTable.has(c.table_name)) {
            colsByTable.get(c.table_name).push(c);
        }
    }
    // Build FK references per table
    const fksByTable = new Map();
    for (const t of tables)
        fksByTable.set(t, []);
    for (const fk of fks) {
        if (fksByTable.has(fk.source_table)) {
            fksByTable.get(fk.source_table).push(fk);
        }
    }
    // Visual HTML layout
    const tableBoxes = tables.map(tableName => {
        const cols = colsByTable.get(tableName) ?? [];
        const refs = fksByTable.get(tableName) ?? [];
        const colRows = cols.map(c => {
            const isPk = pkSet.has(`${tableName}.${c.column_name}`);
            const isFk = fkSet.has(`${tableName}.${c.column_name}`);
            const badge = isPk ? `<span class="erd-col-pk" title="Primary Key">PK</span>` :
                isFk ? `<span class="erd-col-fk" title="Foreign Key">FK</span>` : '';
            return `<div class="erd-col">
				<span class="erd-col-name">${badge}${escHtml(c.column_name)}</span>
				<span class="erd-col-type">${escHtml(c.data_type)}</span>
			</div>`;
        }).join('');
        const refRows = refs.map(fk => `<div class="erd-ref-row">→ ${escHtml(fk.source_column)} ▶ ${escHtml(fk.target_table)}.${escHtml(fk.target_column)}</div>`).join('');
        const refsHtml = refs.length > 0
            ? `<div class="erd-refs">${refRows}</div>`
            : '';
        return `<div class="erd-table">
			<div class="erd-table-name">${escHtml(tableName)}</div>
			<div class="erd-columns">${colRows}</div>
			${refsHtml}
		</div>`;
    }).join('');
    // Generate Mermaid code
    const mermaidLines = ['erDiagram'];
    for (const tableName of tables) {
        const cols = colsByTable.get(tableName) ?? [];
        if (cols.length === 0)
            continue;
        mermaidLines.push(`    ${tableName} {`);
        for (const c of cols) {
            const safeName = c.column_name.replace(/\s+/g, '_');
            const safeType = c.data_type.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '');
            mermaidLines.push(`        ${safeType || 'text'} ${safeName}`);
        }
        mermaidLines.push('    }');
    }
    const seenRels = new Set();
    for (const fk of fks) {
        const relKey = `${fk.source_table}||--o{${fk.target_table}`;
        const relKeyRev = `${fk.target_table}||--o{${fk.source_table}`;
        if (!seenRels.has(relKey) && !seenRels.has(relKeyRev)) {
            seenRels.add(relKey);
            // Mermaid labels must not contain raw double quotes — replace with single quotes
            const mermaidLabel = fk.constraint_name.replace(/"/g, "'");
            mermaidLines.push(`    ${fk.target_table} ||--o{ ${fk.source_table} : "${mermaidLabel}"`);
        }
    }
    const mermaidCode = mermaidLines.join('\n');
    return `<div class="rich-body">
		<p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:10px;">
			Schema: <strong>${escHtml(schema)}</strong> · ${tables.length} table(s) · ${fks.length} foreign key(s)
		</p>
		<div class="erd-container">${tableBoxes}</div>
		<div class="mermaid-section">
			<p class="mermaid-label">Mermaid diagram code — copy and open at <a href="https://mermaid.live" style="color:var(--vscode-textLink-foreground)">mermaid.live</a> for a full diagram view:</p>
			<pre id="mermaidCode" class="mermaid-code">${escHtml(mermaidCode)}</pre>
		</div>
	</div>`;
}
class ShowERDCommand {
    static register(queryExecutor, connectionManager, resultsViewProvider) {
        return vscode.commands.registerCommand('pgsql-tools.showERD', async () => {
            const connections = connectionManager.getConnections();
            if (connections.length === 0) {
                vscode.window.showErrorMessage('No active connections. Please add and connect first.');
                return;
            }
            // Pick connection
            let connName;
            if (connections.length === 1) {
                connName = connections[0];
            }
            else {
                const connItem = await vscode.window.showQuickPick(connections.map(c => ({ label: c })), { title: 'ER Diagram — Select Connection', placeHolder: 'Choose connection' });
                if (!connItem)
                    return;
                connName = connItem.label;
            }
            const client = connectionManager.getConnectionByName(connName);
            if (!client) {
                vscode.window.showErrorMessage(`Connection "${connName}" is not available.`);
                return;
            }
            // Get schemas
            const schemasRes = await queryExecutor.executeQueryOnClient(client, `SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT LIKE 'pg_%' AND schema_name != 'information_schema' ORDER BY schema_name`);
            const schemaNames = schemasRes.rows.map((r) => r.schema_name);
            // Pick schema
            let schemaName = 'public';
            if (schemaNames.length > 1) {
                const schemaItem = await vscode.window.showQuickPick(schemaNames.map(s => ({ label: s })), { title: 'ER Diagram — Select Schema', placeHolder: 'Choose schema (default: public)' });
                if (!schemaItem)
                    return;
                schemaName = schemaItem.label;
            }
            else if (schemaNames.length === 1) {
                schemaName = schemaNames[0];
            }
            try {
                await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Generating ER Diagram', cancellable: false }, async (progress) => {
                    const esc = (s) => s.replace(/'/g, "''");
                    progress.report({ message: 'Loading tables…' });
                    const tablesRes = await queryExecutor.executeQueryOnClient(client, `SELECT table_name FROM information_schema.tables WHERE table_schema = '${esc(schemaName)}' AND table_type = 'BASE TABLE' ORDER BY table_name`);
                    const tables = tablesRes.rows.map((r) => r.table_name);
                    if (tables.length === 0) {
                        vscode.window.showInformationMessage(`No tables found in schema "${schemaName}".`);
                        return;
                    }
                    progress.report({ message: 'Loading columns…' });
                    const colsRes = await queryExecutor.executeQueryOnClient(client, `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '${esc(schemaName)}' ORDER BY table_name, ordinal_position`);
                    progress.report({ message: 'Loading primary keys…' });
                    const pksRes = await queryExecutor.executeQueryOnClient(client, `SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '${esc(schemaName)}'`);
                    progress.report({ message: 'Loading foreign keys…' });
                    const fksRes = await queryExecutor.executeQueryOnClient(client, `SELECT tc.constraint_name, tc.table_name AS source_table, kcu.column_name AS source_column, ccu.table_name AS target_table, ccu.column_name AS target_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${esc(schemaName)}' ORDER BY tc.table_name, kcu.column_name`);
                    const html = generateErdHtml(schemaName, tables, colsRes.rows, pksRes.rows, fksRes.rows);
                    await resultsViewProvider.showRichContent({
                        type: 'erd',
                        title: `ER Diagram: ${connName} / ${schemaName} (${tables.length} tables)`,
                        content: html
                    });
                });
            }
            catch (err) {
                vscode.window.showErrorMessage(`ER Diagram failed: ${err}`);
            }
        });
    }
}
exports.ShowERDCommand = ShowERDCommand;
//# sourceMappingURL=showERD.js.map