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
exports.SQLHoverProvider = void 0;
const vscode = __importStar(require("vscode"));
class SQLHoverProvider {
    provideHover(document, position, token) {
        const range = document.getWordRangeAtPosition(position);
        const word = document.getText(range);
        const sqlKeywords = {
            'SELECT': 'Retrieves data from a table',
            'INSERT': 'Adds new rows to a table',
            'UPDATE': 'Modifies existing rows in a table',
            'DELETE': 'Removes rows from a table',
            'CREATE': 'Creates a new database object',
            'ALTER': 'Modifies an existing database object',
            'DROP': 'Deletes a database object',
            'WHERE': 'Specifies conditions for rows to be returned',
            'JOIN': 'Combines rows from two or more tables',
            'GROUP': 'Groups rows by one or more columns',
            'ORDER': 'Sorts the result set',
            'LIMIT': 'Limits the number of rows returned',
            'DISTINCT': 'Removes duplicate rows',
            'UNION': 'Combines results from multiple queries',
        };
        if (sqlKeywords[word.toUpperCase()]) {
            return new vscode.Hover(sqlKeywords[word.toUpperCase()]);
        }
        return null;
    }
}
exports.SQLHoverProvider = SQLHoverProvider;
//# sourceMappingURL=sqlHoverProvider.js.map