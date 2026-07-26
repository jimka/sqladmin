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

## Known issues / loose ends

- **Prod build class-name mangling** — the prod bundle needs `esbuild.keepNames`
  (now applied and merged) or class names mangle and the app renders unstyled
  (see `LIBRARY_NOTES.md`). The robust library-side fix, so no consumer needs
  `keepNames` at all, is planned in typescript-ui
  `plans/minification-safe-class-names.md` (deferred).
- **Large `MemoryStore.loadData` renders zero rows** (~1500+ rows) — a library
  bug, currently worked around with pagination (see `LIBRARY_NOTES.md`).
- **Disposing a component mid-transition throws a stray console error** (library
  side). Closing a diagram tab while its entry/fit animation is still running
  logs one uncaught `DOM handle N is not registered (released or never minted)`
  — `Component.destructor()` releases the DOM handles, then the pending
  transition's deferred `InlineStyle.set` tries to write through one
  (`applyTransitionAndTo` → `InlineStyle.writeStyle` → `HandleRegistry.resolve`,
  all inside `@jimka/typescript-ui`). Harmless: the Worker is still terminated
  and the tab still closes, and it does not fire when the diagram is left to
  settle first, nor when a `QueryPanel` is disposed. The app only calls the
  documented `dispose()`, so the fix belongs in the library — cancel pending
  transitions in `destructor()`, or make the deferred write tolerate a released
  handle. Found while verifying `elk-worker-disposal`.
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
