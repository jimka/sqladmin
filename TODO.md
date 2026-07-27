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
- **Row-detail viewer** — expand one row (wide tables, JSON / large-text columns)
  into a form/panel.
- **Copy-as** — cell / row / `INSERT` statement.

### Query workflow
- **Multi-statement execution + transaction control** (BEGIN/COMMIT, run selection).
- **Command palette / keyboard-driven actions.**
- **Backend-persisted, shareable saved queries** — supersede or complement the
  localStorage store once user support lands.

### Schema depth
- **More navigator object types** — indexes-as-objects. (Sequences shipped in
  `schema-sequence-ddl`; functions/procedures and types shipped in
  `function-type-ddl`.)

### Connections / platform
- **Connection-management UI** — add/switch connections (activates the
  `connectionId` route/registry seam from `tsui-sql-admin.md`); needs auth/session
  thinking.

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

- **Prod build class-name mangling** — the prod bundle needs `esbuild.keepNames`
  (now applied and merged) or class names mangle and the app renders unstyled
  (see `LIBRARY_NOTES.md`). The robust library-side fix, so no consumer needs
  `keepNames` at all, is planned in typescript-ui
  `plans/minification-safe-class-names.md` (deferred).
- **Large `MemoryStore.loadData` renders zero rows** (~1500+ rows) — a library
  bug, currently worked around with pagination (see `LIBRARY_NOTES.md`).
- **Resolved pending release: disposing a component mid-transition threw a
  stray console error** (library side). The transition at fault was never a
  diagram entry/fit animation — `DiagramView` runs none — it was `Tab`'s
  cross-tab content fade (`_tabFadeAnimation`), which plays for roughly 190ms
  right after a tab's spinner-to-content materialize fade completes and was
  cancelled only in `Tab.detach()`, not when the faded tab was closed within
  that window. Closing a diagram tab there logged one uncaught
  `DOM handle N is not registered (released or never minted)` —
  `Component.destructor()` released the DOM handles, then the fade's deferred
  `InlineStyle.set` tried to write through one. Fixed in the library
  (`diagram-layout-settled-and-root-focus`): a framework-internal
  `PendingTransitions` registry tracks each `Animation.play` transition's
  cancel function per handle, and `Component.destructor()` cancels every
  entry for a handle immediately before releasing it — the same fix any
  future hand-rolled `Animation.play` transition gets for free, not just this
  one. Like the two entries below, the app reaches this fix only through the
  local dev symlink until typescript-ui publishes a release carrying it.
  Found while verifying `elk-worker-disposal`.
- **`frontend/package.json`'s `"@jimka/typescript-ui": "^0.2.0"` admits neither
  `elkWorkerFactory` nor the Worker disposal path.** Both `elkWorkerFactory`
  (`elk-worker-adoption`) and `DiagramView`'s `destructor()` override /
  `ElkLayoutEngine.dispose()` (`elk-worker-disposal`) are merged to
  typescript-ui's `master` but unpublished, so the app resolves them only
  through the local dev symlink to that checkout — a plain `npm install` /
  `npm ci` against the real `0.2.0` on the registry (pinned in
  `package-lock.json`) still fails. Once typescript-ui publishes a release
  carrying both, bump the range — `^0.2.0` won't admit a `0.3.0`, the
  conventional level for an additive feature — and regenerate the lockfile.

  The `elkjs` bump to `^0.12.0` adds a second, install-level face of the same
  gap: the published `0.2.0` declares `peerOptional elkjs@^0.10.0`, so a plain
  `npm install` in `frontend/` now hard-errors with `ERESOLVE` and has to run
  as `npm install --legacy-peer-deps` until a typescript-ui release carrying
  the `^0.12.0` peer is published. `npm ci` is unaffected — it replays the
  committed lockfile — so the Dockerfile and release workflow are no more
  broken than they already were.
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
