# typescript-ui 0.4.0 Upgrade — Implementation Plan

## Overview

Move SQLAdmin from `@jimka/typescript-ui` 0.3.0 to 0.4.0: change one range in [`frontend/package.json:20`](frontend/package.json#L20), regenerate the lockfile against the published package, then look at everything 0.4.0 changes on screen for free. The library release is not code the app calls — it is 194 commits of rendered-output change, and the app declares no widths on any of its grids, so the visible result lands whether or not a line of app code moves.

Three pieces of app work come with the bump. SQLAdmin must supply its own browser-tab icon, because 0.4.0's `Body.init` installs the *library's* mark by default and [`frontend/index.html`](frontend/index.html) declares none. The one hands-on regression — horizontal scrolling in a wide grid feels sluggish — has to be turned into a number and routed to whoever owns it. And a batch of repo paperwork is stale: [`CHANGELOG.md`](CHANGELOG.md) never got a `0.3.0` entry, [`TODO.md:58-93`](TODO.md#L58) carries two loose ends that are already resolved, and [`frontend/vite.config.ts:4`](frontend/vite.config.ts#L4) still describes the library as a `file:` dependency.

The upgrade cannot start until typescript-ui publishes 0.4.0 to the registry — the lockfile is regenerated from the published tarball, and there is nothing else to regenerate it from. The paperwork does not wait; the steps are ordered so it lands first.

---

## Architecture Decisions

### The bump is gated on publication, and the app comes off the symlink

Step 6 is a hard gate: `npm view @jimka/typescript-ui version` must report `0.4.0` before any step after it runs. The install then replaces `frontend/node_modules/@jimka/typescript-ui` — a hand-made symlink to the sibling checkout today — with the published tarball, and it stays that way. The whole verification sweep runs against the registry copy.[^symlink-end-state]

This mirrors [`plans/implemented/elkjs-0-12-upgrade.md:117-127`](plans/implemented/elkjs-0-12-upgrade.md#L117), the nearest precedent in this repo: a manifest range edit, one install, a dep-cache clear, a paperwork pass, and a manual surface sweep as the substantive check. That plan's own Non-Goals named this bump as the thing it could not do yet, because the registry held no version to point at.

### `--legacy-peer-deps` is already gone, and only `TODO.md` still says otherwise

The install runs as a plain `npm install`. The published 0.3.0 already declares `peerOptional elkjs@^0.12.0`, which the app's own `elkjs: ^0.12.0` satisfies, so the `ERESOLVE` that forced the flag died with the 0.3.0 upgrade rather than this one.[^peer-already-fixed] The workaround survives in exactly one place that is not a historical record: the paragraph at [`TODO.md:86-93`](TODO.md#L86). Step 3 deletes it.

### SQLAdmin ships its own mark, as a data URI in `appIdentity.ts`

`APP_MARK_SVG` and `APP_FAVICON` join `APP_NAME` / `APP_VERSION` / `APP_TAGLINE` in [`frontend/src/appIdentity.ts`](frontend/src/appIdentity.ts), and [`frontend/src/SqlAdminApp.ts:20`](frontend/src/SqlAdminApp.ts#L20) passes `favicon: APP_FAVICON` to `Body.init`. The mark is a database drum on a rounded plate, sized on a 32-unit viewBox and carrying its own `prefers-color-scheme` rule, mirroring the shape and palette of the library's own `MARK_SVG`.[^favicon-decision]

Three sources can set the tab icon; the library resolves them in this order:

| What the page declares | What SQLAdmin does | Resulting tab icon |
|---|---|---|
| `<link rel="icon">` in `index.html` | nothing — `index.html` has none | — |
| `Body.init({ favicon })` | passes `APP_FAVICON` | **SQLAdmin's drum mark** |
| neither | (what today's code does) | the library's `DEFAULT_FAVICON` bar-and-pane mark |

### The sluggish horizontal scroll is measured and recorded here, not fixed here

Part E produces a number for the reported scroll regression and files it where this repo already files found-but-unfixed defects. No fix lands in this plan in either direction, because the shape of an app-side fix cannot be known before the measurement exists.[^scroll-no-fix] Where the finding is recorded follows from what the measurement says:

| What the measurement shows | Where it is recorded |
|---|---|
| Scroll-window self time sits in `/src/*` frames (app code) | a `TODO.md` "Known issues" bullet naming the app site and the number |
| Scroll-window self time sits in `@jimka/typescript-ui` frames | a `LIBRARY_NOTES.md` entry (🐞🔎) carrying the number, plus a one-line `TODO.md` bullet pointing at it |

`LIBRARY_NOTES.md` is this repo's standing channel for library defects, and the `MemoryStore.loadData` bug is the precedent for the two-place form: the detail lives in `LIBRARY_NOTES.md` and [`TODO.md:56`](TODO.md#L56) carries a one-line pointer.

### `vite.config.ts` keeps every setting; only its comments change

No config is deleted. `fs.strict: false` and `resolve.dedupe` still serve the symlink workflow a developer uses to test an unreleased library build, `optimizeDeps.exclude` is what makes the elkjs `include` beneath it necessary, and `esbuild.keepNames` is still load-bearing for the production bundle.[^vite-config] Two comments state things that stopped being true: the header calls the library a `file:../../typescript-ui` dependency, and the `optimizeDeps` note calls the installed-package case a `^0.1.0` resolution.

### `LIBRARY_NOTES.md` gains no ✅ flips

Every entry in that file except two is already `✅ fixed in library`. The two open ones both survive 0.4.0 untouched: the `Text` constructor `fontSize` papercut is unfixed upstream, so its `AppHeader` workaround stays, and the `keepNames` papercut's library-side fix is deferred.[^library-notes-audit] The file changes only if Part E routes the scroll finding to it.

---

## Public API

New exports from `frontend/src/appIdentity.ts`:

```ts
/** The app's mark, as inline SVG. Exported for the encoding round-trip test. */
export const APP_MARK_SVG: string;

/** The app's mark as a ready-to-use `data:` URI, for `Body.init`'s `favicon`. */
export const APP_FAVICON: string;
```

The exact SVG string, which the implementer copies verbatim:

```ts
export const APP_MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.plate{fill:#FFFFFF}.mark{fill:#000000}@media(prefers-color-scheme:dark){.plate{fill:#505050}.mark{fill:#78AAF0}}</style><clipPath id="plate"><rect width="32" height="32" rx="6"/></clipPath><g clip-path="url(#plate)"><rect class="plate" width="32" height="32"/><ellipse class="mark" cx="16" cy="8" rx="10" ry="4"/><rect class="mark" x="6" y="8" width="20" height="16"/><ellipse class="mark" cx="16" cy="24" rx="10" ry="4"/><rect class="plate" x="6" y="13" width="20" height="2"/><rect class="plate" x="6" y="19" width="20" height="2"/></g></svg>';

export const APP_FAVICON = `data:image/svg+xml,${encodeURIComponent(APP_MARK_SVG)}`;
```

`encodeURIComponent` is not decoration: the raw string contains `url(#plate)`, and an unescaped `#` truncates the URI there, dropping the clip path and rendering a blank tab icon with nothing in the console.

The changed call in `frontend/src/SqlAdminApp.ts`:

```ts
Body.init({ layoutManager: Fit(), favicon: APP_FAVICON });
```

---

## Ordered Implementation Steps

### Part A — paperwork that does not wait for the release

1. **`CHANGELOG.md`** — insert the missing `0.3.0` entry immediately above line 7's `## [0.2.0] — 2026-07-23`, separated from it by a blank line. Reconstructed from `git log v0.2.0..v0.3.0` and the sixteen plans filed under `plans/implemented/` in that range:

   ```markdown
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
   ```

   Then add the release link `[0.3.0]: https://github.com/jimka/sqladmin/releases/tag/v0.3.0` immediately above the existing `[0.2.0]:` line at the bottom of the file.
   Check: `grep -c '^## \[' CHANGELOG.md` → `3`.

2. **`TODO.md`** — delete the whole bullet at lines 58-75 ("**Resolved pending release: disposing a component mid-transition threw a stray console error**"). The fix it describes shipped in the published 0.3.0 the app already depends on, so nothing about it is pending.[^transition-fix-shipped]

3. **`TODO.md`** — delete the whole bullet at lines 76-93 (line numbers are the ones before step 2's deletion), both paragraphs: the `"^0.2.0"` range claim and the `ERESOLVE` / `--legacy-peer-deps` paragraph. Every fact in it is spent: the range is `^0.3.0`, `elkWorkerFactory` and the Worker disposal path are in the published 0.3.0, and the peer conflict is gone.[^peer-already-fixed]
   Leave the three surrounding bullets exactly as they are — prod-build class-name mangling (line 51), the `MemoryStore.loadData` zero-render bug (line 56), and the large-diagram first-render freeze (line 94). None is fixed in 0.4.0.
   Check: `grep -n 'legacy-peer-deps\|\^0\.2\.0\|Resolved pending release' TODO.md` → zero matches; `grep -c '^- \*\*' TODO.md` → `14` (16 before the two deletions).

4. **`frontend/vite.config.ts`** — replace the header comment above `export default defineConfig` (lines 4-9) with:

   ```ts
   // The library is consumed as a published package from the npm registry. The
   // dev-server accommodations below still earn their place:
   //   - fs.strict off: testing an unreleased library build means replacing
   //     frontend/node_modules/@jimka/typescript-ui with a symlink to the sibling
   //     ../typescript-ui checkout, which vite resolves to a real path outside
   //     this project root and will not serve under the default strict rule.
   //   - dedupe + optimizeDeps.exclude: keep one copy of the linked ESM lib, and
   //     keep vite's dep scanner out of it (which is what makes the explicit
   //     elkjs include below necessary).
   //   - /api proxy: the frontend issues relative /api/... calls; forward them to
   //     the FastAPI backend so requests stay same-origin (no CORS in dev).
   ```

5. **`frontend/vite.config.ts`** — in the `optimizeDeps` comment, replace the sentence "This only bites when the library is an installed package (a real node_modules copy, as the published `^0.1.0` resolves); with the `file:` symlink vite scanned the linked source and pre-bundled elkjs on its own." with:

   ```ts
        // Pre-bundling elkjs explicitly restores a proper default export. This only
        // bites when the library is an installed package (a real node_modules copy —
        // the standing arrangement); under a hand-made symlink to the local checkout
        // vite scans the linked source and pre-bundles elkjs on its own.
   ```

   Leave `esbuild: { keepNames: true }` and its comment untouched — that setting is still required, and the library-side fix for it is deferred.
   Check: `grep -n 'file:../../typescript-ui\|\^0\.1\.0' frontend/vite.config.ts` → zero matches.

### Part B — the dependency bump (blocked on the library release)

6. **Gate.** Run `npm view @jimka/typescript-ui version`. It must print `0.4.0`. If it prints anything else, **stop here and report** — every step below needs the published tarball, and Part A's work stands on its own.

7. **Install prep.** If `frontend/node_modules` inside this worktree is a symlink to the main tree's copy, remove the symlink first and let step 9 create a real install. An `npm install` through the symlink writes into the main tree's `node_modules`.[^worktree-install]

8. **`frontend/package.json:20`** — `"@jimka/typescript-ui": "^0.3.0"` → `"^0.4.0"`. Leave `"elkjs": "^0.12.0"` on line 21 alone.

9. **Install** — `cd frontend && npm install`. Plain, no flags. If this exits with `ERESOLVE`, stop and report: it would mean the published 0.4.0's elkjs peer range disagrees with the app's `^0.12.0`, which is a library packaging problem, not something to work around here.

10. **Confirm the install**, from the repo root. All three must hold:
    - `node -p "require('./frontend/node_modules/@jimka/typescript-ui/package.json').version"` → `0.4.0`
    - `ls -ld frontend/node_modules/@jimka/typescript-ui` → a real directory, **not** a symlink
    - `git diff frontend/package-lock.json` → the `node_modules/@jimka/typescript-ui` entry resolves `typescript-ui-0.4.0.tgz`

11. **Clear the Vite dep cache** — `rm -rf frontend/node_modules/.vite`. A stale pre-bundled elkjs renders every diagram empty with no console error.[^vite-cache]

12. **`THIRD-PARTY-NOTICES.md:249`** — `| @jimka/typescript-ui | 0.1.0 | PolyForm-Noncommercial-1.0.0 |` → `| @jimka/typescript-ui | 0.4.0 | PolyForm-Noncommercial-1.0.0 |`. The row has been stale since 0.2.0. Hand-edit the one row; do not run `scripts/generate_third_party_notices.py`, which also rebuilds the Python table and needs the backend virtualenv.[^notices-precedent]
    Then check no *other* row drifted when the lockfile regenerated:

    ```bash
    cd frontend && npm query ':not(.dev)' | python3 -c '
    import json, re, sys
    have = {p["name"]: p["version"] for p in json.load(sys.stdin)}
    for line in open("../THIRD-PARTY-NOTICES.md"):
        m = re.match(r"\| (\S+) \| (\S+) \|", line)
        if m and m.group(1) in have and have[m.group(1)] != m.group(2):
            print("drift:", m.group(1), m.group(2), "->", have[m.group(1)])'
    ```

    → no output. Any line it prints is a row to update the same way.

13. **Checkpoint.** `cd frontend && npm run typecheck && npm test && npm run build`. All three must pass. The typecheck is the compile-level proof that none of 0.4.0's removed APIs is called from this app.[^no-removed-api]

### Part C — the favicon

14. **`frontend/src/appIdentity.ts`** — append `APP_MARK_SVG` and `APP_FAVICON`, both exported, with a doc comment on each ([Public API](#public-api) carries the exact SVG string). Only `APP_FAVICON` has a caller; `APP_MARK_SVG` is exported so the round-trip test can import it, and its doc comment says so, matching how the library exports its own `MARK_SVG`. The comment on `APP_MARK_SVG` must state the geometry the way the library's does: a 32-unit viewBox so every dimension is a whole number at 16px tab size; plate 32×32 with a 6-unit corner radius; drum spanning x 6-26, top ellipse at cy 8, body 8-24, bottom ellipse at cy 24, two 2-unit bands at y 13 and y 19. The dark-mode pair `#505050` / `#78AAF0` is lifted from the library's mark so the two sit together.

15. **`frontend/src/SqlAdminApp.ts:20`** — `Body.init({ layoutManager: Fit() })` → `Body.init({ layoutManager: Fit(), favicon: APP_FAVICON })`, and add `APP_FAVICON` to the imports from `./appIdentity`.

16. **`frontend/tests/appIdentity.test.ts`** (new) — the three cases in [Expected Behaviour](#unit-testable). Model the file on `frontend/tests/shell/appHeaderText.test.ts`.

17. **Checkpoint.** `cd frontend && npm run typecheck && npm test`.

### Part D — the verification sweep

18. **Bring the stack up and log in** per `.claude/skills/verify/SKILL.md` — Postgres, backend, `npm run dev`, Host `sqladmin-db`. Skip that document's "Library changes" section: there is no symlink and no `build:lib` step any more. Every check below is a manual one; the tables in [Expected Behaviour](#manual-verify--grids) say what to look at and what correct means.

19. **Grid pass** — [Expected Behaviour › grids](#manual-verify--grids). Eleven on-screen grids across nine `Table(...)` construction sites.

20. **Startup font-hold pass** — 0.4.0 holds the first layout flush until the web font activates, so callbacks queued during startup run after that release instead of on the first frame. Exercise it by **reloading the page while logged in**, the only boot path that reaches the shell inside the hold's window, and check the sites listed in [Expected Behaviour › startup](#manual-verify--the-startup-font-hold).

21. **Markdown marker pass** — [Expected Behaviour › markdown](#manual-verify--markdown-markers).

22. **Pixel pass** — [Expected Behaviour › pixels](#manual-verify--the-pixel-shifts).

23. **`.claude/skills/verify/SKILL.md`** — rewrite the "Library changes" section to say the library is an installed package, and that the symlink plus `npm run build:lib` is the temporary override for testing an unreleased library build. Also drop the "`favicon.ico` 404s on every load — pre-existing, ignore it" gotcha, which step 15 fixes. This file is untracked (`.claude/` is not in git), so it will not appear in `git status`.

### Part E — the horizontal-scroll measurement

24. **Open the widest grid.** Navigator → `wide` → `cols_60` → the table's Data tab. Sixty columns of mixed types — wider than the 45-column table the library's own changelog benchmarks, and the widest grid this app can open.

25. **Measure a horizontal scroll**, both ways, at a viewport of 1500×800:
    - **Blocking**, via the heartbeat technique this repo already used for the ELK worker measurement: install `setInterval(() => ticks.push(performance.now()), 20)` before the scroll, scroll the grid from its far left to its far right in one continuous gesture, stop the interval, and report the largest gap between consecutive ticks plus the count of gaps over 50 ms. The grid's scrollbars are the library's own overlay ones, so if the `drag` tool cannot grab the horizontal bar, drive the same distance by dispatching `wheel` events with a `deltaX` over the grid, one per animation frame. A macrotask callback cannot run while the main thread is blocked, so the largest gap is a direct lower bound on the longest block.[^heartbeat]
    - **Attribution**, via a `performance_start_trace` / `performance_stop_trace` pair around the same gesture. Group main-thread self time in the scroll window by script URL.

26. **Run the two controls**, each the same gesture and the same measurement. Both aim at the same question: 0.4.0 builds cells only for the columns currently in view — the column window — and recycles them as that window slides, which is the mechanism the regression appeared with.
    - **Column count** — repeat on `wide.cols_10`. If per-scroll cost falls with the column count, the cost is in the code that reconciles the column window rather than in per-frame work every table pays.
    - **Window crossing** — scroll a few pixels at a time inside one column's width, then a distance that crosses several column boundaries. If cost appears only when the window slides, it is cell construction and recycling, not scroll handling.

27. **Record the finding** per the routing table in [Architecture Decisions](#the-sluggish-horizontal-scroll-is-measured-and-recorded-here-not-fixed-here). Whichever side it lands on, the written entry carries: the grid and column count, the max inter-tick gap, the count of gaps over 50 ms, the self-time split by script URL, and both control results. A `LIBRARY_NOTES.md` entry goes at the top of the file (newest first) under a `## 🐞🔎` heading, following the existing entries' shape.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `CHANGELOG.md` (backfill the `0.3.0` entry + its release link) |
| Modify | `TODO.md` (delete two spent loose ends; one new bullet from Part E) |
| Modify | `frontend/vite.config.ts` (two comments; no config change) |
| Modify | `frontend/package.json` (`@jimka/typescript-ui` → `^0.4.0`) |
| Modify | `frontend/package-lock.json` (regenerated by `npm install`) |
| Modify | `THIRD-PARTY-NOTICES.md` (inventory row for `@jimka/typescript-ui`) |
| Modify | `frontend/src/appIdentity.ts` (`APP_MARK_SVG`, `APP_FAVICON`) |
| Modify | `frontend/src/SqlAdminApp.ts` (`favicon: APP_FAVICON`) |
| Create | `frontend/tests/appIdentity.test.ts` |
| Modify | `LIBRARY_NOTES.md` (only if Part E routes the finding upstream) |
| Modify | `.claude/skills/verify/SKILL.md` (untracked; library-changes section + favicon gotcha) |

---

## Expected Behaviour

### Unit-testable

`frontend/tests/appIdentity.test.ts`, three cases:

| Case | Assertion |
|---|---|
| `APP_FAVICON` is an SVG data URI | starts with `data:image/svg+xml,` |
| the encoding round-trips | `decodeURIComponent(APP_FAVICON.slice("data:image/svg+xml,".length))` equals `APP_MARK_SVG` |
| the mark adapts to dark chrome | `APP_MARK_SVG` contains `prefers-color-scheme:dark` |

Everything else in this plan is rendered output, which the node-environment test runner cannot see. The existing 45 test files must stay green unchanged; none of them constructs a library component.

### Manual-verify — grids

Nine `Table(...)` construction sites produce eleven on-screen grids. None declares a column width, so all of them move from an equal share of the host's width to widths derived from each column's type and header.

| Grid | Site | How to open | Correct looks like |
|---|---|---|---|
| Table data grid | [`dock/TableWorkPanel.ts:70`](frontend/src/dock/TableWorkPanel.ts#L70) via `buildColumnSpec` | open any table | narrow types (`boolean`, `date`) no longer as wide as `text`; the grid scrolls horizontally rather than squeezing |
| Columns (with Sequence link) | [`dock/columnsGrid.ts:98`](frontend/src/dock/columnsGrid.ts#L98) | table → Structure → Columns | all seven headers readable; the Sequence link cell not clipped |
| Columns (read-only) | [`dock/columnsGrid.ts:65`](frontend/src/dock/columnsGrid.ts#L65) | view/matview → Definition | same, without the link column |
| Indexes | `columnsGrid.readOnlyTable` via [`dock/StructurePanel.ts:337`](frontend/src/dock/StructurePanel.ts#L337) | table → Structure → Indexes | headers readable, no column collapsed to a sliver |
| Constraints | `columnsGrid.readOnlyTable` via [`dock/StructurePanel.ts:360`](frontend/src/dock/StructurePanel.ts#L360) | table → Structure → Constraints | as above |
| Foreign keys | [`dock/StructurePanel.ts:406`](frontend/src/dock/StructurePanel.ts#L406) | table → Structure → Foreign keys | the `refTable` link column still wide enough to read |
| Query result | [`dock/QueryResultView.ts:62`](frontend/src/dock/QueryResultView.ts#L62) | run `select * from wide.cols_60` | 60 columns, horizontal scroll, header text intact |
| Role grants | [`dock/RoleGrantsPanel.ts:50`](frontend/src/dock/RoleGrantsPanel.ts#L50) | Roles → a role → Grants | four columns fit the panel without a scrollbar |
| Property/Value | [`properties/PropertyValuePanel.ts:55`](frontend/src/properties/PropertyValuePanel.ts#L55) | sequence or function info tab | the Property column sized to its content, Value taking the rest — **not** Value pushed out of view |
| Explain summary | [`dock/ExplainDiagramPanel.ts:287`](frontend/src/dock/ExplainDiagramPanel.ts#L287) | run an EXPLAIN → diagram panel | fits the fixed-width left pane, or scrolls; no clipped header |
| Explain steps | [`dock/ExplainDiagramPanel.ts:308`](frontend/src/dock/ExplainDiagramPanel.ts#L308) | same panel | Action + Cost readable; revealing a hidden column still lands sensibly |

A regression is a column so narrow its header is unreadable, a header clipped horizontally, or a grid whose last column is unreachable by scrolling. Wider columns and a new horizontal scrollbar are the expected change, not a regression. The two narrow hosts — Property/Value and the Explain summary — are the ones most likely to overflow, and are the reason both are listed separately.

### Manual-verify — the startup font hold

0.4.0 holds the first layout flush until the web font activates, bounded at 50 ms, and defers `Tree` and table-body renders with it. Callbacks queued during that window run after the release rather than on the first frame.

The window only covers a boot that reaches the shell without waiting for a human: **reload the page while logged in**, so `whoami()` resolves from the session cookie and the shell is built immediately.[^hold-window] Check, in one reload:

| Site | What to watch |
|---|---|
| [`shell/StartPage.ts:119`](frontend/src/shell/StartPage.ts#L119) — `this.doLayout()` at the end of `rebuild` | the start page's heading, welcome text and columns land in one piece; no visible re-flow after the first frame |
| [`shell/QueriesView.ts:266`](frontend/src/shell/QueriesView.ts#L266) — `afterNextLayout(() => target.focus())` | the sidebar's saved-query list still takes focus when a query is revealed |
| the navigator and roles trees | rows are present after the reload, not an empty tree that fills in late |

Then, from the loaded app (these open after the hold has released, and must be unchanged):

| Site | What to watch |
|---|---|
| [`dock/QueryPanel.ts:327-348`](frontend/src/dock/QueryPanel.ts#L327) — `seedEditorHeight` | a new query panel opens with the editor at its seeded height and the result pane below it — not an editor filling the panel with a blank south region |
| [`dock/QueryPanel.ts:949`](frontend/src/dock/QueryPanel.ts#L949) | the SQL editor has focus with the caret at the end of any seeded text |
| [`dock/QueryPanel.ts:964`](frontend/src/dock/QueryPanel.ts#L964) | "Open as query" with auto-run still runs, and its result renders |
| [`dock/DocumentationPanel.ts:33`](frontend/src/dock/DocumentationPanel.ts#L33) | the Notes editor takes focus when the panel opens |

### Manual-verify — markdown markers

`BulletedList` and `NumberedList` paint their own markers now, sharing one right-aligned marker column per list.

- **Start page welcome** — the three-item list at [`shell/StartPage.ts:57-59`](frontend/src/shell/StartPage.ts#L57), visible when there are no recent tables and no saved queries (clear localStorage to force it). Correct: three bullets sharing one right edge, three labels sharing one left edge, no marker clipped and no label wrapping under its own marker.
- **Notes panel** — [`dock/DocumentationPanel.ts`](frontend/src/dock/DocumentationPanel.ts) is a `MarkdownEditor` over user text, so type both a `-` bulleted list and a `1.` numbered list into it. Correct: markers render, and a two-digit item number in a list of ten or more still fits its column without pushing its label out of alignment with item 1's.

### Manual-verify — the pixel shifts

Four small geometry changes, each checked once. None should be *visible* as a defect; the check is that nothing clips or overlaps.

| Change | Where to look |
|---|---|
| table header band 1px taller; body origin and every row shift down 1px | any grid — header text not clipped at its bottom edge, no gap or overlap at the header/body divider |
| a `Dialog`'s close button moves up 1px | Help → About; the close glyph still centred in its title bar |
| a `Tooltip`'s outer box grows 2px each way | hover a toolbar button — label not clipped, box not visibly off-centre from the pointer |
| a `DragGhost`'s label loses 2px each way | drag a dock tab — the ghost's label still fully readable |

---

## Verification

| # | Where | Command | Expect |
|---|---|---|---|
| 1 | repo root | `grep -n 'legacy-peer-deps\|\^0\.2\.0' TODO.md` | zero matches |
| 2 | repo root | `grep -c '^## \[' CHANGELOG.md` | `3` |
| 3 | repo root | `grep -c 'file:../../typescript-ui\|\^0\.1\.0' frontend/vite.config.ts` | `0` (it finds 2 today) |
| 4 | repo root | `grep -c 'keepNames' frontend/vite.config.ts` | `3`, unchanged (the setting plus two mentions in its comment) |
| 5 | shell | `npm view @jimka/typescript-ui version` | `0.4.0` |
| 6 | `frontend` | `node -p "require('./node_modules/@jimka/typescript-ui/package.json').version"` | `0.4.0` |
| 7 | `frontend` | `ls -ld node_modules/@jimka/typescript-ui` | a directory, not a symlink |
| 8 | repo root | `grep -n 'typescript-ui .* 0\.4\.0' THIRD-PARTY-NOTICES.md` | the inventory row |
| 9 | `frontend` | `npm run typecheck` | clean |
| 10 | `frontend` | `npm test` | green — 45 existing files plus `appIdentity.test.ts` |
| 11 | `frontend` | `npm run build` | succeeds |
| 12 | browser | the tab icon | SQLAdmin's drum mark, not the library's bar-and-pane mark; no `/favicon.ico` 404 in the network log |
| 13 | browser | Parts D and E | every table in [Expected Behaviour](#expected-behaviour) walked; Part E's numbers recorded |

Rows 1-11 establish that the bump is wired consistently. Rows 12-13 are the substantive checks — nothing automated in this repo can see rendered geometry.

---

## Documentation Impact

No public API of this app changes, so no reference page moves. The documentation work is the repo's own bookkeeping, already listed in the steps: `CHANGELOG.md`'s backfilled `0.3.0` entry, two deleted `TODO.md` loose ends, the `THIRD-PARTY-NOTICES.md` inventory row, `frontend/vite.config.ts`'s two comments, and `.claude/skills/verify/SKILL.md`'s library-changes section.

`README.md` needs no edit: its dev-setup block already says plain `npm install`, and it names the library without a version.

---

## Potential Challenges

- **The release may not have happened.** Step 6's gate makes that a clean stop rather than a half-applied upgrade; Part A stands alone and can be committed either way.
- **The install silently replaces the local symlink.** That is the intent here, but it means an unreleased library change stops reaching the app — step 10 makes the new state explicit, and step 23 documents how to get the symlink back for local library work.
- **A stale Vite dep cache renders every diagram empty with no console error.** Step 11 clears it; an empty diagram canvas during Part D means step 11 was skipped, not that ELK regressed.
- **The column-width change looks alarming before it looks correct.** Wider columns and new horizontal scrollbars are the expected outcome, so judge each grid against the "correct looks like" column rather than against memory.
- **The scroll measurement can come out ambiguous** — cost split across app and library frames. Step 26's two controls are what break the tie: a cost that scales with column count and only appears when the column window slides belongs to the column-window code, wherever the enclosing frames sit.
- **The lockfile may carry hunks beyond the library entry.** Transitive versions can drift on any regeneration; step 12's drift check is what catches the ones the notices table records.

---

## Critical Files

- [`plans/implemented/elkjs-0-12-upgrade.md`](plans/implemented/elkjs-0-12-upgrade.md) — the precedent this plan follows: range edit, one install, dep-cache clear, notices row, `TODO.md` update, manual surface sweep. Its Non-Goals name this bump as blocked on publication.
- [`plans/implemented/elk-worker-adoption.md:191-192`](plans/implemented/elk-worker-adoption.md#L191) — the heartbeat measurement technique step 25 reuses, including why an interaction-timing number would not have proved anything.
- [`.claude/skills/verify/SKILL.md`](.claude/skills/verify/SKILL.md) — stack startup, the `sqladmin-db` login host, and the chrome-devtools gotchas (right-click, submenus, the 200 ms accordion animation) that Parts D and E depend on.
- [`LIBRARY_NOTES.md`](LIBRARY_NOTES.md) — the status legend and entry shape a Part E write-up must follow.
- [`frontend/src/appIdentity.ts`](frontend/src/appIdentity.ts) — the module the mark joins, and the `__APP_VERSION__` define pattern its doc comments sit beside.
- `../typescript-ui/packages/lib/src/typescript/lib/core/Favicon.ts` — `MARK_SVG` and `DEFAULT_FAVICON`, the shape and palette SQLAdmin's mark mirrors.
- `../typescript-ui/packages/lib/docs/reference/migration.md` — its "Behaviour changes worth a check" section is the consumer-facing summary of what Part D looks for.

---

## Non-Goals

- **The app's own version bump to 0.4.0, its release changelog section, the release commit, and the tag.** Those are a separate release step the user performs by hand. Backfilling the *historical* `0.3.0` entry is bookkeeping for a release that already happened, which is why it is in scope and a `0.4.0` entry is not.
- **Adopting 0.4.0's column-sizing features** — `ColumnSpec.autoSizeColumns`, `ColumnConfig.width`, `ColumnConfig.maxContentLength`, and the batched `Util.measureTextWidths`. The sibling plan `content-derived-column-sizing.md` owns them and will re-touch the same nine grid sites this plan's step 19 walks. **This plan lands first**; once plan 2 sets explicit or content-derived widths, its own verification supersedes the column-width baseline recorded here.
- **Fixing the horizontal-scroll regression**, in this repo or upstream. Part E measures and records it; a fix needs the measurement first.
- **Any change to `esbuild: { keepNames: true }`** or to the `TODO.md` bullet describing it. The library-side fix is deferred, so the app still needs the setting.
- **The `MemoryStore.loadData` zero-render bug and the large-diagram first-render freeze.** Neither is fixed in 0.4.0; both `TODO.md` bullets stay as they are.
- **Removing `resolve.dedupe`, `optimizeDeps.exclude` or `fs.strict: false`** from the Vite config. Each still has a live reason; only the comments around them are wrong.

---

## Notes

[^symlink-end-state]: Today `frontend/node_modules/@jimka/typescript-ui` is a symlink to `/home/jika/typescript/typescript-ui/packages/lib`, while `frontend/package.json` declares `^0.3.0` and `frontend/package-lock.json` resolves `typescript-ui-0.3.0.tgz` from the registry — the manifest and the installed tree disagree. `npm install` reifies the tree the lockfile describes, so the install replaces the symlink on its own; nothing has to remove it. Leaving the registry copy in place is what makes the Part D sweep meaningful: it exercises the artefact that ships, not a local build that may already have moved past 0.4.0. The elkjs precedent restored the symlink after its install because the app needed library code that was not published yet; that reason is gone once 0.4.0 is on the registry.

[^peer-already-fixed]: Verified rather than assumed. `frontend/package-lock.json`'s `node_modules/@jimka/typescript-ui` entry records `"peerDependencies": {"elkjs": "^0.12.0"}` — that field is copied from the published tarball's manifest, so the published 0.3.0 already carries the widened peer. The library changelog files the peer move under `## 0.3.0`, not `## 0.4.0`. A repo-wide grep for `legacy-peer-deps` and `ERESOLVE` finds them in only two files: `TODO.md:89-90` and `plans/implemented/elkjs-0-12-upgrade.md`, which is a historical record and is not edited. `README.md:206`'s dev-setup block already says plain `npm install`; `Dockerfile:10` runs `npm ci`, which replays the lockfile and never resolves peers; `.github/` holds one workflow, `release.yml`, which only builds the Docker image.

[^favicon-decision]: Two placements were weighed. A `<link rel="icon">` in `index.html` would also work and would win over anything the library installs, but it splits the app's identity across `index.html` and `appIdentity.ts`, and it puts a `data:` URI where Vite's HTML plugin rewrites asset URLs. A file in a `public/` directory would mean creating a directory the app does not have and adding a build-time asset for a 500-byte mark. The `appIdentity.ts` constant costs no build wiring, no extra request, and no second source of truth — `appIdentity.ts` already exists precisely so "the app cannot spell itself two different ways". Suppressing with `favicon: false` was rejected: the app would keep its blank tab and keep probing `/favicon.ico` on every load, a 404 the `verify` skill currently tells its reader to ignore.

[^scroll-no-fix]: The app supplies nothing that runs per scroll: a grep for `"scroll"`, `onScroll`, and `scrollLeft` across `frontend/src` finds one hit, `horizontalScrolling: true` at `shell/QueriesView.ts:345`, which is an option rather than a handler. `buildColumnSpec` (`dock/tableWriteRules.ts:39-47`) emits plain booleans, not per-cell callbacks, and only two grids pass a renderer factory (`columnsGrid.ts:106` and `StructurePanel.ts:411`, both `LinkCellRenderer`), neither of them the data grid where the sluggishness was reported. That narrows the app-side candidates but does not settle it — a per-frame cost can come from a component the app builds without any handler of its own — which is why Part E measures instead of concluding. Either way the fix is unknowable before the measurement: an app-side one would depend on which site the frames name, and a library-side one is another repo's work, planned there.

[^vite-config]: Each setting was checked against a registry install rather than assumed. `fs.strict: false` is inert for a registry install, since `node_modules` sits inside the project root — but a developer testing an unreleased library build symlinks the package to `/home/jika/typescript/typescript-ui/packages/lib`, which Vite resolves to its real path outside the root and refuses to serve under the default strict rule; the `verify` skill documents that workflow as a standing part of developing against the sibling library. `resolve.dedupe` is likewise inert under a single registry copy and load-bearing under that symlink. `optimizeDeps.exclude` is what stops Vite's scanner from looking inside the library, which is the stated reason the `elkjs` `include` beside it exists — removing the exclude would invalidate the include's comment and change dep-optimizer behaviour for no gain. `esbuild.keepNames` remains required: the library still derives CSS classes from `this.constructor.name`, and the library-side fix is deferred in typescript-ui's `plans/minification-safe-class-names.md`.

[^library-notes-audit]: Both open entries were checked against 0.4.0 rather than against the changelog's summary. The `Text` constructor `fontSize` papercut turns on two field initializers in `packages/lib/src/typescript/lib/component/input/Text.ts:97-98`, which are unchanged, so the `AppHeader` workaround stays. The `keepNames` papercut is unfixed by design — the library's own plan for it is deferred. Every other entry in the file already carries `✅ Fixed in library`. The `0.4.0` changelog mentions neither the `MemoryStore.loadData` zero-render bug nor the large-diagram layout-cost freeze, which is why both `TODO.md` bullets survive.

[^transition-fix-shipped]: The bullet says the fix is reachable "only through the local dev symlink until typescript-ui publishes a release carrying it". The library changelog's "Disposing a component mid-transition no longer logs a stray…" entry sits at line 964, inside the `## 0.3.0` section (658-983) — so it shipped in the published 0.3.0 that `frontend/package-lock.json` already resolves. The same section carries `elkWorkerFactory` and `ElkLayoutEngine.dispose()`, which is what makes the neighbouring `^0.2.0` bullet spent as well.

[^worktree-install]: Recorded in the elkjs upgrade's implementation notes: a worktree's `frontend/node_modules` symlinked to the main tree's copy means npm writes *through* the symlink and mutates the main tree's install. That run resolved it by doing a real install inside the worktree, at the cost of a slower first install. Step 7 follows it.

[^vite-cache]: `frontend/node_modules/.vite/deps/elkjs_lib_elk__bundled__js.js` is the pre-bundled CommonJS→ESM copy of elkjs. When it is stale or missing, `elk.bundled.js`'s `default` export is `undefined`, `new ELK()` throws inside the library, and the library's layout `catch` swallows it — every diagram renders empty with nothing in the console. Vite hashes the lockfile into its cache key and normally re-optimizes on its own; the explicit clear is cheap insurance on the one artefact whose failure is silent, and this repo has been burned by that symptom before (see the comment block in `frontend/vite.config.ts`).

[^notices-precedent]: The elkjs upgrade established the hand-edit rule for this table: `scripts/generate_third_party_notices.py` also rebuilds the Python inventory and needs the backend virtualenv, so a run for one row produces unrelated diff. The `@jimka/typescript-ui` row has said `0.1.0` since it was written and was already wrong at 0.2.0 and 0.3.0, so step 12 corrects two versions' worth of drift at once. The drift script in that step is the `npm query ':not(.dev)'` check from the same precedent, widened from one package to the whole table.

[^no-removed-api]: 0.4.0 removes or re-shapes `Row.syncCells`, `TableHeader.sortColumns`, `SplitGutter.destroy`, `CollapseButton.destroy`, `VirtualRowView.onPoolRowAdded`, `Body.bindAndPositionRows`, `Row.getComponents` / `getFieldNames` / `getTreeCell`, `TableHeader.getColumns`, and adds two required `DOMSource` members. A grep across `frontend/src` and `frontend/tests` finds none of them: the only `getColumns` hits are the app's own REST helper in `data/api.ts:222` and its callers, and the only `.destroy(` hit is a store proxy call in `data/presetStore.ts:70`. The app subclasses no table internals and implements no `DOMSource`, so the typecheck in step 13 is a formality rather than a risk — but it is the cheap proof, so it stays a checkpoint.

[^heartbeat]: `setInterval` schedules a macrotask, which cannot run while the main thread is blocked, so the largest gap between consecutive ticks is a lower bound on the longest single block during the gesture. The elk-worker-adoption run used exactly this to show that ELK layout had moved off the main thread (2,831 ticks over ~57 s; a 178 ms maximum gap across the 15.7 s interaction). It is used here alongside a trace rather than instead of one: the heartbeat gives the number a user feels, and the trace says which script the time belongs to.

[^hold-window]: The hold is bounded at 50 ms of idle time after startup, so it only covers what is built in that window. `SqlAdminApp.ts` calls `Body.init` first, then awaits `whoami()`; when there is no session, the login dialog waits on a human and the shell is built long after the hold has released. With a live session cookie, `whoami()` resolves immediately and `SqlAdminShell` — with the start page, the navigator and roles trees, and the queries sidebar — is built inside the window. Dock panels are never in it: `data/layoutStore.ts` persists only `Split` gutter positions and `Accordion` section state, not open tabs, so every panel is created by a user action after load.

---

## Implementation Notes

**This branch implements Parts A, B and C only. Parts D and E are outstanding by
design, and the plan stays in `plans/in-progress/` until they are run.**

Parts D and E both need the app driven in a browser against a live Postgres, and
the user is deciding when to run them. Nothing about them is blocked or
abandoned — steps 18-22 and 24-27 apply exactly as written. Verification rows
1-11 all pass on this branch; rows 12 and 13 are the outstanding ones.

Three steps behaved differently from what the plan assumed, all because the work
ran in a fresh worktree rather than the main tree:

- **Step 7 (install prep) was a no-op.** This worktree had no
  `frontend/node_modules` at all, so there was no symlink to remove and no risk
  of an install writing through one into the main tree's copy. Step 9's `npm
  install` created a real install here from scratch — 124 packages, no
  `ERESOLVE`, so the published 0.4.0's elkjs peer range agrees with the app's
  `^0.12.0` as expected. The deliberate consequence is that this worktree's
  `frontend/node_modules` must **not** be symlinked to the main tree's copy, the
  habit elsewhere in this repo, for as long as Parts D and E are pending.
- **Step 11 (clear the Vite dep cache) was a no-op**, confirmed rather than
  assumed: a fresh install has no `frontend/node_modules/.vite` to clear. The
  cache the step guards against can only exist after a dev server has run here,
  so an empty diagram during Part D still means re-reading that step.
- **Step 12's drift check found nothing beyond the library row.** The
  regenerated lockfile's diff is four lines — the manifest range and the
  `@jimka/typescript-ui` resolution — so `THIRD-PARTY-NOTICES.md` needed only
  the one hand-edit the step calls for.

**Step 23 was done early, out of its part.** It rewrites
`.claude/skills/verify/SKILL.md`, which is documentation rather than browser
work and is cleanly separable from the sweep around it; doing it now keeps that
skill honest for whoever runs Part D, since the symlink it described no longer
exists. `.claude/` is untracked and unignored, so the change is **not** in this
branch's commits and cannot be — it is a live edit to the main tree's working
copy of that skill, which `git status` reports only as an untracked `?? .claude/`
directory. (Plan step 23 says it "will not appear in `git status`"; that is the
one thing in the step that is wrong.)

**Part C's rendered result is unverified.** The unit tests pin the encoding
round-trip and the dark-mode rule, which is all a node-environment runner can
see; that the tab actually shows SQLAdmin's drum rather than the library's
bar-and-pane mark is Verification row 12, and it belongs to the Part D sweep.

### A Part D check the plan's tables do not carry

**0.4.0 stops firing `"selection"` for an unchanged selection**, and Part D's
manual-verify tables never mention it. The library's migration guide leads its
"Behaviour changes worth a check" section with it — `Tree`, the table body and
`Table`'s rotated mode now stay silent when the resolved selection matches the
one already held — and the plan cites that very section as what Part D looks
for, so the omission is a gap in the tables rather than a decision. It is
recorded here rather than fixed because it is exactly the kind of check that
needs the browser; **whoever runs Part D should walk it alongside steps 19-22.**

The app has nine live `"selection"` listeners. The one with a concrete path to a
visible regression is the roles tree, because its listener and a second, unrelated
caller write the same inspector:

- `frontend/src/roles/RolesTree.ts:56` calls `showRoleProperties` on selection,
  while `SqlAdminController.ts:2704` (a membership-diagram node activation) and
  `SqlAdminController.ts:2649` (focusing an already-open grants tab) call it
  **without** moving the tree's selection. So: click role X in the tree, then
  activate a different role Y in its membership diagram — the inspector shows Y
  while the tree still holds X — then click X in the tree again. Correct is the
  inspector returning to X. If 0.4.0 suppresses that second click as redundant,
  it stays on Y.
- The remaining sites are lower risk and want a glance rather than a scenario:
  `navigator/NavigatorTree.ts:124`, `dock/StructurePanel.ts:187`,
  `dock/RelationDiagramPanel.ts:125`, `dock/ExplainDiagramPanel.ts:240`, `:248`
  and `:256`, and `shell/localStorageWindow.ts:229`. Re-clicking an
  already-selected row at each should leave the app in the state the row implies.
- `dock/TableWorkPanel.ts:143` needs no check: `syncDeleteEnabled` is registered
  on the store's change event as well as the grid's `"selection"`, which is the
  "different trigger" the migration guide prescribes.

The guide's second behaviour change, `DOMSource.onFontsReady` firing more than
once or not at all, needs no app-side check — nothing under `frontend/src` calls
it, so only the library's own use of it is in play, and step 20 already covers
what that surfaces.
