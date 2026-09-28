# Changelog

All notable changes to SQLAdmin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.0] — 2026-09-28

### Added
- **Tabs with unsaved changes now show a small dot on their icon.** It covers
  unsaved query text, edited table cells, and definition, sequence, type, and
  DDL-form edits. The dot appears as soon as there is something to lose and
  clears on Save, on Refresh, or when you undo back to the original. It stays
  with the tab when you float, re-dock, or split it, and it always matches
  whether closing the tab will ask first. As before, "Save…" on a query tab
  stores a copy and doesn't clear the dot. The dot isn't exposed to screen
  readers yet.
- **When a query fails, the query editor now jumps to the spot PostgreSQL
  reported and highlights it.** A failed Run (button or Ctrl+Enter) selects
  the offending token, so typing replaces it, scrolls a long query to centre
  it, and adds `(line X, column Y)` to the error banner. Explain and Explain
  Analyze highlight the same way but keep their toast-only errors. Errors
  without a reported position, such as `division by zero`, behave as before,
  and the DDL preview dialog and the definition editors don't reveal errors
  yet.
- **The status bar now shows the query editor's caret position and selection
  size**, next to your user badge — `Ln 12, Col 4`, or
  `Ln 14, Col 3 (15 chars, 2 lines selected)` while text is selected. It
  follows the active query tab, floating windows included, and hides on other
  tabs. If a query tab is left alone in a floating window after every docked
  tab is closed, the readout stays hidden until you click that tab's label.
- **Closing a floating window from its own title-bar ✕ now asks before
  discarding unsaved changes**, closing the gap left in 0.9.0. Confirming
  closes the window and every tab in it; cancelling keeps them all. A window
  with no unsaved tabs still closes straight away.

