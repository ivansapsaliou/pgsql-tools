# PostgreSQL Tools

A VS Code extension for managing PostgreSQL databases — query execution, schema introspection, ER diagrams, schema diff, and database health diagnostics.

## Features

- 🔌 **Connection Management**: Easy connection to PostgreSQL databases
- 📦 **Database Explorer**: Browse databases, schemas, and tables
- 🔍 **SQL Query Execution**: Execute SQL queries and view results in the interactive Results Panel
- 💾 **Connection Persistence**: Save connection configurations securely
- 🔀 **Schema Diff**: Compare schemas between two databases or two schemas in the same DB
- 🗺️ **ER Diagram**: Visualise table relationships as an ER diagram (with Mermaid export)
- 🏥 **Health Diagnostics**: Slow queries, locks, table sizes, vacuum recommendations
- ⚡ **Explain Query**: Run `EXPLAIN [ANALYZE] [BUFFERS]` and visualise the query plan

## Installation

1. Clone the repository
2. Run `npm install` to install dependencies
3. Press `F5` to launch the extension in development mode

## Usage

### Add a Connection
1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Type **PostgreSQL: Add Connection**
3. Fill in your connection details and click **Connect**

### View Database Structure
- Expand connections in the **PostgreSQL Databases** sidebar
- Navigate through schemas and tables

### Execute Queries
- Open a `.sql` file and press `Ctrl+Shift+E` / `Cmd+Shift+E` to execute
- Or use **PostgreSQL: Execute SQL File** from the Command Palette
- Results appear in the **Query Results** panel at the bottom

---

## Schema Introspection & Generation

### Schema Diff
**Command**: `PostgreSQL: Schema Diff…`  
Compare schema objects (tables, columns, indexes, constraints, enums, views) and see what was added, removed, or changed.

Two modes:
- **DB vs DB** — pick two active connections and a schema name to compare across databases
- **Schema vs Schema** — pick one connection, then two schema names within the same database

Results display in the Results Panel as a colour-coded diff table.

### ER Diagram
**Command**: `PostgreSQL: Show ER Diagram`  
Generates an ER diagram from foreign-key relationships in the selected schema.

1. Pick a connection
2. Pick a schema (defaults to `public`)
3. The Results Panel shows:
   - Visual table cards with columns (PK/FK badges) and FK references
   - Mermaid diagram code you can copy and open at [mermaid.live](https://mermaid.live)

---

## Health / Diagnostics

All commands show results in the Results Panel.

### Slow Queries
**Command**: `PostgreSQL: Health — Slow Queries`  
Requires the `pg_stat_statements` extension. Shows the top N queries by mean execution time.  
If the extension is not installed, the panel shows instructions on how to enable it.

### Locks
**Command**: `PostgreSQL: Health — Locks`  
Shows blocking/waiting processes — blocked PID, blocking PID, queries, and how long the block has been active.

### Table & Index Sizes
**Command**: `PostgreSQL: Health — Table & Index Sizes`  
Shows total, table-only, and index-only sizes for the largest tables (configurable limit).

### Vacuum / Analyze Recommendations
**Command**: `PostgreSQL: Health — Vacuum / Analyze`  
Based on `pg_stat_user_tables` statistics, flags tables that need `VACUUM` or `ANALYZE`.

---

## Explain Query
**Command**: `PostgreSQL: Explain Query`  
**Keyboard shortcut**: `Ctrl+Shift+X` / `Cmd+Shift+X` (when SQL editor is focused)

1. Select SQL in the active editor, or enter it in the prompt
2. Choose **EXPLAIN only** or **EXPLAIN ANALYZE**
3. Optionally add **BUFFERS** statistics
4. The Results Panel shows:
   - The query plan as an expandable tree (Node Type, estimated/actual cost, rows)
   - The raw JSON plan for detailed inspection

---

## Toolbar Buttons

New buttons are added to the **PostgreSQL Tools** sidebar panel headers:

| View | Button |
|------|--------|
| Connections | $(diff) Schema Diff, $(type-hierarchy) ER Diagram |
| Database Objects | $(diff) Schema Diff, $(type-hierarchy) ER Diagram |

Right-click on a connection to access **Show ER Diagram** and **Schema Diff** context actions.

---

## Configuration

Connection details are securely stored in VS Code's global state. Passwords are kept in VS Code's SecretStorage.

## Requirements

- VS Code 1.75.0 or higher
- PostgreSQL 9.5 or higher
- For slow query diagnostics: `pg_stat_statements` extension must be enabled in PostgreSQL

## License

MIT
