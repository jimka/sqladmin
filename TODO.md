# SQLAdmin — Future Work / Backlog

Deferred features and known issues. Items with an implementation plan live in
`plans/`; everything else is backlog awaiting a plan.

## Planned (see `plans/`)

- **schema-views** — views & materialized views in the navigator, read-only grid
  + a Definition tab.
- **result-export** — CSV / JSON export (query results and navigator table export).
- **structure-detail** — indexes, constraints, foreign keys in the Structure
  panel, with foreign-key click-through.

## Backlog (no plan yet)

### Data
- **Result pagination for query panels / large views.** Ad-hoc results render
  into an in-memory `MemoryStore`, which hits the ~1500-row zero-render bug (see
  `LIBRARY_NOTES.md`). The query-workspace and schema-views plans ship a
  defensive row cap; real pagination is the proper fix.
- **Import data from JSON / CSV into a table.**
- **Row-detail viewer** — expand one row (wide tables, JSON / large-text columns)
  into a form/panel.
- **Copy-as** — cell / row / `INSERT` statement.

### Query workflow
- **Multi-statement execution + transaction control** (BEGIN/COMMIT, run selection).
- **Command palette / keyboard-driven actions.**
- **Backend-persisted, shareable saved queries** — supersede or complement the
  localStorage store once user support lands.

### Schema depth
- **More navigator object types** — sequences, functions/procedures, types,
  indexes-as-objects.

### Connections / platform
- **Connection-management UI** — add/switch connections (activates the
  `connectionId` route/registry seam from `tsui-sql-admin.md`); needs auth/session
  thinking.
- **App-level auth / sessions.**

### Polish
- **Dark theme** — the theme system already has a classic/default toggle.
- **"Connected to X" indicator** — the start page is a natural home.

## Known issues / loose ends

- **Prod build class-name mangling** — the prod bundle needs `esbuild.keepNames`
  (now applied and merged) or class names mangle and the app renders unstyled
  (see `LIBRARY_NOTES.md`). The robust library-side fix, so no consumer needs
  `keepNames` at all, is planned in typescript-ui
  `plans/minification-safe-class-names.md` (deferred).
- **Large `MemoryStore.loadData` renders zero rows** (~1500+ rows) — a library
  bug, currently worked around with pagination (see `LIBRARY_NOTES.md`).
