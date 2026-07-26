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
- **`frontend/package.json`'s `"@jimka/typescript-ui": "^0.2.0"` doesn't admit
  `elkWorkerFactory` yet.** The `elk-worker-adoption` plan's six `DiagramView`
  sites typecheck today only because the local dev symlink points at an
  unmerged, unpublished typescript-ui worktree — a plain `npm install` /
  `npm ci` against the real `0.2.0` on the registry (pinned in
  `package-lock.json`) fails on all six. Once typescript-ui publishes a
  release carrying the option (`elk-layout-web-worker.md`), bump the range —
  `^0.2.0` won't admit a `0.3.0`, the conventional level for an additive
  feature — and regenerate the lockfile.
- **Every diagram now leaks a Worker thread on top of the component graph it
  already stranded.** Since `elk-worker-adoption`, each `DiagramView`'s
  `ElkLayoutEngine` lazily constructs a Worker via the app's
  `elkWorkerFactory` on first layout. `DiagramView` inherits the library's
  generic `Component.dispose()` (it is not "no dispose API at all" —
  `ElkLayoutEngine` isn't a `Component` and defines no disposal method of its
  own at all; `DiagramView` doesn't override its inherited `dispose()` to
  reach into it), so calling `dispose()` frees DOM/handles/theme subscriptions
  on the `DiagramView` itself but not the Worker. (None of the five dock-tab
  panels are ever disposed at all today — see below — so this was already
  true of their node/button/cell theme subscriptions before this branch; the
  Worker is a new resource added to an existing leak, not a new leak class.)
  Five of the six panels (`SchemaDiagramPanel`, `RelationGraphPanel`,
  `RoleGrantsDiagramPanel`, `DatabaseDiagramPanel`, `RelationDiagramPanel`)
  are top-level dock tabs with no `_panelDisposers` entry, same as before, so
  each held-open tab holds one Worker. `ExplainDiagramPanel` is worse: it is
  never itself a top-level dock tab — it lives in `QueryPanel`'s
  `diagramSlot`, which *does* already call a disposer on every rebuild
  (`showDiagramTab` in `QueryPanel.ts`), but that disposer is a deliberate
  no-op (see its comment), so re-running Explain on the same
  query tab leaks one Worker **per rebuild**, not just per tab. Fixing the
  underlying leak belongs in typescript-ui (a disposal path that reaches
  elkjs's `terminateWorker()`); once it exists, `QueryPanel`'s diagramSlot
  disposer is the one seam in this app already positioned to call it — the
  five dock-tab panels would additionally need a `_panelDisposers` entry
  each, which none of them have today.
