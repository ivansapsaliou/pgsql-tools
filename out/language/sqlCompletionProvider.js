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
class SQLCompletionProvider {
    constructor(queryExecutor, connectionManager) {
        this.queryExecutor = queryExecutor;
        this.connectionManager = connectionManager;
        this.schemas = [];
        this.tables = new Map();
        this.columns = new Map();
        this.loadSchemaInfo();
    }
    async loadSchemaInfo() {
        try {
            const activeConnection = this.connectionManager.getActiveConnectionName();
            if (!activeConnection) {
                return;
            }
            // Load schemas
            this.schemas = await this.queryExecutor.getSchemata();
            // Load tables for each schema
            for (const schema of this.schemas) {
                const tables = await this.queryExecutor.getTables(schema);
                this.tables.set(schema, tables);
                // Load columns for each table
                for (const table of tables) {
                    const columns = await this.queryExecutor.getColumns(schema, table);
                    const columnNames = columns.map(col => col.column_name);
                    this.columns.set(`${schema}.${table}`, columnNames);
                }
            }
        }
        catch (error) {
            console.error('Failed to load schema info:', error);
        }
    }
    async provideCompletionItems(document, position, token, context) {
        const lineText = document.lineAt(position.line).text;
        const textBefore = lineText.substring(0, position.character);
        const word = this.getWordAt(textBefore);
        const completionItems = [];
        // SQL Keywords
        const keywords = [
            'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP',
            'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS',
            'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
            'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE',
            'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
            'DISTINCT', 'AS', 'WITH', 'UNION', 'INTERSECT', 'EXCEPT',
            'PRIMARY', 'KEY', 'FOREIGN', 'UNIQUE', 'CHECK', 'DEFAULT',
            'NULL', 'TRUE', 'FALSE'
        ];
        // Add keyword completions
        for (const keyword of keywords) {
            if (keyword.toLowerCase().startsWith(word.toLowerCase())) {
                const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
                item.insertText = keyword;
                item.documentation = `SQL Keyword: ${keyword}`;
                completionItems.push(item);
            }
        }
        // Add schema completions
        for (const schema of this.schemas) {
            if (schema.toLowerCase().startsWith(word.toLowerCase())) {
                const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Module);
                item.insertText = schema;
                item.documentation = `Schema: ${schema}`;
                completionItems.push(item);
            }
        }
        // Add table completions
        for (const [schema, tables] of this.tables) {
            for (const table of tables) {
                if (table.toLowerCase().startsWith(word.toLowerCase())) {
                    const item = new vscode.CompletionItem(table, vscode.CompletionItemKind.Struct);
                    item.insertText = table;
                    item.documentation = `Table: ${schema}.${table}`;
                    completionItems.push(item);
                }
            }
        }
        // Add column completions
        for (const [fullName, columns] of this.columns) {
            for (const column of columns) {
                if (column.toLowerCase().startsWith(word.toLowerCase())) {
                    const item = new vscode.CompletionItem(column, vscode.CompletionItemKind.Field);
                    item.insertText = column;
                    item.documentation = `Column: ${fullName}.${column}`;
                    completionItems.push(item);
                }
            }
        }
        // Add functions
        const functions = [
            { name: 'COUNT', detail: 'COUNT(*)' },
            { name: 'SUM', detail: 'SUM(column)' },
            { name: 'AVG', detail: 'AVG(column)' },
            { name: 'MIN', detail: 'MIN(column)' },
            { name: 'MAX', detail: 'MAX(column)' },
            { name: 'COALESCE', detail: 'COALESCE(val1, val2)' },
            { name: 'CAST', detail: 'CAST(value AS type)' },
            { name: 'SUBSTRING', detail: 'SUBSTRING(string, start, length)' },
            { name: 'LENGTH', detail: 'LENGTH(string)' },
            { name: 'UPPER', detail: 'UPPER(string)' },
            { name: 'LOWER', detail: 'LOWER(string)' },
            { name: 'TRIM', detail: 'TRIM(string)' },
            { name: 'NOW', detail: 'NOW()' },
            { name: 'DATE', detail: 'DATE(timestamp)' },
        ];
        for (const func of functions) {
            if (func.name.toLowerCase().startsWith(word.toLowerCase())) {
                const item = new vscode.CompletionItem(func.name, vscode.CompletionItemKind.Function);
                item.insertText = func.name + '(';
                item.documentation = func.detail;
                completionItems.push(item);
            }
        }
        return completionItems;
    }
    resolveCompletionItem(item) {
        return item;
    }
    getWordAt(text) {
        const match = text.match(/[\w_]*$/);
        return match ? match[0] : '';
    }
    async refresh() {
        this.schemas = [];
        this.tables.clear();
        this.columns.clear();
        await this.loadSchemaInfo();
    }
}
exports.SQLCompletionProvider = SQLCompletionProvider;
//# sourceMappingURL=sqlCompletionProvider.js.map