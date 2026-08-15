# SQLAdmin — Future Work / Backlog

Deferred features and known issues. Implemented work lives in
`plans/implemented/`; everything below is backlog awaiting a plan.

## Backlog (no plan yet)

### Data
- **Result pagination for query panels / large views.** Ad-hoc results render
  into an in-memory `MemoryStore`, which hits the ~1500-row zero-render bug (see
  `LIBRARY_NOTES.md`). The query-workspace and schema-views plans ship a
  defensive row cap; real pagination is the proper fix.
- **Import data from JSON / CSV into a table.**
- **Row-detail editing** — the Data tab's record view (shipped for tables in
  `table-record-detail-view`, and for query results in
  `query-result-record-view`) shows one row at a time as field/value rows but
  is read-only. Still unshipped: editing a record field-by-field, and reading
  a JSON / large-text value in full (the record view's value column is
  width-capped by the library).
- **Copy-as** — cell / row / `INSERT` statement.
- **`date`/`time` columns are modelled as the library's `datetime` field
  type** (`buildModel.ts:14`), so a `date` cell renders a time of day it does
  not have, and west of UTC it renders the previous day. Mapping those two
  Postgres types to the library's `date` / `time` field types would fix the
  display and the editor together; it is a separate change with a grid-wide
  blast radius.

### Query workflow
- **Multi-statement execution + transaction control** (BEGIN/COMMIT, run selection).
- **Command palette / keyboard-driven actions.**
- **Backend-persisted, shareable saved queries** — supersede or complement the
  localStorage store once user support lands.

### Connections / platform
- **Connection-management UI** — add/switch connections (activates the
  `connectionId` route/registry seam from `tsui-sql-admin.md`); needs auth/session
  thinking.
- **Shareable link UI** — a "Copy link" action (context menu / toolbar) that
  builds the URL for the focused tab, plus keeping the address bar in step as
  the user navigates. `router-deep-linking` only resolves an incoming URL;
  generating one is a deliberate non-goal there.

### Polish
- **Dark theme** — the theme system already has a classic/default toggle.
- **Surface unindexed foreign keys as a diagnostic.** A foreign key whose local
  columns have no covering index is worth reporting: it makes the parent's
  deletes and updates scan the child table. The FK diagram marks one with a
  warning-tinted stroke, but that is the only place it shows, and the stroke
  itself is unlabelled — the edge tooltip used to name it and no longer does,
  because a folded edge carries one key per fold and repeated the same sentence
  down the tooltip. The verdict already exists as `FkDetail.uncovered`
  (`frontend/src/data/fkCardinality.ts` computes it). Two places to put it,
  either or both: the relation's **Structure** tab, in its foreign-key table, as
  a per-key column; and a schema- or database-wide diagnostics view that lists
  every uncovered key at once. The second is the more useful of the two — an
  unindexed key is something you want to find without knowing where to look.

## Known issues / loose ends

- **`ColumnMeta.dataType` is inconsistent between relation kinds.** Tables and
  views take it from `information_schema.columns.data_type` (a type name with
  no modifier); materialized views take it from `format_type`, which includes
  one. `pg_type_to_wire` matches type names exactly, so a matview column
  declared `timestamp(3) with time zone` falls through to `STRING` instead of
  `ISO_STRING`. Narrow — it needs an explicit precision on a matview column —
  and no fix is planned here.
- **Prod build class-name mangling** — the prod bundle needs `esbuild.keepNames`
  (now applied and merged) or class names mangle and the app renders unstyled
  (see `LIBRARY_NOTES.md`). The robust library-side fix, so no consumer needs
  `keepNames` at all, is planned in typescript-ui
  `plans/minification-safe-class-names.md` (deferred).
- **Large `MemoryStore.loadData` renders zero rows** (~1500+ rows) — a library
  bug, currently worked around with pagination (see `LIBRARY_NOTES.md`).
- **A large diagram's first render blocks the main thread for tens of
  seconds.** Changing *Depth* to `2` on `hub.asset_category`'s relation
  diagram (156 cards, 1065 edges, ~10,000 components) spends 42 s in one
  synchronous framework layout-and-render pass inside `DiagramView`'s
  subtree. It is neither ELK (which runs off-thread, ~16 s for that graph)
  nor the diagram's own code: building the 156 node components takes 0.36 s
  and the post-layout positioning plus edge redraw 0.02 s. The library's busy
  overlay now covers the wait and the render happens after the overlay
  paints, but the freeze itself is a framework layout-cost defect — the pass
  repeats itself, ~29,000 `Component.doLayout` and ~100,000
  `getPreferredSize` calls for ~10,000 components — and needs its own
  investigation in `typescript-ui`.
