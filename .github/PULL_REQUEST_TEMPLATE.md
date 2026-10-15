## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How I tested it

<!-- e.g. ran against the demo database, `npm run typecheck`, `npm run test:smoke`, manual steps in the UI. -->

## Checklist

- [ ] `npm run typecheck` and `npm run build` pass
- [ ] `npm run test:smoke` passes against the demo database
- [ ] The browser still never sends SQL; identifiers come from the catalog; values are bind parameters
- [ ] Reads stay bounded (row limit, cell size, statement timeout)
- [ ] README / docs updated if behavior or the API changed
