# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `pg-studio` command, published to npm as `@sagaryeole/pg-studio`: `npx @sagaryeole/pg-studio <url> --open`, with `--connections`, `--port`, `--schema`, `--env-file` and `--open`.
- Docker image `ghcr.io/sagaryeole/pg-studio` (amd64 and arm64, non-root, health check). Publish it with `-p 127.0.0.1:4321:4321`.
- Publishing a GitHub release publishes the npm package (with provenance) and the image.
- CI installs the packed npm tarball and runs the container, and runs the smoke test against both.
- Browser tests (Playwright, `npm run test:e2e`): 27 tests over tables, the filter panel, the inspector, functions, connections and databases, and both themes. They fail on any console error, stray "null"/"undefined" text or a stylesheet that didn't fully apply. Run in CI.

### Fixed

- A port that's already in use now gives a clear error instead of a startup message followed by a crash.
- No more overlapping queries on one connection in the table lookup and Structure tab, which node-postgres deprecates (and pg 9 will reject).

## [0.2.0] - 2026-10-16

### Added

- Saved connections in `connections.json` (or `DATABASE_URL` as before), with a connection / database / schema switcher in the top bar. Credentials never reach the browser; passwordless URLs use `~/.pgpass` or `PGPASSWORD`.
- Every database on a server: a database menu lists those the role may connect to, each opened with its own small pool on first use.
- Functions, procedures and aggregates in the sidebar and ⌘K, with signature, flags (`SECURITY DEFINER`, volatility…), owner, source and the triggers that use them. View only.
- Filter panel: several conditions at once, match all / any (`match=any`), conditions you can switch off, and a read-only SQL preview (`/tables/:name/sql`). Press `f`.
- Demo `analytics` database, two saved demo connections, and example functions, a procedure, a trigger and an aggregate.
- New endpoints: `/connections`, `/databases`, `/routines`, `/routines/:oid`, `/tables/:name/sql`. Every endpoint takes `conn` and `db`.

### Changed

- The schema picker moved from the sidebar to the top bar.
- Links, column settings and recent tables are kept per database. Links to the default database are unchanged.
- `@types/node` is pinned to Node 20, the oldest supported version. TypeScript 7 and `actions/checkout` / `actions/setup-node` v7.
- New runtime dependency: `pg-connection-string` (part of node-postgres).

## [0.1.0] - 2026-10-15

First public version.

### Added

- Browse tables, views and materialized views across schemas, with planner row estimates.
- ⌘K jump to any table, recent and largest tables on the start page.
- Server-side sorting, filters (`=`, `≠`, `<`, `≤`, `>`, `≥`, contains, starts/ends with, empty / has a value) and search across text and enum columns.
- Keyset pagination by primary key, with offset paging for custom sorts and views.
- Row inspector with full values, pretty-printed JSON, and links to referenced and referencing rows.
- Foreign-key navigation, including composite and cross-schema keys, with browser history support.
- Structure tab: sizes, stats, columns, indexes, constraints, relationships, triggers and a generated `CREATE` script.
- Exact `count(*)` on demand.
- CSV and JSON export of the current view, with formula-injection protection.
- Resizable, hideable and frozen columns, remembered per table.
- Shareable URLs holding the whole view state.
- Keyboard navigation and a shortcuts dialog.
- Light and dark themes.
- Demo database (`npm run demo:db`, `npm run demo`) with ~430k rows of generated bookshop data.
- End-to-end smoke test (`npm run test:smoke`) covering the API and security controls.
- CI on Node 20, 22 and 24, with smoke tests against PostgreSQL 14, 15, 16 and 17.
- Open-source project files: contributing guide, code of conduct, security policy, issue and PR templates, roadmap, and a project website.
- Security hardening: read-only transactions, catalog-only identifiers, bind parameters, bounded reads, statement timeout, `127.0.0.1` binding, `Host` header check, strict CSP, same-origin guard for writes, credential redaction.

[Unreleased]: https://github.com/sagaryeole/PG-Studio/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sagaryeole/PG-Studio/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sagaryeole/PG-Studio/releases/tag/v0.1.0
