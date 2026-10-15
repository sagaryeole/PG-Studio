# Roadmap

PG Studio aims to stay a small, safe, fast way to **look at** a PostgreSQL database. For general-purpose database work, such as running SQL, administration or schema design, tools like pgAdmin, DBeaver or TablePlus are a better fit, and PG Studio is happy to sit next to them.

**Guardrails for every item:** the browser never sends SQL, identifiers come from the catalog only, values are bind parameters, and anything that reads keeps the row limit and timeout.

Ideas and votes are welcome in [issues](https://github.com/sagaryeole/PG-Studio/issues) and [discussions](https://github.com/sagaryeole/PG-Studio/discussions).

## ✅ Done

**Reading**
- Server-side sorting and per-column filters with a fixed operator set
- Search across text and enum columns
- Resizable, hideable columns and a frozen first column
- Foreign-key navigation in both directions, including composite and cross-schema keys
- Copy and export (CSV / JSON) of the current view, capped
- Cell inspector: pretty-printed JSON, bytea size, local-time timestamps, copy row as JSON, filter by value

**Scale and structure**
- Keyset paging by primary key, so deep pages on big tables are fast
- Views, materialized views and a schema switcher
- Structure tab: indexes, constraints, sizes, stats and a generated `CREATE` script
- Exact row count on demand

**Usability**
- Start page with recent and largest tables
- ⌘K jump to table across all schemas, with fuzzy matching
- Column header menu: sort, filter, value / no value, hide
- Keyboard navigation: arrows, Enter, ⌘C, `/`, `[` `]`, `?`
- Side panel shows the whole row and its relationships in plain words
- Broken bookmarks fall back to the plain table with an explanation

## 🔜 Next (small)

- [ ] **Keyset paging for custom sorts on indexed columns.** Needs NULL-aware cursor conditions; worth it for paging deep into a sorted big table.
- [ ] **Decode bytea** in the inspector, as UTF-8 text or an image preview.
- [ ] **Foreign tables**, opt-in, since browsing them queries a remote server.

## 🤔 Later, only if there's demand

- [ ] **Single-cell editing**, opt-in, with separate credentials and column-level grants. The full design is in [docs/EDIT-MODE.md](docs/EDIT-MODE.md): a separate write pool, `ENABLE_EDITS=true` plus `DATABASE_WRITE_URL`, one cell per request, an optimistic check on the old value (409 if changed), a JSON-lines audit log, and tables without a primary key staying read-only.

## 🚫 Not planned

- **SQL console.** It would need a SQL parser or a separate tightly limited role, and it's the feature most likely to expose data. Other tools do it well.
- **Saved connections / multiple databases.** That means storing credentials. Run one instance per database, each with its own `.env`.
- **Network or multi-user mode.** PG Studio has no authentication and binds to `127.0.0.1` on purpose.
