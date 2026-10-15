# Contributing to PG Studio

Thanks for your interest! PG Studio is a small, focused tool, and contributions that keep it that way are very welcome: bug fixes, performance work, accessibility, docs, and features from the [roadmap](ROADMAP.md).

## Before you start

- **Bugs:** open an [issue](https://github.com/sagaryeole/PG-Studio/issues/new/choose) with steps to reproduce, ideally against the demo database.
- **Features:** open an issue first so we can agree on scope before you write code. Check the roadmap's "Not planned" section too.
- **Security problems:** don't open an issue. Follow [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 20.6+ and Docker (or Colima / OrbStack / Podman).

```bash
git clone https://github.com/sagaryeole/PG-Studio.git
cd PG-Studio
npm install
npm run demo:db      # PostgreSQL 16 on 127.0.0.1:55432 with fake data
npm run demo         # server in watch mode on http://127.0.0.1:4321
```

The front end in `public/` is plain HTML, CSS and JavaScript with no build step: edit and reload. The server in `src/` restarts automatically in watch mode.

To work against your own database instead, copy `.env.example` to `.env` and run `npm run dev`.

## Checks

Run these before opening a pull request. CI runs the same checks on Node 20, 22 and 24 and PostgreSQL 14 to 17.

```bash
npm run typecheck
npm run build
npm run test:smoke        # needs the demo DB and a running server (npm run demo)
```

## The safety rules

Every change must keep these. They're what makes PG Studio safe to point at a real database:

1. **The browser never sends SQL.** No endpoint accepts SQL text, fragments or type names.
2. **Identifiers come from the catalog.** Table and column names in a request are only ever looked up (as bind parameters) and then replaced by the catalog's own name, quoted with `pg.escapeIdentifier`.
3. **Values are bind parameters.** Always. Escape LIKE wildcards in values used with LIKE.
4. **Reads stay bounded.** Keep the row limit, cell length cut, export cap and `statement_timeout`.
5. **Everything runs through `db.withReadOnly`.** Don't add another way to get a connection on the read path.
6. **Data is rendered as text.** Use `textContent`, never `innerHTML`, for anything that came from the database. Keep the CSP free of `unsafe-inline`.

If a change touches any of these areas, say so in the PR and describe how you tested it with hostile input (odd identifiers, injection strings, HTML in values).

## Code style

- TypeScript is `strict` with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Keep it that way, and avoid `any`.
- Match the surrounding code: small functions, comments that explain *why*, plain-word error messages for users.
- UI copy should be short and concrete. Say what happened and what to do.
- Keep dependencies minimal. Adding a runtime dependency needs a good reason.

## Pull requests

- Keep each PR focused on one thing. Small PRs get reviewed faster.
- Update the README or `docs/` if behavior, configuration or the API changes.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).
- Screenshots or a short GIF help for UI changes. Please use the demo database, not real data.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