### Changed
- **Closing several tabs with unsaved changes now asks once instead of once
  per tab.** A floating window's ✕ and the tab menu's Close all / Close
  others / Close all to the left or right show one combined prompt ("2 of
  the 3 tabs being closed have unsaved changes"). Clean tabs in a bulk close
  still close immediately.
- **Creating, dropping, or renaming an object no longer resets the whole
  navigator tree.** Only the schemas the change could affect are re-read and
  merged in, so other schemas' expansion, the current selection, and the
  scroll position are kept. A table drop also removes its index and
  owned-sequence entries, and a rename relabels its indexes in place. A
  CASCADE drop or hand-edited preview SQL re-reads every expanded schema.
  The Refresh tool and Alt+R still do a full reload.
- **The SQL review dialog now opens with the cursor in the SQL editor**, for
  create forms' "Review SQL…" and the Structure, sequence, and type tabs'
  Save review. Pressing Enter adds a line instead of running the statement;
  run it with the Execute button.
- **Date and time cells accept only the format they display** —
  `YYYY-MM-DD H:MM[:SS]`, without a `T`, a time-zone suffix, or fractional
  seconds; anything else reverts. A bare date typed into a `date` column
  also reverts until a later release gives date columns their own editor.
- **`interval` and `time with time zone` columns are now text columns.** They
  show PostgreSQL's own text (`1 mon 2 days 03:04:05`, `09:30:00+02`), their
  header filter compares text, and a `timetz` column is no longer offered as
  a chart time axis.
- **Keyboard focus is easier to follow.** Toolbars and the menu bar show a
  focus ring when reached with the keyboard, and each toolbar is a single
  Tab stop whose buttons are reached with the arrow keys.

### Fixed
- **Rows of a table with a `timestamp` (without time zone) column can be
  saved again.** Any edit to any row of such a table failed with a
  "can't subtract offset-naive and offset-aware datetimes" error. An edited
  `timestamp` is now stored as the date and time the grid showed, in any
  browser time zone.
- **Saving a row no longer rewrites the cells you didn't edit.** An update
  sends only the changed cells, so an untouched `timestamp` or `timestamptz`
  value keeps its microseconds instead of being cut to milliseconds.
- **`interval` and `time with time zone` values show and save correctly.** An
  interval used to display as a day count (`32 days, 3:04:05`) and any save
  that included one failed; a `timetz` cell was blank. An invalid interval now
  gets an error banner and leaves the row unsaved.
- **SQL preview dialogs now update their SQL as you edit the form.** Since
  0.9.0, Drop (CASCADE), Rename table or schema, Create index, Add
  constraint, and Refresh materialized view generated their SQL once and
  ignored later edits, so ticking CASCADE still ran a plain `DROP`, a rename
  ran with the old name, and Create index was stuck on "requires at least one
  column". The preview now follows the form, and Execute always runs the SQL
  for the form's current state. Once you edit the SQL by hand, form changes
  leave it alone; the restored **Regenerate SQL** button discards your edits
  and regenerates it.
- **Query results that reach the 1,000-row cap render again.** In the built
  app, a truncated result showed an empty grid.
- **The navigator's Indexes category now updates after adding or dropping an
  index or constraint** from a table's Structure tab or the index advisor's
  "Create index…". It used to stay stale until a manual Refresh.

### Internal
- Migrated to `@jimka/typescript-ui` 0.10.0. The app now awaits the
  library's startup before building any UI, so the first screen is laid out
  in the app's own font.
- The unsaved-changes guard listens to the library's Dock-level
  `beforeclose` event instead of wiring each tab region by hand.
- `POST /query` and `POST /explain` error bodies can carry an optional
  `position`; every other route's error body is unchanged.
- Moved navigator refresh scoping, SQL error location, DDL preview
  regeneration, close-request batching, and dirty-tab tracking into DOM-free
  modules with unit tests.
- Recorded the library issues found during this release in
  `LIBRARY_NOTES.md`.

## [0.9.0] — 2026-09-08

### Added
- **The query editor and a view or materialized view's definition editor now
  show live syntax diagnostics as you type.** A wavy underline plus a gutter
  marker flag SQL that fails to parse — an unmatched parenthesis, a missing
  argument — refreshed about 750ms after you stop typing. This is a grammar
  check, not a full validator, and because it parses against generic SQL
  rather than PostgreSQL specifically, valid PostgreSQL syntax using `@>`,
  `<@`, or dollar-quoted strings can show a false diagnostic; for that reason
  the function-definition tab, the index and Explain viewers, and the DDL
  preview dialog don't show diagnostics at all.
- **The Notes tab gains a formatting toolbar** above the editor —
  bold/italic-style toggles, a Link button, Insert and Table dropdowns, Text
  style/Alignment/Columns dropdowns, and an "Edit Markdown source" toggle to
  switch to raw Markdown and back. Notes still autosave on every keystroke
  with no explicit Save step.
- **Closing a dock tab with unsaved changes now asks for confirmation.** An
  in-app "Close tab" dialog appears when closing a dirty tab via its ✕, its
  context menu, or a bulk-close action — covering table edits, unsaved query
  text, in-progress DDL drafts, and unsaved definition edits, whether the tab
  is tiled or torn into a floating window. Closing a floating window from its
  own title-bar button, rather than from its tab, isn't covered yet.
- **Refreshing the page, closing the browser tab, or navigating away with
  unsaved work open now triggers the browser's own "leave site?" warning.**
  This checks every open dock tab, tiled or floated, but not other parts of
  the app shell; signing out doesn't also trigger it on top of its own
  confirmation. The Notes tab, quick-search fields, diagram view controls,
  and chart axis pickers never trigger either warning, since they autosave or
  hold only transient view state.
- **A composite or enum type's info tab is now editable in place**,
  following the same edit-then-review pattern as the Structure tab's Columns
  section and a sequence's info tab: add, drop, retype, or rename a composite
  attribute, or add or rename an enum label, then Save to review the
  generated `ALTER TYPE` statements before they run.
- **Deleting an enum label** — something PostgreSQL has no direct statement
  for — **now runs a full recreate-and-migrate script**: the type is renamed
  aside, a replacement is created with the final label list, every column
  using the type (including array-typed columns) is migrated over with its
  data and defaults preserved, and the old type is dropped, all as one
  transaction with a warning shown before it runs.

### Changed
- **Creating a table, view, materialized view, schema, sequence, function,
  enum type, or composite type now opens in its own dock tab instead of a
  modal dialog.** The form stays in the tab; a "Review SQL…" toolbar action
  opens a focused, SQL-only dialog to check the generated statements before
  running them. Re-launching the same creation while a draft tab is open
  focuses that tab instead of opening a second one, and the dialog no longer
  previews SQL against a still-empty form the moment it opens.
- **The navigator's separate "Edit" action for types is gone.** A type
  leaf's context menu now offers only "Show info" and "Drop" — editing
  happens directly in the info tab.
- **Export dropdowns now read the same way everywhere** — "CSV (.csv)" /
  "JSON (.json)" (or "Text (.txt)" / "JSON (.json)" for an EXPLAIN plan) —
  matching what the navigator's right-click Export menu and Tools → Export
  results already showed.
- **"Clear SQLAdmin data" no longer clears saved connection presets.** It
  now clears only history, saved queries, notes, and layout; removing saved
  connections requires the new, separate "Clear saved connections" button,
  which asks for confirmation first.
- **Diagram nodes now align into clean, aligned columns** on the database
  diagram's Tables mode, a schema's Dependency/Inheritance graphs, and a
  role's grants and membership graphs, instead of staggering based on each
  node's own label length.
- **A role's membership graph is now rendered by its own diagram panel**,
  with plain glyph-and-label nodes and a distinct role icon, instead of being
  drawn through the foreign-key relationship diagram — so it no longer shows
  a "Highlight FKs without a covering index" checkbox or foreign-key edge
  tooltips that never applied to it.

### Fixed
- **Database, schema, table, and role names containing spaces, `#`, `/`, or
  other special characters now work correctly everywhere the app calls the
  API.** Every request path is now consistently percent-encoded; previously
  such a name could be silently truncated client-side, breaking listing,
  structure loading, and export for that object.
- **Repeatedly changing Direction or Depth on a relation's rooted
  Dependencies or Inheritance diagram no longer leaks memory.** Its per-node
  legend now disposes its old rows instead of just detaching them.
- **Switching a database diagram from Tables mode back to Overview now
  re-fits the view** to the whole diagram instead of leaving it at the
  previous rooted table's zoom level.
- **Fixed a double scrollbar in the Keyboard Shortcuts dialog** when the
  shortcut legend overflowed the dialog's height.
- **A table's Structure tab no longer closes permanently** when adding or
  dropping a constraint or index on a tab that was opened via a deep link or
  a reveal navigation with no navigator node behind it — it now reseeds in
  place, keeping its scroll position and expanded sections.
- **Saved connection presets are no longer wiped out by an unrelated storage
  failure.** Only a genuinely corrupt stored blob now triggers the
  repair-by-deleting-everything path; a quota or security error just fails
  the save and leaves existing presets intact.
- **The Index Suggestions panel's toolbar is no longer squeezed to no
  visible height** above its results table.
- **The Add Foreign Key form's "referenced schema" field now defaults to
  the table's own schema** instead of whichever schema happened to load
  first.
- **A schema's Inheritance diagram no longer fails with a server error when
  the schema has a partitioned table.** Its automatically-created partition
  indexes are now excluded, since they aren't a displayable node kind.
- **A role named `schemas` or `graph` can now be opened from the Roles
  rail.** A URL-matching ambiguity previously routed those specific role
  names to the wrong page.
- **Dropping or renaming a table, view, function, or schema now closes
  every tab open for that object** — including its diagram, dependencies,
  and inheritance tabs, not just its Data/Structure/Definition tab — instead
  of leaving some pointed at an object that no longer exists.
- **Login now returns a generic "Login failed" for any server-side
  rejection** — no CONNECT grant, max connections reached, a protocol
  violation — instead of a response exposing Postgres's raw error text, and
  these attempts now count toward the login lockout like every other
  failure.
- **Exporting a table whose schema or table name contains quotes, newlines,
  or non-ASCII characters no longer risks a malformed or injectable download
  header.**
- **`ALLOW_USER_PRESETS=off` (and other case variants) is now honored.**
  Previously only `0`/`false`/`no` disabled the feature; `off` was silently
  ignored and left it enabled.
- **Logging in again now invalidates the previous session** instead of
  leaving its token valid for up to 30 minutes.
- **CSRF token verification now uses a constant-time comparison**, closing
  a theoretical timing side-channel.

### Internal
- Migrated to `@jimka/typescript-ui` 0.9.0.
- Completed the first pass of a whole-codebase health audit: consolidated
  the backend's duplicated catalog queries and DDL identifier/DROP-statement
  builders onto shared bases, split route registration out of a single
  1,600-line `main.py` into per-resource routers behind a collision-proof
  `/db/` URL segment, converged the frontend's diagram panels onto a shared
  shell, deduplicated the Refresh/Export toolbar wiring and the
  record-view/quick-search controls shared by table and query-result grids,
  and split the `SqlAdminController` god-object into six focused
  collaborator modules behind one `PanelHost` seam.
- Added `DismissDialog` and `ErrorBanner` base classes and migrated the
  About/Changelog/Shortcuts dialogs and existing hand-rolled error banners
  onto them.
- Expanded unit-test coverage across the backend connection/session layer
  and the frontend's diagram-shell state, load-signal accounting, and DDL
  identifier validation.

## [0.8.0] — 2026-08-29

### Added
- **Import table data from a CSV or JSON file.** A table's Data tab gains an
  Import action: drop or pick a file, preview the parsed rows with per-row
  validation errors, then commit them all-or-nothing in one transaction.
- **A table's columns are now editable in place on the Structure tab.**
  Rename a column, retype it, toggle NOT NULL, set or clear a default, or
  add/remove a row, then Save — the same editable SQL preview every DDL
  action uses shows the generated `ALTER TABLE` statements for review
  before they run.
- **The navigator's Types category gets a read-only info tab**, matching
  the existing Sequence and Index info tabs. Double-clicking a type leaf
  (or its new "Show info" context-menu item) opens a tab showing the
  type's category, owning role, and its ordered enum labels or composite
  attributes.
- **Connection presets now save the entered username** alongside
  host/port/database (the password stays per-login, never stored), and one
  preset can be flagged as the default. The login dialog auto-selects the
  default preset on a fresh open, and focuses the first field a selected
  preset leaves blank instead of always focusing the preset picker first.
- **A Debug button in the About dialog** opens the library's
  DiagnosticsOverlay — live FPS, JS heap, DOM node count, and
  component/listener counts — one click away instead of a manual symlink
  and script setup.

### Changed
- **The Import Rows and Run/Execute confirmation dialogs now show a failed
  validation or run as an in-content error banner instead of closing and
  popping a Notification behind the modal backdrop.** Both dialogs' action
  buttons now live in the dialog's chrome bar and validate on click before
  running.

### Fixed
- **A diagram tab now fits its graph to the viewport on first render**,
  instead of opening at a fixed 1x zoom adrift in a mostly-empty canvas
  until some later gesture (or a manual Fit to view) recentred it.
- **Switching the database diagram's Mode, or drilling into it from the
  Overview, now recentres the view when the new graph lands off-screen** —
  previously only the diagram's other control gestures did.

### Internal
- Migrated to `@jimka/typescript-ui` 0.8.0, dropping `DiagramShell`'s own
  fit-on-load workaround for an unrooted diagram panel now that
  `DiagramView`'s `fitOnLoad` default handles it. A panel with a root
  chosen at construction still settles its own viewport, since the library
  has no notion of this shell's root and would otherwise fit the whole
  graph instead.

## [0.7.0] — 2026-08-22

### Changed
- **Selecting and copying values in any data grid — query results, table
  data, the Structure/Sequence/Index panels, and the sidebar
  Properties/Roles inspectors — now works as a rectangular cell-range
  selection instead of browser text selection.** Click-drag selects whole
  cells; Ctrl/Cmd+C, or a cell's right-click Copy entry, copies the
  selected range as tab-separated columns and newline-separated rows.
  Selecting a substring of one cell's text (e.g. part of a long value) is
  no longer possible — only whole cells.
- **Table/Structure/Sequence link references** (the owning-table link in
  Index details, "owned by" in Sequence details) **are now selectable
  text, not just clickable** — drag to select and copy the referenced
  name without navigating to it.
- **Dialog and notification message text is now selectable and
  copyable**, including confirmation prompts and error messages — useful
  for grabbing the exact wording of a database error to search or report.

### Fixed
- **Pressing Enter in the "Save preset" name prompt (opened from the
  login screen) no longer also submits the login form behind it.** The
  two dialogs were stacked, and Enter previously reached both.

### Internal
- Migrated to `@jimka/typescript-ui` 0.7.0.
- Reverted `AppHeader.ts`'s `fontSize`-after-construction workaround now
  that the library's underlying `Text` constructor bug is fixed.

## [0.6.0] — 2026-08-16

### Added
- **Quick search and a header filter row replace the modal Filter dialog**
  on the Data tab, and the same quick search now covers the view/run-SQL
  results grid too. Quick search hides loaded rows client-side with no
  network request and matches against each cell's displayed text —
  including dates, times, and combo labels — rather than its raw stored
  value; the header filter row reloads page 1 per column filter, and the
  two compose.
- **The header filter row now supports date, time, and datetime columns.**
- **The Database and Roles rail trees remember which nodes were
  expanded** across a reload, instead of starting fully collapsed every
  time.
- **A flat, schema-wide Indexes category** lists every index across a
  schema's tables in the navigator, each opening a read-only tab with its
  unique/primary flags, a link to its owning table's Structure tab, and
  its full `CREATE INDEX` text.
- **A toolbar Refresh button on the Structure, Definition, Sequence, and
  Index tabs**, matching the data grid's own Refresh — Alt+R and View →
  Refresh now work on these tabs too.
- **Deep links.** A URL now addresses a specific table, view, schema,
  database, role, sequence, index, function, or notes view — nested under
  its schema, matching the navigator's own containment — and opening one
  syncs the sidebar tree selection to match, even before the tree has
  finished its initial load.

### Changed
- **"Show database diagram" moved to a Database accordion header tool
  button**, next to Create schema and Refresh, out of the schema node's
  right-click Show submenu.
- **The Explain diagram's info accordion is resizable**, with real
  minimum floors for Summary and Plan steps instead of both being
  crushed toward zero by a large plan's flattened tree.
- **Previous/Next record stepping now respects the live quick-search
  query**, skipping records the current search doesn't match.
- **The Data tab loads behind a spinner**, and re-running a query keeps
  the previous grid visible until the new one is confirmed to hold rows —
  a failed run shows a durable in-panel error banner instead of
  destroying an already-loaded grid.
- **The TableWorkPanel toolbar was trimmed** per live user-testing
  feedback: the redundant Filter toggle (duplicated by the grid's own
  header menu) and the separate quick-search status label are gone; the
  match count now reports through the shared status line instead.
- **Refresh buttons moved to each toolbar's far right**, mirroring the
  data grid's Save-left/Refresh-right layout, across the Definition,
  Sequence, and Index tabs.

### Fixed
- **Re-running a query no longer flashes two Data tabs during the
  fetch**, and no longer strands editor focus on the Data tab once the
  new grid lands.
- **Diagram legend rows are disposed on rebuild instead of just
  detached**, fixing a listener leak that grew with every root,
  direction/depth, or schema-toggle change.
- **Dragging the sidebar gutter while the start page is showing no
  longer snaps the navigator rail open unexpectedly wide.** The page's
  two content columns are now pinned to a fixed width and a trailing
  flex spacer absorbs the rest, so the row's own reported max width
  stays unbounded instead of clamping the split's drag floor.

### Internal
- Migrated to `@jimka/typescript-ui` 0.6.0, including migrating
  `BoxLayout`'s deprecated `stretching` option to `itemAlign: "stretch"`
  across every call site.
- Unit-test coverage for deep-link route parsing, tree-expansion
  persistence, quick-search matching, and the flattened Indexes
  navigator rows.

## [0.5.0] — 2026-08-09

### Added
- **A record view for tables and query results.** The data grid and the SQL
  workspace's query results grid both gain a toolbar toggle that flips
  between the normal grid and a one-record-at-a-time field/value view, with
  Previous/Next buttons to step through the loaded rows. On the data grid,
  Add is disabled while the record view is showing, since only the grid can
  fill in a new row.
- **A Changelog dialog joins Shortcuts and About** on the menu bar. It opens
  a modal titled "SQLAdmin 0.5.0" and renders this file with the library's
  Markdown viewer — the body is the real CHANGELOG.md, inlined at build
  time, so it can never drift from the release.

### Changed
- **The start page's layout was simplified.** The welcome blurb now sits
  above quick actions in the left column instead of spanning the full page
  width, the redundant "SQLAdmin" heading and Connection line are gone (the
  app header already shows both), and both columns are capped at a fixed
  maximum width and pinned to the row's top edge instead of stretching and
  drifting off-center on a wide window.
- **The SQL preview dialog grows to fit the generated SQL** instead of
  scrolling a fixed 180px box, up to a 24-row cap.

### Fixed
- **Opening a table from a sequence's "Owned by column" link no longer
  delays the tab.** Revealing the target in the navigator — expanding
  whatever schema branches were still collapsed — used to run to completion
  before the tab opened at all. The reveal now runs concurrently with the
  tab's own open, so the tab appears at once and the navigator selection
  lands whenever the reveal resolves. The same fix applies to opening a
  referenced table from a foreign key, and to a sequence's or table's own
  cross-reference links.

### Internal
- Migrated to `@jimka/typescript-ui` 0.5.0.
- Unit-test coverage for the record-view step logic and the changelog
  dialog's build-time inlining.

## [0.4.0] — 2026-08-04

### Added
- **SQLAdmin now wears its own browser-tab icon** — a database-drum mark on a
  rounded plate — instead of the library's default one.

### Changed
- **Grid columns size themselves from their content.** The main data grid,
  the Columns/Indexes/Constraints grids, the foreign-keys grid, query
  results, and role grants now derive column widths from a sample of the
  loaded rows instead of splitting the available width evenly. The
  Property/Value inspector keeps a fixed label column instead, since its
  store is reseeded on every selection.
- **Schema diagram nodes are sized from a real text measurement** instead of
  an estimate from character count, so nodes are tighter and long table
  names no longer clip.

### Fixed
- **Closing a table tab no longer leaks stylesheet rules.** The dock did not
  dispose a closed tab's content, so repeatedly opening and closing a wide
  table could strand thousands of orphaned rules and gradually slow the app
  down. Closing a tab now tears its content down properly.

### Internal
- Migrated to `@jimka/typescript-ui` 0.4.1.
- Deleted the app's own tab-teardown bookkeeping — the `PanelDisposers`
  registry, the `disposeOnClose` flag, and every composition wrapper's
  `dispose` field — now that the library owns it.

## [0.3.0] — 2026-07-27

### Added
- **One shell for every diagram.** All six diagram panels now offer the same
  controls — pick or change the root, set direction and depth, prune and hide
  nodes — instead of three rooted panels and three fixed ones.
- **Right-click a diagram node** for the same object menu the navigator
  offers for that object.
- **Answerable edges.** Foreign-key edges carry hover tooltips and respond to
  clicks, and selecting a column dims every card its keys do not touch.
- **A depth limit with an expand indicator**, so a rooted diagram opens on a
  readable slice and marks the nodes whose neighbours were left out.
- **More demo seed data** — the `hub` and `mesh` test schemas, plus a `wide`
  schema whose tables step from 10 to 60 columns for wide-grid testing.

### Changed
- **ELK layout runs in a Web Worker.** Opening the 154-table `hub` schema
  diagram no longer freezes the window, and closing a diagram tab terminates
  the worker it was using.
- **One request per diagram instead of two per table.** Schema, database and
  relation diagrams fetch their metadata in a single bulk call.
- **Edges merge into junctions near the node they fan out from**, and table
  cards were reworked — geometry, tooltips, uniform widths, and a busy
  overlay while a live diagram recomputes.
- **A role's grants tab opens before its detail arrives**, matching the rest
  of the app's tab-first loading.
- **The navigator's Show submenu uses a distinct glyph per diagram kind.**
- **elkjs 0.12.0**, which is dual-licensed `EPL-2.0 OR GPL-3.0-or-later`; the
  third-party notices record both.

### Internal
- Migrated to `@jimka/typescript-ui` 0.3.0.
- Unit-test coverage for the diagram model builders — cardinality, edge
  stubs, column emphasis, card geometry.

## [0.2.0] — 2026-07-23

### Added
- **Persistent app header.** A brand strip above the menu bar now shows the app
  name and version at all times, with About access alongside it. The name,
  version, and tagline are sourced from a single `appIdentity` module, and the
  displayed version is injected from `package.json` at build time so it can
  never drift from the release.

### Changed
- **Faster table opens.** Opening a table coalesces and parallelizes its
  metadata fetches instead of requesting them serially.
- **Tab-first lazy loading.** The dock panels now open their tab immediately and
  load content lazily, so tabs appear instantly rather than blocking on their
  data.
- **Licensing clarified.** README, license, and third-party notices spell out
  the PolyForm Noncommercial terms — internal business use is barred, and
  commercial licenses are offered.

### Internal
- Migrated to `@jimka/typescript-ui` 0.2.0, including the new Size-object setter
  API.
- Standardized the app shell on callable component construction.
- `dev` and `build` now type-check before running.

## [0.1.0] — Initial release

First public release: browse schemas and roles, edit rows, run and EXPLAIN SQL,
and visualize schema and role relationships as diagrams.

[0.10.0]: https://github.com/jimka/sqladmin/releases/tag/v0.10.0
[0.9.0]: https://github.com/jimka/sqladmin/releases/tag/v0.9.0
[0.8.0]: https://github.com/jimka/sqladmin/releases/tag/v0.8.0
[0.7.0]: https://github.com/jimka/sqladmin/releases/tag/v0.7.0
[0.6.0]: https://github.com/jimka/sqladmin/releases/tag/v0.6.0
[0.5.0]: https://github.com/jimka/sqladmin/releases/tag/v0.5.0
[0.4.0]: https://github.com/jimka/sqladmin/releases/tag/v0.4.0
[0.3.0]: https://github.com/jimka/sqladmin/releases/tag/v0.3.0
[0.2.0]: https://github.com/jimka/sqladmin/releases/tag/v0.2.0
[0.1.0]: https://github.com/jimka/sqladmin/releases/tag/v0.1.0

