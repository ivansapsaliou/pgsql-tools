# PostgreSQL Tools

A VS Code extension for managing PostgreSQL databases.

## Features

- 🔌 **Connection Management**: Easy connection to PostgreSQL databases
- 📦 **Database Explorer**: Browse databases, schemas, and tables
- 🔍 **SQL Query Execution**: Execute SQL queries and view results
- 💾 **Connection Persistence**: Save connection configurations

## Installation

1. Clone the repository
2. Run `npm install` to install dependencies
3. Press `F5` to launch the extension in development mode

## Usage

### Add a Connection
1. Open the Command Palette (Ctrl+Shift+P or Cmd+Shift+P)
2. Type "PostgreSQL: Add Connection"
3. Fill in your connection details
4. Click "Connect"

### View Database Structure
- Expand connections in the "PostgreSQL Databases" view
- Navigate through schemas and tables

### Execute Queries
1. Open the Command Palette
2. Type "PostgreSQL: Execute Query"
3. Enter your SQL query
4. Click "Execute Query"

## Configuration

Connection details are securely stored in VS Code's global state.

## Requirements

- VS Code 1.75.0 or higher
- PostgreSQL 9.5 or higher

## License

MIT