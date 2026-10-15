# Edit mode: design for later

> **Status: not built.** PG Studio is read-only today. This document records how single-cell editing could be added without weakening the read path. See the [roadmap](../ROADMAP.md).

Editing reverses this tool's main safety property, so it shouldn't be done by flipping the read-only flag. The plan below keeps the read path exactly as it is and adds a separate, narrow write path.

## Seams already in the code

- `db.ts` has a single `withReadOnly` helper. Add `withWrite` on a **separate pool**.
- `catalog.ts` already returns `primaryKey`, `isGenerated`, `isIdentity` and `canUpdate` (from `has_column_privilege(..., 'UPDATE')`) for each column.
- The `/meta` response includes `capabilities.edit`. The UI reads it.
- `security.ts` already has `requireSameOriginForWrites`, mounted on `/api`.
- `server.ts` marks where `writeRoutes(config, writeDb)` would be mounted, only when explicitly enabled.
- Values travel as PostgreSQL text, which is also the input format for every type, so what the grid shows is what an edit sends back.
- The cell inspector panel is meant to become the editor.

## Rules

1. **Opt-in, separate credentials.** Edits are on only when `ENABLE_EDITS=true` **and** `DATABASE_WRITE_URL` is set. That role gets column-level grants for exactly what you want editable:
   `GRANT UPDATE (status, notes) ON public.orders TO pgstudio_rw;`
   The grants are the allow-list, and `canUpdate` will report them.
2. **One row, one column per request.** `PATCH /api/tables/:name/cell` with body `{ key: {pkCol: value…}, column, oldValue, newValue }`. No inserts, deletes, bulk edits or SQL console.
3. **Editable only when** the table has a PK, the column isn't part of the PK, isn't generated, isn't `GENERATED ALWAYS AS IDENTITY`, has `canUpdate` on the write role, and the value shown wasn't truncated.
4. **SQL shape.** Identifiers come from the catalog only. Values are untyped bind parameters, so PostgreSQL infers each one's type from its column and no type names get spliced into SQL:
   ```sql
   UPDATE "schema"."table"
      SET "col" = $1
    WHERE "pk1" = $2 AND "pk2" = $3
      AND "col"::text IS NOT DISTINCT FROM $4   -- optimistic check against what the user saw
   RETURNING "col"::text
   ```
   Run it in a transaction with `statement_timeout`. Commit only when `rowCount === 1`. Zero rows returns **409** ("changed since you loaded it"). PostgreSQL error `22P02` or `22007` returns **400** with the type error.
5. **Audit log.** Append `{ts, table, key, column, old, new}` as one JSON line to a local file. That also gives you undo.
6. **UI.** The inspector becomes a textarea with "Set NULL", Save and Cancel buttons. Save shows old → new before sending. The client sends `x-pg-studio: 1`.
7. **Tests to write first:** no-PK table refused, truncated value refused, concurrent change returns 409, bad type returns 400, cross-origin returns 403, column without grant refused.
