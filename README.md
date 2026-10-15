# PG Studio

A small local PostgreSQL viewer. It lists the tables, views and materialized views in a schema and shows their rows in a paged grid, with a side panel that displays full cell values.

What you can do:

- **Sort** by clicking a column header (ascending, descending, off).
- **Filter** with `+ Filter`: `=`, `≠`, `<`, `≤`, `>`, `≥`, contains, doesn't contain, starts with, ends with, is null, is not null. Filters combine with AND and show as chips; click a chip to edit it.
- **Search** across the table's text and enum columns.
- **Follow foreign keys**: the `→` in a foreign-key cell opens the referenced row. The side panel also lists the tables that reference the selected row ("Referenced by"). Composite keys work. Browser Back returns to where you were.
- **Columns menu**: hide columns, freeze the first visible column, reset. Drag a header's right edge to resize. These settings are remembered per table in this browser.
- **Export** the current view (sort, filters, search) as CSV or JSON, up to 10,000 rows.
- **Side panel**: pretty-printed JSON, byte counts for bytea, timestamps in your local time, copy value or whole row as JSON, "Filter by this value".
- **Schemas**: switch schema in the sidebar. Views and materialized views are listed and labelled. Foreign keys that cross schemas can be followed.
- **Fast paging**: in the default order, pages are fetched by primary key (keyset paging), so page 9,000 is as fast as page 1. With a custom sort it falls back to page numbers.
- **Details tab**: sizes, row stats, last vacuum/analyze, columns with defaults and comments, indexes with size and scan counts, constraints, relationships, triggers, and a DDL script rebuilt from the catalog.
- **Exact count** on demand ("Count rows"), respecting filters and search, bounded by the statement timeout.
- The URL holds the schema, table, page, sort, filters, search and tab, so you can bookmark or share a view.

