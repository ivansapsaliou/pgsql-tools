# PostgreSQL Tools

A VS Code extension and CLI for managing PostgreSQL databases.

## Features

- 🔌 **Connection Management**: Easy connection to PostgreSQL databases
- 📦 **Database Explorer**: Browse databases, schemas, and tables
- 🔍 **SQL Query Execution**: Execute SQL queries and view results
- 💾 **Connection Persistence**: Save connection configurations
- 🆕 **CLI**: Introspection, diagnostics, and health commands (see below)

## Installation

1. Clone the repository
2. Run `npm install` to install dependencies
3. Press `F5` to launch the extension in development mode

---

## CLI Usage

After building the project (`npm run compile`), you can use `pgsql-tools` as a CLI tool.
All commands accept a PostgreSQL connection URL via `--db` (or the `DATABASE_URL` environment variable).

```
pgsql-tools [command] [options]
```

### Connection URL format

```
postgresql://user:password@host:5432/dbname
```

---

### `schema diff` — Compare two schemas or databases

Compare tables, columns, indexes, constraints, enums, and views between two schemas or two databases.

```bash
# Compare public schema in two different databases
pgsql-tools schema diff \
  --db1 postgresql://user:pass@host1/db \
  --db2 postgresql://user:pass@host2/db

# Compare two schemas within the same database
pgsql-tools schema diff \
  --db1 postgresql://user:pass@host/db \
  --schema1 public \
  --schema2 staging

# Output diff as JSON (useful for CI)
pgsql-tools schema diff --db1 $DB1_URL --db2 $DB2_URL --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--db1 <url>` | Connection URL for the first database *(required)* |
| `--db2 <url>` | Connection URL for the second database (defaults to db1) |
| `--schema1 <name>` | Schema name in db1 (default: `public`) |
| `--schema2 <name>` | Schema name in db2 (default: same as `--schema1`) |
| `--json` | Output diff as JSON for CI pipelines |

---

### `schema erd` — Export an ER diagram

Generate an ER diagram of your database schema in Mermaid (default) or Graphviz DOT format.

```bash
# Print Mermaid ERD to stdout
pgsql-tools schema erd --db postgresql://user:pass@host/db

# Save Mermaid ERD to a file
pgsql-tools schema erd --db $DATABASE_URL --out diagram.mmd

# Generate Graphviz DOT output
pgsql-tools schema erd --db $DATABASE_URL --format dot --out diagram.dot

# Diagram a specific schema
pgsql-tools schema erd --db $DATABASE_URL --schema myschema
```

**Options:**

| Flag | Description |
|------|-------------|
| `--db <url>` | PostgreSQL connection URL *(required)* |
| `--schema <name>` | Schema to diagram (default: `public`) |
| `--format <fmt>` | Output format: `mermaid` or `dot` (default: `mermaid`) |
| `--out <file>` | Write output to a file instead of stdout |

---

### `health slow-queries` — Slow query analysis

Show the slowest queries from `pg_stat_statements`. Checks that the extension is installed and gives a helpful error if not.

```bash
pgsql-tools health slow-queries --db $DATABASE_URL

# Show top 10 queries with mean time > 100ms
pgsql-tools health slow-queries --db $DATABASE_URL --limit 10 --min-mean-ms 100

# Output as JSON for CI
pgsql-tools health slow-queries --db $DATABASE_URL --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--db <url>` | PostgreSQL connection URL *(required)* |
| `--limit <n>` | Number of queries to show (default: `20`) |
| `--min-mean-ms <ms>` | Minimum mean execution time filter |
| `--min-total-ms <ms>` | Minimum total execution time filter |
| `--json` | Output as JSON |

---

### `health locks` — Lock conflict detection

Show currently blocked/blocking processes, wait duration, and query text.

```bash
pgsql-tools health locks --db $DATABASE_URL

# JSON output
pgsql-tools health locks --db $DATABASE_URL --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--db <url>` | PostgreSQL connection URL *(required)* |
| `--json` | Output as JSON |

---

### `health sizes` — Table and index sizes

Show table sizes sorted by total size, including approximate bloat (dead tuple ratio).

```bash
pgsql-tools health sizes --db $DATABASE_URL

# Top 10 tables in a specific schema
pgsql-tools health sizes --db $DATABASE_URL --limit 10 --schema public

# JSON output
pgsql-tools health sizes --db $DATABASE_URL --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--db <url>` | PostgreSQL connection URL *(required)* |
| `--limit <n>` | Number of tables to show (default: `20`) |
| `--schema <name>` | Filter by schema |
| `--json` | Output as JSON |

---

### `health vacuum` — Vacuum/Analyze recommendations

Identify tables that need VACUUM or ANALYZE based on dead tuple counts and unanalyzed modifications from `pg_stat_user_tables`.

```bash
pgsql-tools health vacuum --db $DATABASE_URL

# JSON output
pgsql-tools health vacuum --db $DATABASE_URL --json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--db <url>` | PostgreSQL connection URL *(required)* |
| `--limit <n>` | Number of tables to show (default: `20`) |
| `--schema <name>` | Filter by schema |
| `--json` | Output as JSON |

---

### `explain` — EXPLAIN a SQL query

Run `EXPLAIN` (or `EXPLAIN ANALYZE BUFFERS`) on any SQL statement and display a formatted query plan.

```bash
# Basic explain
pgsql-tools explain "SELECT * FROM users WHERE id = 1" --db $DATABASE_URL

# Explain with ANALYZE (executes the query)
pgsql-tools explain "SELECT * FROM orders" --db $DATABASE_URL --analyze

# Explain with ANALYZE and BUFFERS
pgsql-tools explain "SELECT * FROM orders" --db $DATABASE_URL --analyze --buffers

# JSON output (useful for tooling/CI)
pgsql-tools explain "SELECT * FROM orders" --db $DATABASE_URL --format json
```

**Options:**

| Flag | Description |
|------|-------------|
| `--db <url>` | PostgreSQL connection URL *(required)* |
| `--analyze` | Include `ANALYZE` (actually runs the query) |
| `--buffers` | Include `BUFFERS` info (requires `--analyze`) |
| `--format <fmt>` | Output format: `text` or `json` (default: `text`) |

---

## VS Code Extension Usage

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
