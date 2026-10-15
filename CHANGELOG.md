# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Demo database (`npm run demo:db`, `npm run demo`) with ~430k rows of generated bookshop data.
- End-to-end smoke test (`npm run test:smoke`) covering the API and security controls.
- CI on Node 20, 22 and 24, with smoke tests against PostgreSQL 14, 15, 16 and 17.
- Open-source project files: contributing guide, code of conduct, security policy, issue and PR templates, roadmap, and a project website.

## [0.1.0]

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
- Security hardening: read-only transactions, catalog-only identifiers, bind parameters, bounded reads, statement timeout, `127.0.0.1` binding, `Host` header check, strict CSP, same-origin guard for writes, credential redaction.

[Unreleased]: https://github.com/sagaryeole/PG-Studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sagaryeole/PG-Studio/releases/tag/v0.1.0
