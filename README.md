<div align="center">

<a href="https://github.com/sagaryeole/PG-Studio">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <img src="docs/assets/wordmark-light.svg" alt="PG Studio" width="420">
  </picture>
</a>

### A fast, read-only PostgreSQL browser that runs on your machine.

Browse tables and views, filter and sort, follow foreign keys, and read table structure in a clean local web UI.<br>
The browser never sends SQL, and every query runs in a read-only transaction with a timeout.

[![CI](https://github.com/sagaryeole/PG-Studio/actions/workflows/ci.yml/badge.svg)](https://github.com/sagaryeole/PG-Studio/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-2f6496.svg)](LICENSE)
[![PostgreSQL 14–17](https://img.shields.io/badge/PostgreSQL-14%E2%80%9317-336791?logo=postgresql&logoColor=white)](#requirements)
[![Node.js ≥ 20.6](https://img.shields.io/badge/node-%E2%89%A520.6-339933?logo=node.js&logoColor=white)](#requirements)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[**Quick start**](#quick-start) · [Features](#features) · [Security](#security) · [API](docs/API.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md)

<br>

<img src="docs/assets/demo.gif" alt="PG Studio demo: jump to a table with Cmd+K, build OR filters and preview their SQL, open a row in the side panel, read a function's source, switch to another database, dark mode" width="900">

</div>

---

## Why PG Studio?

Most PostgreSQL GUIs are full IDEs: connection managers, SQL editors, schema designers. That's great for database work, but heavy when you just want to **look at your data**. Sometimes you also want a tool that **can't** change anything.

PG Studio does one job: it lets you browse a PostgreSQL database quickly and safely.

- **Read-only by design.** No SQL console, no write routes. Every query runs in a `READ ONLY` transaction that always rolls back, and the docs walk you through a SELECT-only role, which is the real guarantee.
- **Local only.** It binds to `127.0.0.1`, checks the `Host` header against DNS rebinding, and sends a strict Content Security Policy. Nothing leaves your machine.
- **Fast on big tables.** Keyset pagination makes page 9,000 as quick as page 1 (6 ms vs 1.2 s with `OFFSET` on a 1M-row table).
- **Small and auditable.** About 2,200 lines of strict TypeScript on the server and a framework-free front end with no build step. Runtime dependencies: `express`, plus `pg` and `pg-connection-string` from node-postgres.

## Features

| | |
|---|---|
| **Saved connections** | Name your servers in `connections.json` and switch between them from the top bar. Credentials stay on the server; the browser only sees names. |
| **Every database on a server** | A database switcher lists each database the role may connect to, with its size. Each gets its own small pool, opened on first use. |
| **Functions and procedures** | Browse functions, procedures and aggregates next to tables: signature, return type, language, volatility, `SECURITY DEFINER`, owner, full source, and the triggers that call them. View only; nothing is ever executed. |
| **⌘K jump anywhere** | Fuzzy search across every schema's tables, views and functions. Recently opened tables come first. |
| **Filter panel** | Stack up to 10 conditions (`=` `≠` `<` `≤` `>` `≥`, contains, starts/ends with, empty / has a value), match **all** or **any**, switch one off without deleting it, and preview the exact `SELECT` (read-only, copyable). Press `f` to open it; applied filters stay visible as chips. |
| **Sort and filter from the header** | Each column header menu sorts, filters, or keeps only rows with / without a value. |
| **Full-text-ish search** | Press `/` to search across a table's text and enum columns. |
| **Row inspector** | Click any cell to see its full value (JSON pretty-printed) and every field of that row, so wide tables stay readable. |
| **Foreign-key navigation** | The ↗ in an FK cell opens the referenced row. The inspector also lists the rows that point *to* this one. Composite and cross-schema keys work, and browser Back returns you to where you were. |
| **Structure tab** | Sizes, row stats, last vacuum/analyze, columns with defaults and comments, indexes with size and usage, constraints, relationships, triggers, and a `CREATE` script rebuilt from the catalog. |
| **Keyset paging** | Pages are fetched by primary key, so deep pages are fast. Custom sorts fall back to `OFFSET`. |
| **Export** | Download the current view (sort, filters, search) as CSV or JSON, up to 10,000 rows by default. CSV is protected against spreadsheet formula injection. |
| **Shareable URLs** | The URL holds connection, database, schema, table, page, sort, filters, search and tab, so you can bookmark or share a view. |
| **Tables, views, materialized views** | Pick a schema from the top bar. Tables, views, functions and procedures are listed separately in the sidebar. |
| **Column controls** | Resize, hide, and freeze the first column. Settings are remembered per table. |
| **Keyboard first** | Arrow keys move between cells, Enter opens the row, ⌘C copies a cell, `[` `]` page, `?` lists every shortcut. |
| **Light and dark mode** | Follows your OS setting. |

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshot-filters.png" alt="Filter panel with three conditions, match any, and the SQL preview"><br><sub><b>Filter panel</b>: all / any, on-off conditions, SQL preview</sub></td>
    <td width="50%"><img src="docs/assets/screenshot-inspector.png" alt="Row inspector showing pretty-printed JSONB and foreign-key links"><br><sub><b>Row inspector</b>: JSONB, outgoing and incoming foreign keys</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/screenshot-structure.png" alt="Structure tab with sizes, stats, columns and indexes"><br><sub><b>Structure tab</b>: sizes, stats, indexes, constraints, DDL</sub></td>
    <td width="50%"><img src="docs/assets/screenshot-jump.png" alt="Cmd+K jump dialog listing tables and functions"><br><sub><b>⌘K</b> jump to any table or function in any schema</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/screenshot-dark.png" alt="PG Studio in dark mode"><br><sub><b>Dark mode</b></sub></td>
    <td width="50%"><img src="docs/assets/screenshot-home.png" alt="Start page listing the largest tables"><br><sub><b>Start page</b> with the largest and recent tables</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/screenshot-functions.png" alt="A plpgsql function with its signature, flags and source"><br><sub><b>Functions and procedures</b>: signature, flags and source</sub></td>
    <td width="50%"><img src="docs/assets/screenshot-databases.png" alt="Database menu listing analytics, bookshop and postgres with sizes"><br><sub><b>Connection / database / schema</b> switcher</sub></td>
  </tr>
</table>

<sub>Screenshots use the bundled demo database. All data is generated.</sub>

## Quick start

### Requirements

- **Node.js 20.6+**, or Docker
- **PostgreSQL 14 or newer** (CI tests 14, 15, 16 and 17)
- A modern browser

### Run it with one command

```bash
npx @sagaryeole/pg-studio postgres://pgstudio_ro@127.0.0.1:5432/mydb --open
```

or install it once (`npm install -g @sagaryeole/pg-studio`) and run `pg-studio`. Use a [read-only role](#use-it-with-your-own-database), and keep the password out of the command line: other users on the machine can see it. Put it in [`~/.pgpass`](https://www.postgresql.org/docs/current/libpq-pgpass.html) or `PGPASSWORD`, or use a [connections file](#several-servers-or-databases).

| Option | |
|---|---|
| `[url]`, `-u, --url` | Connection string (same as `DATABASE_URL`) |
| `-c, --connections <file>` | Saved connections file (default `./connections.json`) |
| `-p, --port <n>` | Port on 127.0.0.1 (default 4321) |
| `-s, --schema <name>` | Schema to open first |
| `-e, --env-file <file>` | Load settings from an env file (Node 20.12+) |
| `-o, --open` | Open the browser when ready |

<details>
<summary><b>Docker</b></summary>

```bash
docker run --rm -p 127.0.0.1:4321:4321 \
  -e DATABASE_URL=postgres://pgstudio_ro:secret@host.docker.internal:5432/mydb \
  ghcr.io/sagaryeole/pg-studio
```

- **Always publish to `127.0.0.1`** (`-p 127.0.0.1:4321:4321`). PG Studio has no login, and inside the container it has to listen on all interfaces so Docker can forward the port. `-p 4321:4321` would expose it to your network.
- `localhost` inside the container is the container itself. To reach PostgreSQL on your machine use `host.docker.internal` (on Linux add `--add-host=host.docker.internal:host-gateway`), or put both containers on one Docker network and use the service name.
- Saved connections: `-v "$PWD/connections.json:/app/connections.json:ro"`.
- The image runs as a non-root user and has a health check.

</details>

### Try it with the demo database (30 seconds)

Needs Docker (or Colima / OrbStack / Podman with compose).

```bash
git clone https://github.com/sagaryeole/PG-Studio.git
cd PG-Studio
npm install
npm run demo:db     # starts PostgreSQL on 127.0.0.1:55432 with ~430k rows of fake bookshop data
npm run demo        # PG Studio on http://127.0.0.1:4321
```

Open **http://127.0.0.1:4321**. When you're done, `npm run demo:down` removes the container and its data.

### Use it with your own database

**1. Create a read-only role.** Do this first. The app opens every query in a `READ ONLY` transaction, but that's a guard rail, not a security boundary: a multi-statement string such as `COMMIT; DELETE ...` gets past it. The role's grants are the real guarantee.

```sql
-- run as an admin, in the target database
CREATE ROLE pgstudio_ro LOGIN PASSWORD 'pick-a-strong-one';
GRANT CONNECT ON DATABASE mydb TO pgstudio_ro;
GRANT USAGE ON SCHEMA public TO pgstudio_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pgstudio_ro;
-- also cover tables created later by the owning role:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO pgstudio_ro;
```

If the configured role can write, the server prints a warning at startup and the UI badge turns red.

**2. Configure and start.**

```bash
cp .env.example .env      # then edit DATABASE_URL
npm install
npm run dev               # watch mode
# or
npm run build && npm start
```

Open **http://127.0.0.1:4321**.

<details>
<summary><b>PostgreSQL in Docker or Colima?</b></summary>

Run the SQL inside the container:

```bash
colima start                                   # if you use Colima
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker start <container>
docker exec <container> env | grep -E 'POSTGRES_(USER|DB)'   # prints the admin user and database name, not the password
docker exec -it <container> psql -U <POSTGRES_USER> -d <POSTGRES_DB>
```

Note the host port in the `Ports` column (for example `0.0.0.0:5433->5432` means port 5433) and use it in `DATABASE_URL`.

</details>

> [!TIP]
> Point PG Studio at a local or dev database while you try it. Keep production credentials out of `.env` files you share and out of AI chats.

### Configuration

All configuration is through environment variables (`.env`):

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | (required unless `connections.json` exists) | Never logged. Error messages are redacted. Use `127.0.0.1`, not `localhost`: `localhost` makes Node try IPv6 (`::1`) first, which fails against some Docker setups. |
| `PORT` | `4321` | Always bound to `127.0.0.1`. The host isn't configurable, on purpose. |
| `CONNECTIONS_FILE` | `connections.json` | Saved connections; see [Several servers or databases](#several-servers-or-databases). |
| `DATABASE_LABEL` | `Default` | Name shown for the `DATABASE_URL` connection. |
| `PG_SCHEMA` | `public` | Schema shown first (a connection's `"schema"` overrides it). Any schema the role has `USAGE` on can be picked from the top bar. |
| `STATEMENT_TIMEOUT_MS` | `5000` | Per-query timeout, so a slow query can't tie up the database. Exports use it too. |
| `EXPORT_MAX_ROWS` | `10000` | Max rows in one CSV/JSON export (max 100,000). |
| `PG_STUDIO_CONTAINER` | (unset) | Set by the official Docker image only: listen on all interfaces inside the container and accept any published port on `127.0.0.1`/`localhost`. Don't set it anywhere else. |

### Several servers or databases

**Databases on the same server** need nothing extra: pick one from the database menu in the top bar. The list shows every database the role may `CONNECT` to. Grants are per database, so run the read-only role's `GRANT` lines in each database you want to browse.

**Several servers, or friendlier names:** list them in `connections.json` next to the app (or point `CONNECTIONS_FILE` at another path), then restart:

```json
[
  { "name": "Local dev", "url": "postgres://pgstudio_ro@127.0.0.1:5432/myapp" },
  { "name": "Staging", "url": "postgres://readonly@staging-db:5432/myapp?sslmode=verify-full", "schema": "public" }
]
```

- `connections.json` is gitignored. Start from [`connections.example.json`](connections.example.json).
- Leave the password out of the URL and put it in [`~/.pgpass`](https://www.postgresql.org/docs/current/libpq-pgpass.html) instead; node-postgres reads it. If a URL does contain a password, the server warns until the file is `chmod 600`.
- `DATABASE_URL` still works and is listed first, as "Default" (rename it with `DATABASE_LABEL`).
- Every connection gets the same startup check: if its role can write, the server warns and the badge turns red while it's selected.

### Troubleshooting

The server prints the cause at startup (`[db] startup check failed: …`) and the UI shows the same error when a request fails.

| Message | Cause | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:5432` | Nothing is listening on that host and port | Start PostgreSQL or the container (`colima start`, `docker start …`). Check the port with `lsof -nP -iTCP -sTCP:LISTEN \| grep -i postgres`. |
| `password authentication failed` | Wrong password, or the role doesn't exist | Create the role (step 1) and fix `.env`. |
| `database "…" does not exist` | Wrong database name in `DATABASE_URL` | Fix the name. |
| Tables list is empty | Role has no SELECT grants, or the tables are in another schema | Re-run the `GRANT` lines, or set `PG_SCHEMA`. |
| Red "role can write" badge | The configured role can modify data | Switch `DATABASE_URL` to the SELECT-only role. |
| Page looks stale after a code change | Browser cache | Hard refresh (⌘⇧R / Ctrl+Shift+R). |

## Keyboard shortcuts

| Key | Action |
|---|---|
| <kbd>⌘</kbd> <kbd>K</kbd> / <kbd>Ctrl</kbd> <kbd>K</kbd> | Jump to a table or view |
| <kbd>/</kbd> | Search the open table |
| <kbd>F</kbd> | Open or close the filter panel (<kbd>Enter</kbd> applies) |
| <kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd> | Move between cells |
| <kbd>Enter</kbd> | Open the row in the side panel |
| <kbd>⌘</kbd> <kbd>C</kbd> | Copy the selected cell |
| <kbd>[</kbd> <kbd>]</kbd> | Previous / next page |
| <kbd>Esc</kbd> | Close panels and menus |
| <kbd>?</kbd> | Show all shortcuts |

## Security

PG Studio is built to be safe to point at a real database:

- **No SQL from the browser.** No endpoint accepts SQL. Table and column names are resolved against `pg_catalog` and quoted with `pg.escapeIdentifier`; operators come from a fixed list; every value is a bind parameter.
- **Read-only twice over.** `BEGIN READ ONLY` plus a mandatory `ROLLBACK`, *and* a SELECT-only role (the real boundary).
- **Bounded reads.** Page size ≤ 100, cells cut to 5,000 characters inside PostgreSQL, a per-query `statement_timeout`, and capped exports.
- **Localhost hardening.** Binds to `127.0.0.1` (in the Docker image, publish with `-p 127.0.0.1:…`), `Host` header allow-list against DNS rebinding, same-origin guard for any future writes, and a strict CSP with no inline script or style.
- **XSS-safe rendering.** Every database value is rendered with `textContent`.
- **No credential leaks.** Connection strings are redacted from logs and error messages, and never sent to the browser: it picks a saved connection by id, and only databases the role may `CONNECT` to can be opened.

Each control was tested against a hostile input (`x"; DROP TABLE users;--` table names, `' OR '1'='1` filters, `<img onerror>` in JSONB, `Host: evil.example`, and more). See the full **[security model and test matrix](SECURITY.md#security-model)**. To report a vulnerability, follow [SECURITY.md](SECURITY.md).

## How it compares

PG Studio isn't a replacement for a full database IDE. It's the small, safe tool you keep open next to one.

| | PG Studio | pgAdmin | DBeaver / DataGrip | TablePlus |
|---|---|---|---|---|
| Focus | Browsing data | Administration | Full SQL IDE | Native GUI client |
| Writes or SQL editor | No (by design) | Yes | Yes | Yes |
| Install | `npm install` | Desktop or server | Desktop (Java) | Desktop |
| Runs in | Your browser, on localhost | Desktop or web | Desktop | Desktop |
| License | Apache 2.0 | PostgreSQL | Apache 2 / commercial | Commercial |
| Size of codebase to audit | ~5.8k lines | Large | Large | Closed source |

For running ad-hoc SQL, managing roles or designing schemas, use one of the others.

## Documentation

| Document | What's in it |
|---|---|
| [docs/API.md](docs/API.md) | HTTP API: endpoints, view parameters, keyset and offset paging |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Code layout, request flow, design decisions, known limitations |
| [docs/EDIT-MODE.md](docs/EDIT-MODE.md) | Design for opt-in single-cell editing, not yet built |
| [SECURITY.md](SECURITY.md) | Security model, test matrix and how to report a vulnerability |
| [ROADMAP.md](ROADMAP.md) | What's done, what's next, and what's deliberately not planned |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## Tech stack

Node.js 20.6+ · TypeScript (strict) · Express 5 · [`node-postgres`](https://node-postgres.com/) · plain HTML, CSS and JavaScript with no framework and no build step.

## Contributing

Bug reports, ideas and pull requests are welcome. Start with **[CONTRIBUTING.md](CONTRIBUTING.md)**: it covers setup with the demo database, the safety rules every change must keep, and the smoke test.

If PG Studio is useful to you, a ⭐ on GitHub helps other people find it.

## License

[Apache License 2.0](LICENSE). PostgreSQL is a trademark of the PostgreSQL Community Association of Canada; PG Studio isn't affiliated with or endorsed by the PostgreSQL project.
