# PostgreSQL Tools (VS Code Extension)

## Русский

**PostgreSQL Tools** — расширение для VS Code для работы с PostgreSQL: подключения, обозреватель объектов, выполнение SQL, ER-диаграмма, сравнение схем, диагностика и `EXPLAIN`.

### Возможности

- **Подключения**: создание/выбор/подключение/отключение и удаление подключений
- **Дерево БД**: базы/схемы/таблицы/представления/функции/процедуры в панели **PostgreSQL Tools**
- **Выполнение SQL**: запуск SQL из редактора и просмотр результатов в панели **Query Results**
- **ER Diagram**: визуализация связей по внешним ключам + экспорт Mermaid
- **Schema Diff**: сравнение схем (БД vs БД или схема vs схема)
- **Health (диагностика)**: медленные запросы, блокировки, размеры таблиц/индексов, рекомендации VACUUM/ANALYZE
- **Explain Query**: `EXPLAIN`/`EXPLAIN ANALYZE` (опционально `BUFFERS`) с визуализацией плана

### Быстрый старт (разработка)

1. Установите **Node.js LTS**
2. В корне проекта:

```bash
npm install
npm run compile
```

3. Нажмите `F5` в VS Code (Extension Development Host)

### Сборка VSIX (для установки)

1. Установите упаковщик:

```bash
npm i -g @vscode/vsce
```

2. В корне проекта:

```bash
npm install
npm run compile
vsce package
```

В результате появится файл `pgsql-tools-<version>.vsix`.

### Использование

#### Добавить подключение

- Откройте палитру команд (`Ctrl+Shift+P`) и выполните **PostgreSQL: Add Connection**

#### Выполнить SQL

- В `.sql` файле:
  - **F9** или **Ctrl+Shift+E** — `PostgreSQL: Execute SQL (F9)`
  - Результаты появятся в панели **Query Results**

#### Explain Query

- В SQL-редакторе: **Ctrl+Shift+X** — `PostgreSQL: Explain Query`

#### Основные команды (палитра команд)

- `PostgreSQL: Add Connection`
- `PostgreSQL: Connect` / `PostgreSQL: Disconnect` / `PostgreSQL: Select Connection`
- `PostgreSQL: Refresh`
- `PostgreSQL: Search in Tree…` / `PostgreSQL: Clear Tree Search`
- `PostgreSQL: Open Query Editor` / `PostgreSQL: Open Query File`
- `PostgreSQL: Schema Diff…`
- `PostgreSQL: Show ER Diagram`
- `PostgreSQL: Database Health` (+ отдельные команды Health)

### Примечания

- **Хранение секретов**: пароль хранится в **VS Code SecretStorage**, остальная конфигурация — в global state VS Code.
- **Slow Queries**: для диагностики медленных запросов нужен модуль PostgreSQL `pg_stat_statements`.

### Требования

- VS Code **1.75.0+**
- PostgreSQL **9.5+**

---

## English

**PostgreSQL Tools** is a VS Code extension for PostgreSQL: connections, object explorer, SQL execution, ER diagram, schema diff, health diagnostics, and `EXPLAIN`.

### Features

- **Connections**: create/select/connect/disconnect and delete connections
- **Database tree**: browse objects in the **PostgreSQL Tools** view
- **Run SQL**: execute SQL from the editor and see results in **Query Results**
- **ER Diagram**: FK-based relationships + Mermaid export
- **Schema Diff**: compare schemas (DB vs DB or schema vs schema)
- **Health**: slow queries, locks, table/index sizes, VACUUM/ANALYZE recommendations
- **Explain Query**: `EXPLAIN` / `EXPLAIN ANALYZE` (optionally `BUFFERS`) with plan visualization

### Quick start (development)

1. Install **Node.js LTS**
2. In the project root:

```bash
npm install
npm run compile
```

3. Press `F5` in VS Code (Extension Development Host)

### Build a VSIX package

1. Install the packager:

```bash
npm i -g @vscode/vsce
```

2. In the project root:

```bash
npm install
npm run compile
vsce package
```

This produces `pgsql-tools-<version>.vsix`.

### Usage

- **Add connection**: Command Palette → **PostgreSQL: Add Connection**
- **Execute SQL**: `F9` or `Ctrl+Shift+E` in a `.sql` file → results in **Query Results**
- **Explain**: `Ctrl+Shift+X` in SQL editor → `PostgreSQL: Explain Query`

### Notes

- **Secrets**: passwords are stored in **VS Code SecretStorage**; other connection data is stored in VS Code global state.
- **Slow queries**: requires PostgreSQL `pg_stat_statements`.

### Requirements

- VS Code **1.75.0+**
- PostgreSQL **9.5+**

## License

MIT
