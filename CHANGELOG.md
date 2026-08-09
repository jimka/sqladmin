# Changelog

All notable changes to SQLAdmin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.5.0]: https://github.com/jimka/sqladmin/releases/tag/v0.5.0
[0.4.0]: https://github.com/jimka/sqladmin/releases/tag/v0.4.0
[0.3.0]: https://github.com/jimka/sqladmin/releases/tag/v0.3.0
[0.2.0]: https://github.com/jimka/sqladmin/releases/tag/v0.2.0
[0.1.0]: https://github.com/jimka/sqladmin/releases/tag/v0.1.0
