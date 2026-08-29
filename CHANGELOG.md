# Changelog

All notable changes to SQLAdmin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Migrated to `@jimka/typescript-ui` 0.8.0.

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

[0.8.0]: https://github.com/jimka/sqladmin/releases/tag/v0.8.0
[0.7.0]: https://github.com/jimka/sqladmin/releases/tag/v0.7.0
[0.6.0]: https://github.com/jimka/sqladmin/releases/tag/v0.6.0
[0.5.0]: https://github.com/jimka/sqladmin/releases/tag/v0.5.0
[0.4.0]: https://github.com/jimka/sqladmin/releases/tag/v0.4.0
[0.3.0]: https://github.com/jimka/sqladmin/releases/tag/v0.3.0
[0.2.0]: https://github.com/jimka/sqladmin/releases/tag/v0.2.0
[0.1.0]: https://github.com/jimka/sqladmin/releases/tag/v0.1.0

