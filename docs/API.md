# HTTP API

PG Studio's front end talks to a small JSON API under `/api`. It's served on `127.0.0.1` only and has no authentication, so treat it as a local interface, not a public one. **No endpoint accepts SQL.**

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/connections` | Saved connections: `id`, `name`, `user`, `host`, `port`. Never a password or URL. |
| `GET /api/databases?conn=` | Databases on that connection's server the role may `CONNECT` to, with sizes, plus the connection's own (`default`) |
| `GET /api/meta` | Connection id and database, default schema, connected role and whether it can write, page limits, filter operators, `capabilities.edit` (false today) |
| `GET /api/schemas` | Schemas the role has `USAGE` on (system schemas left out), with relation counts |
| `GET /api/tables?schema=` | Tables, views and materialized views the role can SELECT, with planner row estimates. 404 for a schema without `USAGE`. |
| `GET /api/tables/:name?page=1&pageSize=50` | Column metadata (type, category, PK, generated, `canUpdate`), primary key, foreign keys both ways, one page of rows, `hasNext`, truncated-cell list |
| `GET /api/tables/:name/details` | Sizes, stats, column defaults and comments, indexes, constraints, triggers, view definition, generated DDL |
| `GET /api/tables/:name/count` | Exact `count(*)` of the current view (filters and search apply) |
| `GET /api/routines?schema=` | Functions, procedures, aggregates and window functions in the schema (not ones owned by extensions): `oid`, `name`, `kind`, `args`, `returns`, `language` |
| `GET /api/routines/:oid` | One routine: flags (volatility, strict, `SECURITY DEFINER`, leakproof, parallel), owner, comment, `definition` from `pg_get_functiondef` (aggregates get a summary instead), and `usedByTriggers`. 404 unless its schema is readable. |
| `GET /api/tables/:name/export?format=csv\|json` | The current view as a download, up to `EXPORT_MAX_ROWS`. The headers `X-Export-Rows`, `X-Export-Limit-Hit` and `X-Export-Cut-Cells` report what was included. |

Rows are returned as arrays in column order (matching `table.columns`), with every value in PostgreSQL's text output format, or `null`.

## Connection and database

Every endpoint except `/connections` takes `conn` (a connection `id`, default: the first) and `db` (a database name, default: the one in the connection's URL). An unknown connection, or a database the role can't `CONNECT` to, is a 404. Other databases are opened with the connection's own credentials.

## View parameters

All `/api/tables/:name…` endpoints take `schema` (default `PG_SCHEMA`) and the same view parameters:

| Param | Example | Notes |
|---|---|---|
| `sort`, `dir` | `sort=created_at&dir=desc` | The column must exist. NULLs sort last. The primary key is added as a tiebreaker so paging is stable. |
| `filters` | `[{"c":"status","op":"eq","v":"published"}]` | JSON array, max 10, combined with AND. `op` is one of `eq neq lt lte gt gte contains not_contains starts ends null not_null`. `neq` and `not_contains` include NULL rows. |
| `q` | `q=dogs` | Case-insensitive search over string and enum columns. |
| `after`, `before` | `after=WyIxMDAiXQ` | Keyset cursors (rows endpoint only). Take them from `nextCursor` / `prevCursor` in the previous response. |
| `page`, `pageSize` | `page=3&pageSize=100` | `pageSize` ≤ 100. `page` is used in offset mode. |

## Paging

The rows response says which mode it used in `paging`:

- **`keyset`** applies in the default order, on a table with a primary key, or on a table or materialized view without one. Pages continue from the last row's key: `WHERE (pk) > (cursor) ORDER BY pk`, so cost doesn't grow with depth. Measured on a 1M-row table, row 900,000 took **6 ms**, against **1.2 s** with OFFSET, with identical rows. Without a primary key the key is the physical row id (`ctid`). That keeps pages stable but isn't faster, because PostgreSQL still sorts the remaining rows.
- **`offset`** applies to a custom sort, views, and partitioned tables without a primary key. It uses `LIMIT/OFFSET` with `page`. A custom sort is usually on an unindexed column, where keyset paging wouldn't help anyway.

## Errors

Errors come back as `{ "error": "message" }` with a meaningful status:

| Status | When |
|---|---|
| 400 | Bad parameter, unknown column or operator, or a filter value that doesn't fit the column type (for example `abc` for an integer, with PostgreSQL's message). Comparing or sorting a type that has no such operator (such as `json`) also returns 400. |
| 403 | Wrong `Host` header, a cross-origin write, or a permission denied by PostgreSQL |
| 404 | Unknown schema or table, or one the role can't read |
| 502 | Can't reach the database, or authentication failed |
| 504 | The query hit `STATEMENT_TIMEOUT_MS` |

## Examples

```bash
# The 20 most recent delivered orders
curl -G http://127.0.0.1:4321/api/tables/orders \
  --data-urlencode 'filters=[{"c":"status","op":"eq","v":"delivered"}]' \
  --data-urlencode 'sort=placed_at' --data-urlencode 'dir=desc' \
  --data-urlencode 'pageSize=20'

# Exact count of matching rows
curl -G http://127.0.0.1:4321/api/tables/orders/count \
  --data-urlencode 'filters=[{"c":"total_cents","op":"gte","v":"20000"}]'

# Export a table as JSON
curl -OJ 'http://127.0.0.1:4321/api/tables/authors/export?format=json'
```