It is **read-only today**. The code is laid out so that single-cell editing can be added later without touching the read path. See [Edit mode: design for later](#edit-mode-design-for-later).

Stack: Node 20.6+, TypeScript (strict), Express 5, `pg`, plain HTML/CSS/JS front end with no framework and no build step.

---

## Run it

### 1. Create a read-only role (do this first)

The app opens every query in a READ ONLY transaction, but that is a guard rail, not a security boundary. A multi-statement string such as `COMMIT; DELETE ...` gets past it, which was confirmed against a superuser connection during testing. The role's grants are the real guarantee.

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

**Postgres in Docker or Colima (macOS)?** Run the SQL inside the container:

```bash
colima start                                   # if you use Colima
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker start <container>
docker exec <container> env | grep -E 'POSTGRES_(USER|DB)'   # prints the admin user and database name, not the password
docker exec -it <container> psql -U <POSTGRES_USER> -d <POSTGRES_DB>
```

Note the host port in the `Ports` column (for example `0.0.0.0:5433->5432` means port 5433) and use it in `DATABASE_URL`. When you are trying the tool out, point it at a test database and not at your main app's data.

### 2. Configure and start

```bash
cp .env.example .env      # then edit DATABASE_URL
npm install
npm run dev               # watch mode
# or
npm run build && npm start
```

Open **http://127.0.0.1:4321**.

Use a local or dev database while you try it out. Keep production credentials out of `.env` files you share and out of AI chats.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | (required) | Never logged. Error messages are redacted. Use `127.0.0.1`, not `localhost`: `localhost` makes Node try IPv6 (`::1`) first, which fails against some Docker setups. |
| `PORT` | `4321` | Always bound to `127.0.0.1`. The host is not configurable. |
| `PG_SCHEMA` | `public` | Schema shown first. Any schema the role has `USAGE` on can be picked in the sidebar. |
| `STATEMENT_TIMEOUT_MS` | `5000` | Per-query timeout, so a slow query can't tie up the database. Exports use it too. |
| `EXPORT_MAX_ROWS` | `10000` | Max rows in one CSV/JSON export (max 100,000). |

### Troubleshooting

The server prints the cause at startup (`[db] startup check failed: …`) and the UI shows the same error when a request fails.

| Message | Cause | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:5432` | Nothing is listening on that host and port | Start Postgres or the container (`colima start`, `docker start …`). Check the port with `lsof -nP -iTCP -sTCP:LISTEN \| grep -i postgres`. |
| `password authentication failed` | Wrong password, or the role doesn't exist | Create the role (step 1) and fix `.env`. |
| `database "…" does not exist` | Wrong database name in `DATABASE_URL` | Fix the name. |
| Tables list is empty | Role has no SELECT grants, or the tables are in another schema | Re-run the `GRANT` lines, or set `PG_SCHEMA`. |
| Red "role can write" badge | The configured role can modify data | Switch `DATABASE_URL` to the SELECT-only role. |
| Page looks stale after a code change | Browser cache | Hard refresh (Cmd+Shift+R). |

---

## API

| Endpoint | Returns |
|---|---|
| `GET /api/meta` | Schema, connected role and whether it can write, page limits, `capabilities.edit` (false today) |
| `GET /api/schemas` | Schemas the role has `USAGE` on (system schemas left out), with relation counts |
| `GET /api/tables?schema=` | Tables, views and materialized views the role can SELECT, with planner row estimates. 404 for a schema without `USAGE`. |
| `GET /api/tables/:name?page=1&pageSize=50` | Column metadata (type, category, PK, generated, `canUpdate`), primary key, foreign keys both ways, one page of rows, `hasNext`, truncated-cell list |
| `GET /api/tables/:name/details` | Sizes, stats, column defaults and comments, indexes, constraints, triggers, view definition, generated DDL |
| `GET /api/tables/:name/count` | Exact `count(*)` of the current view (filters and search apply) |
| `GET /api/tables/:name/export?format=csv\|json` | The current view as a download, up to `EXPORT_MAX_ROWS`. Headers `X-Export-Rows`, `X-Export-Limit-Hit` and `X-Export-Cut-Cells` report what was included. |

All `/api/tables/:name…` endpoints take `schema` (default `PG_SCHEMA`) and the same view parameters:

| Param | Example | Notes |
|---|---|---|
| `sort`, `dir` | `sort=created_at&dir=desc` | Column must exist. NULLs sort last. The primary key is added as a tiebreaker so paging is stable. |
| `filters` | `[{"c":"status","op":"eq","v":"published"}]` | JSON array, max 10, combined with AND. `op` is one of `eq neq lt lte gt gte contains not_contains starts ends null not_null`. `neq` and `not_contains` include NULL rows. |
| `q` | `q=dogs` | Case-insensitive search over string and enum columns. |
| `after`, `before` | `after=WyIxMDAiXQ` | Keyset cursors (rows endpoint only). Take them from `nextCursor` / `prevCursor` in the previous response. |

**Paging.** The rows response says which mode it used in `paging`:

- `keyset` (default order, table has a primary key, or a table/materialized view without one): pages continue from the last row's key, `WHERE (pk) > (cursor) ORDER BY pk`. Cost doesn't grow with depth. Measured on a 1M-row table: row 900,000 took 6 ms, against 1.2 s with OFFSET, with identical rows. Without a primary key the key is the physical row id (`ctid`); that keeps pages stable but is not faster, because Postgres still sorts the remaining rows.
- `offset` (custom sort, views, partitioned tables without a primary key): `LIMIT/OFFSET` with `page`. A custom sort is usually on an unindexed column, where keyset paging wouldn't help anyway.

A filter value that doesn't fit the column type (for example `abc` for an integer) returns 400 with Postgres's message. Comparing or sorting a type that has no such operator (such as `json`) also returns 400.

No endpoint accepts SQL.

---

## Security model

What is enforced, and how each item was tested:

| Control | Implementation | Verified |
|---|---|---|
| No SQL injection via table name | The name is used only as a bind parameter in a `pg_class` lookup. The identifiers spliced into SQL come from the catalog row and are quoted with `pg.escapeIdentifier`. | A table named `x"; DROP TABLE users;--` opens normally and `users` is still there |
| No SQL injection via sort, filters, search | Column names must match a catalog column, and the catalog's name is what gets quoted. Operators come from a fixed list and map to fixed SQL. Every value is a bind parameter. LIKE wildcards in values are escaped. | Unknown column, unknown operator and `' OR '1'='1` values are rejected or harmless. A column named `col"; drop table users;--` sorts and filters correctly. |
| Spreadsheet formula injection | CSV cells starting with `= + - @` (that aren't plain numbers) are prefixed with `'` | `=HYPERLINK(...)` exports as `'=HYPERLINK(...)`, `-18.5` stays a number |
| Column-level permissions | Columns the role can't SELECT are left out. Tables it can't SELECT return 404 and aren't listed. | Revoked table returns 404 |
| Read-only | `BEGIN READ ONLY` + always `ROLLBACK`, **plus** the SELECT-only role | `DELETE` is rejected even as superuser (25006) |
| Bounded reads | `LIMIT` ≤ 100 (fetches n+1 rows to detect a next page), integer-validated `page`, values cut to 5,000 chars inside Postgres. Exports: ≤ `EXPORT_MAX_ROWS` rows, 100,000 chars per value. | Bad params return 400. Long values are flagged as cut. A 200k-row export stops at 10,000 and says so. |
| Timeouts | `statement_timeout` set per transaction | `pg_sleep(2)` is cancelled at 300 ms |
| Network exposure | Listens on `127.0.0.1` only | |
| DNS rebinding | `Host` header must be `127.0.0.1:PORT` or `localhost:PORT` | `Host: evil.example` returns 403 |
| CSRF (ready for edits) | Non-GET requests need a same-site `Origin` and an `x-pg-studio: 1` header | Cross-origin POST returns 403 |
| XSS from data | Every DB value is rendered with `textContent`. Strict CSP: no inline script or style. | `<img onerror=alert(1)>` in jsonb renders as text, no dialog |
| No credential leaks | Connection strings are redacted from logged errors | Logs grepped for the password |

### Known limitations

- **Deep pages are slow with a custom sort.** Sorting by a column uses OFFSET paging, which reads every earlier row. Default-order paging doesn't have this problem. You can't jump to an arbitrary page number in keyset mode; use filters to narrow down instead.
- **Tables without a primary key** are ordered by `ctid` (physical order), so pages can shift while the table changes. The UI warns about this.
- **Row counts are planner estimates** (`reltuples`), shown as `~N`. They are "unknown" until the table has been ANALYZEd. Exact `count(*)` is deliberately not used. With filters on, no count is shown.
- **Filters and sorting on unindexed columns scan the table.** On big tables that can hit the statement timeout, which returns a clear error.
- **Search only covers text and enum columns.** Use a filter for numbers, dates, UUIDs and JSON.
- **CSV has no NULL marker.** NULL is written as an empty cell. Use JSON export if the difference matters.
- **Views have no fixed order.** Paging a view without a sort can overlap or skip rows; the UI says so.
- **The generated DDL is a reading aid**, not a dump: grants, ownership, sequences and partition definitions are left out. Use `pg_dump --schema-only` for a faithful copy.
- **Foreign tables** (`postgres_fdw` etc.) aren't listed, because browsing them queries the remote server.
- **Every value is shown as Postgres text output.** For example, bytea appears as `\x…` hex and timestamps in the server's timezone.

---

## Edit mode: design for later

Editing reverses this tool's main safety property, so it shouldn't be done by flipping the read-only flag. The plan below keeps the read path exactly as it is and adds a separate, narrow write path.

### Seams already in the code

- `db.ts` has a single `withReadOnly` helper. Add `withWrite` on a **separate pool**.
- `catalog.ts` already returns `primaryKey`, `isGenerated`, `isIdentity` and `canUpdate` (from `has_column_privilege(..., 'UPDATE')`) for each column.
- The `/meta` response includes `capabilities.edit`. The UI reads it.
- `security.ts` already has `requireSameOriginForWrites`, mounted on `/api`.
- Values travel as Postgres text, which is also the input format for every type, so what the grid shows is what an edit sends back.
- The cell inspector panel is meant to become the editor.

### Rules

1. **Opt-in, separate credentials.** Edits are on only when `ENABLE_EDITS=true` **and** `DATABASE_WRITE_URL` is set. That role gets column-level grants for exactly what you want editable:
   `GRANT UPDATE (status, notes) ON public.orders TO pgstudio_rw;`
   The grants are the allow-list, and `canUpdate` will report them.
2. **One row, one column per request.** `PATCH /api/tables/:name/cell` with body `{ key: {pkCol: value…}, column, oldValue, newValue }`. No inserts, deletes, bulk edits or SQL console.
3. **Editable only when** the table has a PK, the column isn't part of the PK, isn't generated, isn't `GENERATED ALWAYS AS IDENTITY`, has `canUpdate` on the write role, and the value shown wasn't truncated.
4. **SQL shape.** Identifiers come from the catalog only. Values are untyped bind parameters, so Postgres infers each one's type from its column and no type names get spliced into SQL:
   ```sql
   UPDATE "schema"."table"
      SET "col" = $1
    WHERE "pk1" = $2 AND "pk2" = $3
      AND "col"::text IS NOT DISTINCT FROM $4   -- optimistic check against what the user saw
   RETURNING "col"::text
   ```
   Run it in a transaction with `statement_timeout`. Commit only when `rowCount === 1`. Zero rows returns **409** ("changed since you loaded it"). Postgres error `22P02` or `22007` returns **400** with the type error.
5. **Audit log.** Append `{ts, table, key, column, old, new}` as one JSON line to a local file. That also gives you undo.
6. **UI.** The inspector becomes a textarea with "Set NULL", Save and Cancel buttons. Save shows old → new before sending. The client sends `x-pg-studio: 1`.
7. **Tests to write first:** no-PK table refused, truncated value refused, concurrent change returns 409, bad type returns 400, cross-origin returns 403, column without grant refused.

---

## Layout

```
src/
  server.ts        Express wiring, static files, startup role check
  config.ts        env parsing
  db.ts            pool + withReadOnly (write pool goes here later)
  catalog.ts       schema/table/column/PK/FK lookups, role privilege check
  details.ts       details tab (sizes, stats, indexes, constraints, triggers, DDL) and exact count
  query.ts         sort/filter/search: validation and WHERE/ORDER BY building
  rows.ts          builds the SELECT; keyset/offset page fetch, export fetch, CSV/JSON output
  security.ts      Host check, CSP headers, same-origin guard for writes
  errors.ts        HttpError + safe Postgres error mapping
  routes/read.ts   /meta, /schemas, /tables, /tables/:name (+ /details, /count, /export)
public/
  index.html, app.js, styles.css
```
