# PG Studio TODO

Ordered by value for effort. Rule of thumb: stop adding features once the tool no longer does something you actually need. For general-purpose database work, use TablePlus or DBeaver; keep PG Studio for the narrow things (a clean viewer, safe single-cell edits on your own tables, anything specific to the ExecutiveOrbit schema).

Guardrails for every item: the browser never sends SQL, identifiers come from the catalog only, values are bind parameters, and anything that reads must keep the row limit and timeout.

## Done: better reading (no data changes)

- [x] **Sorting and per-column filters.** Server-side, fixed operator set (`=`, `contains`, `>`, `<`, `is null`, `is not null`). Column names are validated against the catalog. Biggest usability gain.
- [x] **Resizable and hideable columns, frozen first column.** Fixes the wide-table problem.
- [x] **Foreign-key navigation.** Click a foreign-key value to jump to the referenced row. Needs `pg_constraint` lookups in `catalog.ts`.
- [x] **Copy and export.** Copy as CSV or JSON, export the current view. Capped at a row limit.
- [x] **Search across a table.** Text columns only, with the statement timeout.
- [x] **Cell inspector improvements.** Pretty-print JSON, bytea size, timestamps in local timezone, copy row as JSON, filter by value. (Decoding bytea as text/image is still open.)

## Next: scale and structure

- [ ] **Keyset paging by primary key.** Makes deep pages on big tables fast (`WHERE pk > last`). Replaces OFFSET, which is the main limitation in the README.
- [ ] **Views, materialized views, schema switcher.**
- [ ] **Table details tab.** Indexes, constraints, size, `CREATE TABLE` definition, all read from the catalog.
- [ ] **Exact row count on demand.** Button that runs `count(*)` with the timeout instead of the planner estimate.

## Later, only if needed

- [ ] **Cell editing.** Design is in README ("Edit mode: design for later"). Summary: separate write pool, `ENABLE_EDITS=true` plus `DATABASE_WRITE_URL`, column-level `GRANT UPDATE`, one cell per request, optimistic check on the old value (409 if changed), JSON-lines audit log, tables without a primary key stay read-only. Write the tests listed in the README first.
- [ ] **Read-only SQL console.** Leaning no. Needs a SQL parser or a separate tightly limited role, and it is the feature most likely to expose data. DBeaver does it well.
- [ ] **Saved connections / multiple databases.** Leaning no, because it means storing credentials. Run one instance per database with its own `.env` instead.

## Known limitations (from README)

- Deep paging is slow on big tables (OFFSET).
- Tables without a primary key are ordered by `ctid`, so pages can shift while the table changes.
- Row counts are planner estimates (none shown while filtered).
- Filters and sorts on unindexed columns scan the table (bounded by the statement timeout).
- CSV export writes NULL as an empty cell.
- Values are shown as Postgres text output (bytea as `\x…`, timestamps in the server timezone).
