import * as vscode from 'vscode';

export class SQLHoverProvider implements vscode.HoverProvider {
	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken
	): vscode.ProviderResult<vscode.Hover> {
		const range = document.getWordRangeAtPosition(position);
		const word = document.getText(range);

		const sqlKeywords: { [key: string]: string } = {
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