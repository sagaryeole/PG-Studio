# Security

PG Studio is designed to be safe to point at a real PostgreSQL database. This page explains what's enforced, how each control was tested, and how to report a problem.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report privately through GitHub: **[Report a vulnerability](https://github.com/sagaryeole/PG-Studio/security/advisories/new)** (Security tab → *Report a vulnerability*).

Please include:

- what an attacker can do, and under what conditions (local user, malicious web page, crafted table or column names, hostile data in a row, …)
- steps to reproduce, ideally against the demo database (`npm run demo:db`)
- the PG Studio commit or version, PostgreSQL version and browser

You can expect an acknowledgement within a few days. Once a fix is ready, the advisory is published with credit to you, unless you'd rather stay anonymous.

### Supported versions

PG Studio is pre-1.0. Security fixes go into the latest release on `main`.

## Threat model

PG Studio is a **local, single-user** tool. It assumes:

- the person running it is allowed to read the database it connects to
- the browser may have other tabs open on **untrusted websites** (so DNS rebinding, CSRF and cross-origin reads matter)
- the **data in the database may be hostile** (HTML or script in text and JSON, formula payloads, odd identifiers)

It doesn't try to be a multi-user server. There's no authentication, so **don't expose it on a network** or put it behind a reverse proxy for other people.

## Security model

| Control | Implementation | Verified |
|---|---|---|
| No SQL injection via table name | The name is used only as a bind parameter in a `pg_class` lookup. The identifiers spliced into SQL come from the catalog row and are quoted with `pg.escapeIdentifier`. | A table named `x"; DROP TABLE users;--` opens normally and `users` is still there |
| No SQL injection via sort, filters, search | Column names must match a catalog column, and the catalog's name is what gets quoted. Operators come from a fixed list and map to fixed SQL. Every value is a bind parameter. LIKE wildcards in values are escaped. | Unknown column, unknown operator and `' OR '1'='1` values are rejected or harmless. A column named `col"; drop table users;--` sorts and filters correctly. |
| Spreadsheet formula injection | CSV cells starting with `= + - @` (that aren't plain numbers) are prefixed with `'` | `=HYPERLINK(...)` exports as `'=HYPERLINK(...)`; `-18.5` stays a number |
| Column-level permissions | Columns the role can't SELECT are left out. Tables it can't SELECT return 404 and aren't listed. | A revoked table returns 404 |
| Read-only | `BEGIN READ ONLY` plus an unconditional `ROLLBACK`, **plus** the SELECT-only role | `DELETE` is rejected even as superuser (25006) |
| Bounded reads | `LIMIT` ≤ 100 (fetches n+1 rows to detect a next page), integer-validated `page`, values cut to 5,000 chars inside PostgreSQL. Exports: ≤ `EXPORT_MAX_ROWS` rows, 100,000 chars per value. | Bad params return 400. Long values are flagged as cut. A 200k-row export stops at 10,000 and says so. |
| Timeouts | `statement_timeout` set per transaction | `pg_sleep(2)` is cancelled at 300 ms |
| Network exposure | Listens on `127.0.0.1` only; not configurable. The Docker image listens inside the container and must be published with `-p 127.0.0.1:…` | |
| DNS rebinding | `Host` header must be `127.0.0.1:PORT` or `localhost:PORT` (any port in the Docker image, where the published port can differ) | `Host: evil.example` returns 403 |
| CSRF (ready for edits) | Non-GET requests need a same-site `Origin` and an `x-pg-studio: 1` header | A cross-origin POST returns 403 |
| XSS from data | Every database value is rendered with `textContent`. Strict CSP: no inline script or style. | `<img onerror=alert(1)>` in jsonb renders as text, no dialog |
| No credential leaks | Connection strings are redacted from logged errors | Logs grepped for the password |

Several of these checks run on every push in CI. See [`scripts/smoke-test.sh`](scripts/smoke-test.sh).

## Why a SELECT-only role is required

The app opens every query in a `READ ONLY` transaction, but that's a **guard rail, not a boundary**. A multi-statement string such as `COMMIT; DELETE ...` can escape it, which was confirmed against a superuser connection during testing. PG Studio never runs request-derived SQL text, so this can't be triggered through the UI or API today. Even so, the role's grants are what actually guarantee the database can't be changed.

If the configured role can write, the server prints a warning at startup and the UI shows a red badge. See [Quick start](README.md#use-it-with-your-own-database) for the `GRANT` statements.

## Good practice

- Use a dedicated SELECT-only role, ideally against a replica or dev copy.
- Keep `.env` out of version control (it's in `.gitignore`) and out of screenshots, issues and AI chats.
- Keep `STATEMENT_TIMEOUT_MS` low on shared databases.
