# PG Studio

A small local PostgreSQL viewer. It lists tables in one schema and shows their rows in a paged grid, with a side panel that displays full cell values.

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
| `PG_SCHEMA` | `public` | The one schema to browse. |
| `STATEMENT_TIMEOUT_MS` | `5000` | Per-query timeout, so a slow query can't tie up the database. |

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
| `GET /api/tables` | Tables the role can SELECT, with planner row estimates |
| `GET /api/tables/:name?page=1&pageSize=50` | Column metadata (type, PK, generated, `canUpdate`), primary key, one page of rows, `hasNext`, truncated-cell list |

No endpoint accepts SQL.

---

## Security model

What is enforced, and how each item was tested:

| Control | Implementation | Verified |
|---|---|---|
| No SQL injection via table name | The name is used only as a bind parameter in a `pg_class` lookup. The identifiers spliced into SQL come from the catalog row and are quoted with `pg.escapeIdentifier`. | A table named `x"; DROP TABLE users;--` opens normally and `users` is still there |
| Column-level permissions | Columns the role can't SELECT are left out. Tables it can't SELECT return 404 and aren't listed. | Revoked table returns 404 |
| Read-only | `BEGIN READ ONLY` + always `ROLLBACK`, **plus** the SELECT-only role | `DELETE` is rejected even as superuser (25006) |
| Bounded reads | `LIMIT` ≤ 100 (fetches n+1 rows to detect a next page), integer-validated `page`, values cut to 5,000 chars inside Postgres | Bad params return 400. Long values are flagged as cut. |
| Timeouts | `statement_timeout` set per transaction | `pg_sleep(2)` is cancelled at 300 ms |
| Network exposure | Listens on `127.0.0.1` only | |
| DNS rebinding | `Host` header must be `127.0.0.1:PORT` or `localhost:PORT` | `Host: evil.example` returns 403 |
| CSRF (ready for edits) | Non-GET requests need a same-site `Origin` and an `x-pg-studio: 1` header | Cross-origin POST returns 403 |
| XSS from data | Every DB value is rendered with `textContent`. Strict CSP: no inline script or style. | `<img onerror=alert(1)>` in jsonb renders as text, no dialog |
| No credential leaks | Connection strings are redacted from logged errors | Logs grepped for the password |

### Known limitations

- **Deep paging is slow on big tables.** `OFFSET 200000` still scans those rows, and the statement timeout stops runaway cases. Keyset pagination (`WHERE pk > last`) would fix it, so that's the first upgrade to make if you browse large tables.
- **Tables without a primary key** are ordered by `ctid` (physical order), so pages can shift while the table changes. The UI warns about this.
- **Row counts are planner estimates** (`reltuples`), shown as `~N`. They are "unknown" until the table has been ANALYZEd. Exact `count(*)` is deliberately not used.
- **Views, materialized views and other schemas** aren't listed yet.
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
  catalog.ts       table/column/PK lookups, role privilege check
  rows.ts          builds the SELECT from catalog metadata
  security.ts      Host check, CSP headers, same-origin guard for writes
  errors.ts        HttpError + safe Postgres error mapping
  routes/read.ts   /meta, /tables, /tables/:name
public/
  index.html, app.js, styles.css
```
