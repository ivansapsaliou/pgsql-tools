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
exports.SQLCompletionProvider = void 0;
const vscode = __importStar(require("vscode"));
// ─── SQL Parser ───────────────────────────────────────────────────────────────
class SQLParser {
    /**
     * Strips block comments, line comments, and string literals
     * (replaces content with spaces to preserve positions).
     */
    static stripNoise(sql) {
        let result = '';
        let i = 0;
        while (i < sql.length) {
            // Block comment
            if (sql[i] === '/' && sql[i + 1] === '*') {
                const end = sql.indexOf('*/', i + 2);
                const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end + 2);
                result += chunk.replace(/[^\n]/g, ' ');
                i += chunk.length;
                continue;
            }
            // Line comment
            if (sql[i] === '-' && sql[i + 1] === '-') {
                const end = sql.indexOf('\n', i);
                const chunk = end === -1 ? sql.slice(i) : sql.slice(i, end);
                result += chunk.replace(/./g, ' ');
                i += chunk.length;
                continue;
            }
            // Single-quoted string
            if (sql[i] === "'") {
                let j = i + 1;
                while (j < sql.length) {
                    if (sql[j] === "'" && sql[j + 1] === "'") {
                        j += 2;
                        continue;
                    }
                    if (sql[j] === "'") {
                        j++;
                        break;
                    }
                    j++;
                }
                result += sql.slice(i, j).replace(/[^\n]/g, ' ');
                i = j;
                continue;
            }
            // Dollar-quoted string (PostgreSQL $$...$$)
            if (sql[i] === '$') {
                const tagMatch = sql.slice(i).match(/^\$([^$]*)\$/);
                if (tagMatch) {
                    const tag = tagMatch[0];
                    const endTag = sql.indexOf(tag, i + tag.length);
                    const chunk = endTag === -1 ? sql.slice(i) : sql.slice(i, endTag + tag.length);
                    result += chunk.replace(/[^\n]/g, ' ');
                    i += chunk.length;
                    continue;
                }
            }
            result += sql[i++];
        }
        return result;
    }
    /**
     * Find the statement that contains `offset`.
     * Splits on `;` but only at the top level (not inside parens).
     */
    static findActiveStatement(sql, offset) {
        const clean = this.stripNoise(sql);
        let depth = 0;
        let stmtStart = 0;
        for (let i = 0; i < clean.length; i++) {
            if (clean[i] === '(')
                depth++;
            else if (clean[i] === ')')
                depth--;
            else if (clean[i] === ';' && depth === 0) {
                if (i >= offset) {
                    return { text: sql.slice(stmtStart, i), start: stmtStart };
                }
                stmtStart = i + 1;
            }
        }
        return { text: sql.slice(stmtStart), start: stmtStart };
    }
    /**
     * Returns text of balanced parentheses starting at `start` (which points to `(`).
     */
    static extractParens(sql, start) {
        let depth = 0;
        for (let i = start; i < sql.length; i++) {
            if (sql[i] === '(')
                depth++;
            else if (sql[i] === ')') {
                depth--;
                if (depth === 0)
                    return sql.slice(start + 1, i);
            }
        }
        return sql.slice(start + 1);
    }
    /**
     * Parse WITH clause and return map of CTE name → CTE body text.
     */
    static parseCTEs(sql) {
        const ctes = new Map();
        const clean = this.stripNoise(sql);
        const withMatch = clean.match(/^\s*WITH\s+/i);
        if (!withMatch)
            return ctes;
        // Find all CTE definitions before the main SELECT
        const re = /\b(\w+)\s+AS\s*\(/gi;
        let m;
        re.lastIndex = withMatch[0].length;
        while ((m = re.exec(clean)) !== null) {
            const name = m[1].toLowerCase();
            const bodyStart = m.index + m[0].length - 1; // points to '('
            const body = this.extractParens(sql, bodyStart);
            ctes.set(name, body);
        }
        return ctes;
    }
    /**
     * Parse FROM / JOIN clause of a (possibly nested) SELECT and return alias map.
     * Handles:
     *   FROM schema.table [AS] alias
     *   JOIN schema.table [AS] alias
     *   FROM (subquery) [AS] alias
     *   FROM cte_name [AS] alias
     */
    static parseAliases(sql, knownCTEs, knownTables // table_lower → schema
    ) {
        const aliases = {};
        const clean = this.stripNoise(sql).toUpperCase();
        const original = sql;
        // Replace subqueries with placeholders to simplify parsing
        const withoutSubqueries = this.flattenSubqueries(clean);
        // Match FROM/JOIN clauses
        const fromJoinRe = /\b(?:FROM|JOIN|INNER\s+JOIN|LEFT\s+(?:OUTER\s+)?JOIN|RIGHT\s+(?:OUTER\s+)?JOIN|FULL\s+(?:OUTER\s+)?JOIN|CROSS\s+JOIN)\s+/gi;
        let m;
        while ((m = fromJoinRe.exec(withoutSubqueries)) !== null) {
            const rest = withoutSubqueries.slice(m.index + m[0].length);
            const originalRest = original.slice(m.index + m[0].length);
            // Check if it's a subquery placeholder
            if (rest.trimStart().startsWith('__SUB')) {
                const subMatch = rest.match(/^__SUB(\d+)__\s*(?:AS\s+)?(\w+)?/i);
                if (subMatch) {
                    const alias = (subMatch[2] || '').toLowerCase();
                    if (alias) {
                        aliases[alias] = { kind: 'subquery', columns: [] };
                    }
                }
                continue;
            }
            // Match: [schema.]table [[AS] alias]
            const tableMatch = originalRest.match(/^"?(\w+)"?\s*\.\s*"?(\w+)"?\s*(?:AS\s+)?"?(\w+)"?|^"?(\w+)"?\s*(?:AS\s+)?"?(\w+)"?/i);
            if (!tableMatch)
                continue;
            let schema, table, alias;
            if (tableMatch[1] && tableMatch[2]) {
                // schema.table alias
                schema = tableMatch[1].toLowerCase();
                table = tableMatch[2].toLowerCase();
                alias = (tableMatch[3] || table).toLowerCase();
            }
            else if (tableMatch[4]) {
                // table alias  or  cte alias
                table = tableMatch[4].toLowerCase();
                alias = (tableMatch[5] || table).toLowerCase();
                if (knownCTEs.has(table)) {
                    aliases[alias] = { kind: 'cte', table };
                    continue;
                }
                schema = knownTables.get(table);
            }
            else {
                continue;
            }
            if (table) {
                aliases[alias] = { kind: 'table', schema, table };
                // Also register unaliased table name
                if (alias !== table) {
                    aliases[table] = { kind: 'table', schema, table };
                }
            }
        }
        return aliases;
    }
    /** Replace subquery bodies with __SUB0__, __SUB1__, etc. */
    static flattenSubqueries(sql) {
        let result = sql;
        let counter = 0;
        let changed = true;
        while (changed) {
            changed = false;
            // Find innermost parens that don't contain parens
            result = result.replace(/\(([^()]*)\)/g, (_, inner) => {
                if (/\bSELECT\b/i.test(inner)) {
                    changed = true;
                    return `__SUB${counter++}__`;
                }
                return `(${inner})`;
            });
        }
        return result;
    }
    /**
     * Determine what's before the cursor:
     * - "alias." → return alias
     * - "table." → return table
     * - bare word → return null (general completion)
     */
    static getPrefixContext(textBeforeCursor) {
        // After a dot: alias.pre|fix
        const dotMatch = textBeforeCursor.match(/(\w+)\.(\w*)$/);
        if (dotMatch) {
            return { qualifier: dotMatch[1].toLowerCase(), prefix: dotMatch[2].toLowerCase(), triggerKind: 'dot' };
        }
        // Bare word
        const wordMatch = textBeforeCursor.match(/(\w*)$/);
        return { qualifier: null, prefix: wordMatch ? wordMatch[1].toLowerCase() : '', triggerKind: 'word' };
    }
    /**
     * Detect which clause the cursor is in:
     * SELECT, FROM, WHERE, GROUP BY, ORDER BY, JOIN ON, SET, etc.
     */
    static detectClause(textBeforeCursor) {
        const upper = textBeforeCursor.toUpperCase();
        const clauses = [
            'ON', 'SET', 'HAVING', 'ORDER BY', 'GROUP BY',
            'WHERE', 'JOIN', 'FROM', 'SELECT', 'INSERT INTO',
            'UPDATE', 'DELETE FROM'
        ];
        for (const clause of clauses) {
            const idx = upper.lastIndexOf(clause);
            if (idx !== -1)
                return clause;
        }
        return 'SELECT';
    }
}
// ─── Schema Cache ─────────────────────────────────────────────────────────────
class SchemaCache {
    constructor(queryExecutor, connectionManager) {
        this.queryExecutor = queryExecutor;
        this.connectionManager = connectionManager;
        this.tables = new Map(); // `schema.table` → info
        this.tableIndex = new Map(); // table_lower → schema
        this.lastRefresh = 0;
        this.refreshInterval = 60000; // 1 minute
        this.refreshing = false;
    }
    async ensureFresh() {
        if (this.refreshing)
            return;
        if (Date.now() - this.lastRefresh < this.refreshInterval && this.tables.size > 0)
            return;
        if (!this.connectionManager.getActiveConnectionName())
            return;
        await this.refresh();
    }
    async refresh() {
        if (this.refreshing)
            return;
        this.refreshing = true;
        try {
            // Load all columns in one query (much faster than per-table)
            const result = await this.queryExecutor.executeQuery(`
				SELECT
					c.table_schema,
					c.table_name,
					c.column_name,
					c.data_type,
					c.is_nullable
				FROM information_schema.columns c
				INNER JOIN information_schema.tables t
					ON t.table_schema = c.table_schema
					AND t.table_name = c.table_name
					AND t.table_type = 'BASE TABLE'
				WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
				ORDER BY c.table_schema, c.table_name, c.ordinal_position
			`);
            this.tables.clear();
            this.tableIndex.clear();
            for (const row of result.rows) {
                const key = `${row.table_schema}.${row.table_name}`;
                if (!this.tables.has(key)) {
                    this.tables.set(key, {
                        schema: row.table_schema,
                        table: row.table_name,
                        columns: []
                    });
                    this.tableIndex.set(row.table_name.toLowerCase(), row.table_schema);
                }
                this.tables.get(key).columns.push({
                    name: row.column_name,
                    type: row.data_type,
                    nullable: row.is_nullable === 'YES'
                });
            }
            this.lastRefresh = Date.now();
        }
        catch (e) {
            // Silently ignore — no active connection etc.
        }
        finally {
            this.refreshing = false;
        }
    }
    getColumns(schema, table) {
        return this.tables.get(`${schema}.${table}`)?.columns ?? [];
    }
    getTableSchema(table) {
        return this.tableIndex.get(table.toLowerCase());
    }
    getAllTables() {
        return Array.from(this.tables.values());
    }
    getTableIndex() {
        return this.tableIndex;
    }
    clear() {
        this.tables.clear();
        this.tableIndex.clear();
        this.lastRefresh = 0;
    }
}
// ─── Main Provider ────────────────────────────────────────────────────────────
class SQLCompletionProvider {
    constructor(queryExecutor, connectionManager) {
        this.queryExecutor = queryExecutor;
        this.connectionManager = connectionManager;
        this.cache = new SchemaCache(queryExecutor, connectionManager);
        // Trigger background refresh when connection changes
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.cache.ensureFresh().catch(() => { });
        });
    }
    async provideCompletionItems(document, position, _token, _context) {
        // Ensure schema is loaded (non-blocking for first char)
        this.cache.ensureFresh().catch(() => { });
        const fullText = document.getText();
        const offset = document.offsetAt(position);
        const textBeforeCursor = fullText.slice(0, offset);
        // Parse active statement
        const { text: stmtText, start: stmtStart } = SQLParser.findActiveStatement(fullText, offset);
        const offsetInStmt = offset - stmtStart;
        const textBeforeInStmt = stmtText.slice(0, offsetInStmt);
        // Get prefix context
        const { qualifier, prefix, triggerKind } = SQLParser.getPrefixContext(textBeforeCursor);
        const items = [];
        if (triggerKind === 'dot' && qualifier) {
            // ── Qualified completion: alias.| or table.| ──────────────────────
            items.push(...await this.getQualifiedCompletions(qualifier, prefix, stmtText, textBeforeInStmt));
        }
        else {
            // ── General completion ─────────────────────────────────────────────
            const clause = SQLParser.detectClause(textBeforeInStmt.toUpperCase());
            items.push(...this.getKeywordCompletions(prefix, clause));
            items.push(...this.getFunctionCompletions(prefix, clause));
            items.push(...this.getTableCompletions(prefix));
            items.push(...this.getSchemaCompletions(prefix));
            if (['SELECT', 'WHERE', 'ON', 'HAVING', 'SET'].includes(clause)) {
                items.push(...await this.getContextColumnCompletions(prefix, stmtText, textBeforeInStmt));
            }
        }
        return items;
    }
    // ── Qualified: alias.col ───────────────────────────────────────────────────
    async getQualifiedCompletions(qualifier, prefix, stmtText, textBefore) {
        const ctes = SQLParser.parseCTEs(stmtText);
        const tableIndex = this.cache.getTableIndex();
        const aliases = SQLParser.parseAliases(stmtText, new Set(ctes.keys()), tableIndex);
        const source = aliases[qualifier];
        // Direct table/schema reference: schema.table or public schema
        if (!source) {
            // Maybe it's a schema name → suggest tables in that schema
            const tables = this.cache.getAllTables().filter(t => t.schema.toLowerCase() === qualifier);
            if (tables.length > 0) {
                return tables
                    .filter(t => t.table.toLowerCase().startsWith(prefix))
                    .map(t => {
                    const item = new vscode.CompletionItem(t.table, vscode.CompletionItemKind.Class);
                    item.detail = `table in ${t.schema}`;
                    item.sortText = '0' + t.table;
                    return item;
                });
            }
            // Maybe it's a table name directly (no alias)
            const schema = this.cache.getTableSchema(qualifier);
            if (schema) {
                return this.columnItems(this.cache.getColumns(schema, qualifier), prefix);
            }
            return [];
        }
        if (source.kind === 'table' && source.table) {
            const schema = source.schema || this.cache.getTableSchema(source.table) || 'public';
            return this.columnItems(this.cache.getColumns(schema, source.table), prefix);
        }
        if (source.kind === 'cte' && source.table) {
            // Resolve CTE → get columns from its SELECT
            const cteBody = ctes.get(source.table);
            if (cteBody) {
                const cols = this.extractSelectColumns(cteBody, ctes, tableIndex);
                return cols
                    .filter(c => c.toLowerCase().startsWith(prefix))
                    .map(c => {
                    const item = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
                    item.detail = `column (from CTE ${source.table})`;
                    item.sortText = '1' + c;
                    return item;
                });
            }
        }
        if (source.kind === 'subquery' && source.columns) {
            return source.columns
                .filter(c => c.toLowerCase().startsWith(prefix))
                .map(c => {
                const item = new vscode.CompletionItem(c, vscode.CompletionItemKind.Field);
                item.detail = 'column (from subquery)';
                item.sortText = '1' + c;
                return item;
            });
        }
        return [];
    }
    // ── Context columns (no qualifier) ────────────────────────────────────────
    async getContextColumnCompletions(prefix, stmtText, textBefore) {
        const ctes = SQLParser.parseCTEs(stmtText);
        const tableIndex = this.cache.getTableIndex();
        const aliases = SQLParser.parseAliases(stmtText, new Set(ctes.keys()), tableIndex);
        const seen = new Set();
        const items = [];
        for (const [alias, source] of Object.entries(aliases)) {
            let cols = [];
            if (source.kind === 'table' && source.table) {
                const schema = source.schema || this.cache.getTableSchema(source.table) || 'public';
                cols = this.cache.getColumns(schema, source.table).map(c => c.name);
            }
            else if (source.kind === 'cte' && source.table) {
                const cteBody = ctes.get(source.table);
                if (cteBody)
                    cols = this.extractSelectColumns(cteBody, ctes, tableIndex);
            }
            else if (source.kind === 'subquery' && source.columns) {
                cols = source.columns;
            }
            for (const col of cols) {
                if (!col.toLowerCase().startsWith(prefix))
                    continue;
                if (seen.has(col))
                    continue;
                seen.add(col);
                const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
                item.detail = `column`;
                item.sortText = '2' + col;
                items.push(item);
            }
        }
        return items;
    }
    // ── Extract column names from a SELECT ────────────────────────────────────
    extractSelectColumns(sql, ctes, tableIndex) {
        const clean = SQLParser.stripNoise(sql);
        // Find top-level SELECT ... FROM
        const selectMatch = clean.match(/\bSELECT\s+([\s\S]+?)\s+FROM\b/i);
        if (!selectMatch)
            return [];
        const selectList = selectMatch[1];
        // If SELECT *, try to resolve table
        if (selectList.trim() === '*') {
            const aliases = SQLParser.parseAliases(sql, new Set(ctes.keys()), tableIndex);
            const cols = [];
            for (const src of Object.values(aliases)) {
                if (src.kind === 'table' && src.table) {
                    const schema = src.schema || this.cache.getTableSchema(src.table) || 'public';
                    this.cache.getColumns(schema, src.table).forEach(c => cols.push(c.name));
                }
            }
            return [...new Set(cols)];
        }
        // Parse column list
        return this.splitTopLevel(selectList)
            .map(expr => {
            expr = expr.trim();
            // alias AS name or name
            const asMatch = expr.match(/\bAS\s+(\w+)\s*$/i);
            if (asMatch)
                return asMatch[1];
            // table.col or col
            const colMatch = expr.match(/(?:\w+\.)?(\w+)\s*$/);
            return colMatch ? colMatch[1] : null;
        })
            .filter((c) => c !== null && c !== '*');
    }
    /** Split comma-separated list respecting parens */
    splitTopLevel(sql) {
        const parts = [];
        let depth = 0;
        let start = 0;
        for (let i = 0; i < sql.length; i++) {
            if (sql[i] === '(')
                depth++;
            else if (sql[i] === ')')
                depth--;
            else if (sql[i] === ',' && depth === 0) {
                parts.push(sql.slice(start, i));
                start = i + 1;
            }
        }
        parts.push(sql.slice(start));
        return parts;
    }
    // ── Column items ──────────────────────────────────────────────────────────
    columnItems(cols, prefix) {
        return cols
            .filter(c => c.name.toLowerCase().startsWith(prefix))
            .map(c => {
            const item = new vscode.CompletionItem(c.name, vscode.CompletionItemKind.Field);
            item.detail = c.type + (c.nullable ? '' : ' NOT NULL');
            item.documentation = new vscode.MarkdownString(`**${c.name}**\n\nType: \`${c.type}\`\nNullable: ${c.nullable ? 'yes' : 'no'}`);
            item.sortText = '1' + c.name;
            return item;
        });
    }
    // ── Table completions ─────────────────────────────────────────────────────
    getTableCompletions(prefix) {
        return this.cache.getAllTables()
            .filter(t => t.table.toLowerCase().startsWith(prefix))
            .map(t => {
            const item = new vscode.CompletionItem(t.table, vscode.CompletionItemKind.Class);
            item.detail = `table · ${t.schema}`;
            item.documentation = new vscode.MarkdownString(`**${t.schema}.${t.table}**\n\nColumns: ${t.columns.map(c => `\`${c.name}\``).join(', ')}`);
            item.sortText = '3' + t.table;
            return item;
        });
    }
    // ── Schema completions ────────────────────────────────────────────────────
    getSchemaCompletions(prefix) {
        const schemas = [...new Set(this.cache.getAllTables().map(t => t.schema))];
        return schemas
            .filter(s => s.toLowerCase().startsWith(prefix))
            .map(s => {
            const item = new vscode.CompletionItem(s, vscode.CompletionItemKind.Module);
            item.detail = 'schema';
            item.sortText = '4' + s;
            return item;
        });
    }
    // ── Keyword completions ───────────────────────────────────────────────────
    getKeywordCompletions(prefix, clause) {
        const keywords = [
            // DML
            'SELECT', 'INSERT INTO', 'UPDATE', 'DELETE FROM',
            'FROM', 'WHERE', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
            'FULL OUTER JOIN', 'CROSS JOIN', 'ON', 'USING',
            'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
            'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'IN', 'NOT IN',
            'EXISTS', 'NOT EXISTS', 'BETWEEN', 'LIKE', 'ILIKE',
            'IS NULL', 'IS NOT NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
            'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT',
            // DDL
            'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE',
            'CREATE INDEX', 'DROP INDEX', 'CREATE VIEW', 'DROP VIEW',
            // Types
            'INTEGER', 'BIGINT', 'SMALLINT', 'SERIAL', 'BIGSERIAL',
            'TEXT', 'VARCHAR', 'CHAR', 'BOOLEAN', 'BOOL',
            'NUMERIC', 'DECIMAL', 'REAL', 'DOUBLE PRECISION', 'FLOAT',
            'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ', 'INTERVAL',
            'JSON', 'JSONB', 'UUID', 'BYTEA', 'ARRAY',
            // Values
            'NULL', 'TRUE', 'FALSE',
            // Misc
            'WITH', 'RETURNING', 'SET', 'VALUES', 'DEFAULT', 'PRIMARY KEY',
            'FOREIGN KEY', 'REFERENCES', 'UNIQUE', 'NOT NULL', 'CHECK',
            'ON CONFLICT', 'DO NOTHING', 'DO UPDATE',
            'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT',
            'EXPLAIN', 'EXPLAIN ANALYZE', 'VACUUM', 'ANALYZE',
        ];
        return keywords
            .filter(k => k.toLowerCase().startsWith(prefix.toLowerCase()))
            .map(k => {
            const item = new vscode.CompletionItem(k, vscode.CompletionItemKind.Keyword);
            item.sortText = '5' + k;
            return item;
        });
    }
    // ── Function completions ──────────────────────────────────────────────────
    getFunctionCompletions(prefix, clause) {
        const functions = [
            // Aggregate
            { name: 'COUNT', sig: 'COUNT(expression)', doc: 'Count rows' },
            { name: 'SUM', sig: 'SUM(expression)', doc: 'Sum values' },
            { name: 'AVG', sig: 'AVG(expression)', doc: 'Average value' },
            { name: 'MIN', sig: 'MIN(expression)', doc: 'Minimum value' },
            { name: 'MAX', sig: 'MAX(expression)', doc: 'Maximum value' },
            { name: 'ARRAY_AGG', sig: 'ARRAY_AGG(expression ORDER BY ...)', doc: 'Aggregate into array' },
            { name: 'STRING_AGG', sig: 'STRING_AGG(expression, delimiter)', doc: 'Aggregate into string' },
            { name: 'JSON_AGG', sig: 'JSON_AGG(expression)', doc: 'Aggregate into JSON array' },
            { name: 'JSONB_AGG', sig: 'JSONB_AGG(expression)', doc: 'Aggregate into JSONB array' },
            // String
            { name: 'LENGTH', sig: 'LENGTH(string)', doc: 'String length' },
            { name: 'UPPER', sig: 'UPPER(string)', doc: 'Uppercase' },
            { name: 'LOWER', sig: 'LOWER(string)', doc: 'Lowercase' },
            { name: 'TRIM', sig: 'TRIM([LEADING|TRAILING|BOTH] string)', doc: 'Trim whitespace' },
            { name: 'LTRIM', sig: 'LTRIM(string)', doc: 'Left trim' },
            { name: 'RTRIM', sig: 'RTRIM(string)', doc: 'Right trim' },
            { name: 'SUBSTRING', sig: 'SUBSTRING(string FROM start [FOR len])', doc: 'Extract substring' },
            { name: 'REPLACE', sig: 'REPLACE(string, from, to)', doc: 'Replace substring' },
            { name: 'REGEXP_REPLACE', sig: 'REGEXP_REPLACE(string, pattern, replacement)', doc: 'Regex replace' },
            { name: 'CONCAT', sig: 'CONCAT(str1, str2, ...)', doc: 'Concatenate strings' },
            { name: 'CONCAT_WS', sig: 'CONCAT_WS(sep, str1, str2, ...)', doc: 'Concatenate with separator' },
            { name: 'SPLIT_PART', sig: 'SPLIT_PART(string, delimiter, field)', doc: 'Split string and return part' },
            { name: 'POSITION', sig: 'POSITION(substring IN string)', doc: 'Position of substring' },
            { name: 'LPAD', sig: 'LPAD(string, length, fill)', doc: 'Left pad string' },
            { name: 'RPAD', sig: 'RPAD(string, length, fill)', doc: 'Right pad string' },
            { name: 'INITCAP', sig: 'INITCAP(string)', doc: 'Capitalize first letter of each word' },
            // Math
            { name: 'ABS', sig: 'ABS(n)', doc: 'Absolute value' },
            { name: 'ROUND', sig: 'ROUND(n [, decimals])', doc: 'Round number' },
            { name: 'CEIL', sig: 'CEIL(n)', doc: 'Ceiling' },
            { name: 'FLOOR', sig: 'FLOOR(n)', doc: 'Floor' },
            { name: 'TRUNC', sig: 'TRUNC(n [, decimals])', doc: 'Truncate number' },
            { name: 'MOD', sig: 'MOD(n, m)', doc: 'Modulo' },
            { name: 'POWER', sig: 'POWER(base, exp)', doc: 'Power' },
            { name: 'SQRT', sig: 'SQRT(n)', doc: 'Square root' },
            { name: 'RANDOM', sig: 'RANDOM()', doc: 'Random float 0..1' },
            // Date/time
            { name: 'NOW', sig: 'NOW()', doc: 'Current timestamp with timezone' },
            { name: 'CURRENT_DATE', sig: 'CURRENT_DATE', doc: 'Current date' },
            { name: 'CURRENT_TIME', sig: 'CURRENT_TIME', doc: 'Current time' },
            { name: 'CURRENT_TIMESTAMP', sig: 'CURRENT_TIMESTAMP', doc: 'Current timestamp' },
            { name: 'DATE_TRUNC', sig: "DATE_TRUNC('unit', timestamp)", doc: 'Truncate to unit (year/month/day/hour...)' },
            { name: 'DATE_PART', sig: "DATE_PART('field', source)", doc: 'Extract date part' },
            { name: 'EXTRACT', sig: "EXTRACT(field FROM source)", doc: 'Extract date/time field' },
            { name: 'AGE', sig: 'AGE(timestamp [, timestamp])', doc: 'Difference between timestamps' },
            { name: 'TO_DATE', sig: "TO_DATE(string, format)", doc: 'String to date' },
            { name: 'TO_TIMESTAMP', sig: "TO_TIMESTAMP(string, format)", doc: 'String to timestamp' },
            { name: 'TO_CHAR', sig: "TO_CHAR(value, format)", doc: 'Value to formatted string' },
            // Type conversion
            { name: 'CAST', sig: 'CAST(value AS type)', doc: 'Cast to type' },
            { name: 'TO_NUMBER', sig: "TO_NUMBER(string, format)", doc: 'String to number' },
            // Conditional
            { name: 'COALESCE', sig: 'COALESCE(val1, val2, ...)', doc: 'First non-NULL value' },
            { name: 'NULLIF', sig: 'NULLIF(val1, val2)', doc: 'NULL if values are equal' },
            { name: 'GREATEST', sig: 'GREATEST(val1, val2, ...)', doc: 'Greatest value' },
            { name: 'LEAST', sig: 'LEAST(val1, val2, ...)', doc: 'Least value' },
            // JSON
            { name: 'JSON_BUILD_OBJECT', sig: 'JSON_BUILD_OBJECT(key, value, ...)', doc: 'Build JSON object' },
            { name: 'JSONB_BUILD_OBJECT', sig: 'JSONB_BUILD_OBJECT(key, value, ...)', doc: 'Build JSONB object' },
            { name: 'JSON_EXTRACT_PATH', sig: 'JSON_EXTRACT_PATH(json, path...)', doc: 'Extract JSON path' },
            { name: 'JSONB_EXTRACT_PATH', sig: 'JSONB_EXTRACT_PATH(jsonb, path...)', doc: 'Extract JSONB path' },
            // Window
            { name: 'ROW_NUMBER', sig: 'ROW_NUMBER() OVER (...)', doc: 'Sequential row number in partition' },
            { name: 'RANK', sig: 'RANK() OVER (...)', doc: 'Rank with gaps' },
            { name: 'DENSE_RANK', sig: 'DENSE_RANK() OVER (...)', doc: 'Rank without gaps' },
            { name: 'NTILE', sig: 'NTILE(n) OVER (...)', doc: 'Divide into n buckets' },
            { name: 'LAG', sig: 'LAG(expr [, offset [, default]]) OVER (...)', doc: 'Value from previous row' },
            { name: 'LEAD', sig: 'LEAD(expr [, offset [, default]]) OVER (...)', doc: 'Value from next row' },
            { name: 'FIRST_VALUE', sig: 'FIRST_VALUE(expr) OVER (...)', doc: 'First value in window' },
            { name: 'LAST_VALUE', sig: 'LAST_VALUE(expr) OVER (...)', doc: 'Last value in window' },
            { name: 'OVER', sig: 'OVER (PARTITION BY ... ORDER BY ...)', doc: 'Window function clause' },
            // Array
            { name: 'ARRAY_LENGTH', sig: 'ARRAY_LENGTH(array, dim)', doc: 'Array length' },
            { name: 'UNNEST', sig: 'UNNEST(array)', doc: 'Expand array to rows' },
            { name: 'ANY', sig: 'ANY(array)', doc: 'True if any element matches' },
            { name: 'ALL', sig: 'ALL(array)', doc: 'True if all elements match' },
            // Misc
            { name: 'GEN_RANDOM_UUID', sig: 'GEN_RANDOM_UUID()', doc: 'Generate UUID v4' },
            { name: 'MD5', sig: 'MD5(string)', doc: 'MD5 hash' },
            { name: 'ENCODE', sig: "ENCODE(data, format)", doc: 'Encode binary data (hex/base64/escape)' },
            { name: 'DECODE', sig: "DECODE(string, format)", doc: 'Decode binary data' },
            { name: 'PG_SLEEP', sig: 'PG_SLEEP(seconds)', doc: 'Sleep for given seconds' },
            { name: 'FORMAT', sig: "FORMAT(formatstr, ...)", doc: 'Format string (like sprintf)' },
        ];
        return functions
            .filter(f => f.name.toLowerCase().startsWith(prefix.toLowerCase()))
            .map(f => {
            const item = new vscode.CompletionItem(f.name, vscode.CompletionItemKind.Function);
            item.detail = f.sig;
            item.documentation = new vscode.MarkdownString(`**${f.sig}**\n\n${f.doc}`);
            item.insertText = new vscode.SnippetString(f.name + '($0)');
            item.sortText = '6' + f.name;
            return item;
        });
    }
    // ── Public refresh ────────────────────────────────────────────────────────
    async refresh() {
        this.cache.clear();
        await this.cache.refresh();
    }
}
exports.SQLCompletionProvider = SQLCompletionProvider;
//# sourceMappingURL=sqlCompletionProvider.js.map