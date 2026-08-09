---
touches-shared: [frontend/src/dock/TableWorkPanel.ts, README.md]
---

# Table Quick Search — Implementation Plan

## Overview

[`TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) already has a *remote* filter: the toolbar's Filter button opens [`FilterDialog.ts`](frontend/src/dock/FilterDialog.ts), which builds `FilterDescriptor`s and applies them through the store's `filterBy()` — a network round trip that re-queries the backend and reloads the grid. This plan adds a second, independent **quick search**: a plain text field in the same toolbar that narrows the grid to rows already loaded in the browser, live, with no network request. The two coexist — quick search never touches the remote filter's mechanism, and clearing one has no effect on the other (see _Architecture Decisions_).

The work is split across two dependencies this plan states but does not build. First, a small new method on the library's `Table` component, `setRowVisible`, is a **prerequisite**: no row-visibility mechanism exists in `@jimka/typescript-ui` today (confirmed by reading `Table`/`Body`/`ColumnConfig`), and the app-side alternative — swapping the grid to a wrapping `MemoryStore` — has real hazards on a live, editable, paginated store (see the "Row hiding requires a new library primitive" decision below). This plan specifies that method's exact required shape and stops there; building it is `typescript-ui`-repo work, out of scope here. Second, this plan composes with [`plans/table-record-detail-view.md`](plans/table-record-detail-view.md), a sibling plan (not yet implemented) that adds three of its own buttons to this same toolbar for a rotated single-record view. Every toolbar decision below accounts for that plan's layout so the two compose regardless of which lands first.

Once the library method exists, the app-side change is small: a new pure module, `frontend/src/dock/quickSearchModel.ts`, plus a handful of additions to `frontend/src/dock/TableWorkPanel.ts`.

---

## Architecture Decisions

### No existing quick-search precedent in this app — a new, narrowly-scoped pattern

Searched for a comparable client-side text filter elsewhere in the app — the navigator tree, the saved-queries list (`QueriesView.ts`), the start page, and the command palette backlog item in `TODO.md` — and grepped the whole frontend for `toLowerCase().includes(`, `SearchField`, and similar. None exists.[^precedent-search] This plan therefore states its own matching rule from scratch rather than following an in-app convention; the surrounding mechanics (pure DOM-free helper module, arrow-function event handlers, toolbar-embedded non-button inputs) do follow existing precedent, cited in each decision below.

### Quick search and the remote Filter are independent, and neither can be built from the other

They stay two separate controls with two separate states: remote Filter controls what the server sends; quick search controls what the grid shows among rows already received. Both can be active at once — the visible rows are whatever matches the quick search among whatever the remote filter already fetched — and clearing one never clears the other.

Reusing the store's own `filterBy()`/`clearFilter()` for a "local-only" filter was considered and rejected: `AbstractStore.applyFilterChange()` always triggers a page-1 reload whenever `remoteFilter` **or** `pageSize` is set (`reload = this._remoteFilter || this._pageSize != null`), and `frontend/src/data/stores.ts:36`'s `buildStore` passes `pageSize: PAGE_SIZE` (100, defined at line 16) into every `AjaxStore` unconditionally.[^filterby-always-reloads] So every store this panel uses reloads on any `filterBy` call regardless of `remoteFilter`, making the store's filter API structurally unable to express a network-free filter.

The toolbar's existing `filterButton` tint (`FILTER_ACTIVE_COLOR`, driven by `store.on("filterchange", this.syncFilterActive)` at [`TableWorkPanel.ts:149`](frontend/src/dock/TableWorkPanel.ts#L149)) is untouched and keeps reflecting only the remote filter's state. Quick search gets no equivalent color-tint indicator — see "No shared active-state indicator" below.

### Local search narrows only the currently loaded rows; it never force-loads the rest of the table

`AjaxStore` never holds more than one page: `ingestRaw` (`AbstractStore.ts:605-613`) replaces `_allRecords` wholesale on every `load()` rather than appending, and `buildStore` sets `pageSize: 100` with no `PaginationBar` wired into this panel (the sibling plan's own Non-Goals confirm this: adding one is separate, future work). So at any moment the store holds at most 100 rows, however many the table has server-side.

Decision: quick search searches exactly `store.getRecords()` — whatever is currently loaded — and never forces a bulk load to search the whole table.[^why-not-force-load] When the server holds more rows than are loaded (`store.getTotalCount()` exceeds the loaded count), the status label states this plainly rather than silently searching a partial set (see "Public API" and "Internal Structure").

### Matching rule: case-insensitive substring, across every loaded primitive field

For a non-empty query, a record matches if **any** field's value, lower-cased and stringified, contains the lower-cased query as a substring. Only primitive field values (`string`, `number`, `boolean`) participate; `null`/`undefined` are skipped, and so is any field whose value is a JS object — which, after `Field.convertValue`'s ingestion-time coercion (`Field.ts:190-200`), is exactly the `date`/`datetime`/`time` fields (coerced to real `Date` objects, not left as raw ISO strings) and the `json`/`jsonArray` fields (parsed objects/arrays).[^why-skip-objects] A blank or whitespace-only query is treated as empty (matches every row — no filter applied).

Worked example, table `customers(name string, email string, signup_count number, active boolean, created_at isoString, metadata json)`:

| Query | Column (wireType) | Stored value | Participates? | Result |
|---|---|---|---|---|
| `"smith"` | `name` (string) | `"John Smith"` | yes | **matches** (`"john smith"` contains `"smith"`) |
| `"smith"` | `email` (string) | `"js@corp.com"` | yes | no match |
| `"smith"` | `signup_count` (number) | `3` | yes, as `"3"` | no match |
| `"smith"` | `active` (boolean) | `true` | yes, as `"true"` | no match |
| `"smith"` | `created_at` (isoString → `Date`) | `Date` object | **no** (excluded) | — |
| `"smith"` | `metadata` (json) | `{"nickname":"Smith"}` | **no** (excluded) | — |
| `""` (empty) | — | — | — | every loaded row matches |

A record matches the query if it matches on **any** field — the `customers` row above matches `"smith"` because `name` matches, even though every other field does not.

### Row hiding requires a new library primitive — `setRowVisible` on `Table`

No row-visibility mechanism exists in `@jimka/typescript-ui` today. `ColumnConfig`'s `cellReadOnly`/`rowReadOnly` (`ColumnConfig.ts:137,312`) are **write-permission** predicates — they mark cells non-editable, they never remove a row from rendering — confirmed by reading where `_rowReadOnly` is actually consulted (`Body.ts:1372`), which only ever decides whether a cell's editor opens, never whether the row renders. Reading through the rest of `Body.ts`, every other appearance of `visible`/`hidden` turns out to be about **hidden columns**, not rows.

**Swapping the grid to a wrapping store was considered and rejected.** `Table.setStore()` exists (`Table.ts:439`) and `frontend/src/dock/QueryResultView.ts:64` already builds a `MemoryStore` over a loaded row array — but for a different, read-only case (a static query result, `rowReadOnly: () => true`). Reusing that shape for `TableWorkPanel`'s live, editable, paginated grid has two concrete hazards:

1. **Add/Delete/Save would target the wrong store.** `TableWorkPanel`'s `store: AjaxStore` field ([`TableWorkPanel.ts:56`](frontend/src/dock/TableWorkPanel.ts#L56)) is fixed at construction and is what `addButton`/`confirmDelete`/`save_` all call `.add()`/`.remove()`/`.sync()` on directly — never `dataGrid.getStore()`. Swapping `dataGrid`'s bound store to a filtered `MemoryStore` on every keystroke would leave the grid rendering the `MemoryStore` while writes kept landing on the (now-invisible) `AjaxStore`: a row added via the Add button would never appear in the filtered grid, and its pending edit would look lost.
2. **`setStore()` is a heavy, disruptive call.** It re-resolves every column from the new store's model, clears column widths, and ends in a full layout pass (`Table.ts:439-472`) — built for an occasional, deliberate store change, not something to run on every keystroke of a search box.

**The library already has the right internal seam, just not exposed.** `Body.getVisibleRecords()` (`Body.ts:353-364`) is a documented "subclassing seam" — its default implementation returns `this._store.getRecords()`, and `TreeBody` already overrides it to return "its depth-flattened, expansion-aware visible subtree." The concept of "the rows actually rendered can be a filtered view of the store's records" is already load-bearing library architecture; it is only missing a public, consumer-facing hook.

**Stated prerequisite** (not built by this plan — `typescript-ui`-repo work):

```ts
// On Table (packages/lib/src/typescript/lib/component/table/Table.ts)
setRowVisible(predicate: ((record: ModelRecord) => boolean) | null): this;
```

Required contract, so this plan's app-side steps are correct once the method exists:

1. Filters which loaded records the grid renders/scrolls through while `getDisplayMode() === "normal"`; `null` clears it (show every loaded record). Mirrors `Body.setRowReadOnly`'s predicate shape (`Body.ts:583`) but must be **public and live** — unlike `rowReadOnly`, which is spec/construction-only and explicitly marked "not for consumer use," this predicate has to change on every keystroke, so a construction-time-only field cannot serve it.[^why-live-setter]
2. Never touches `store.getRecords()`, `getSelectedRecords()`, or `hasPendingChanges()` — display-only, so a hidden row's pending edit and selection survive untouched (see "Add/Delete/Save are unaffected" below).
3. Has no effect while `getDisplayMode() === "rotated"` — the mode `plans/table-record-detail-view.md` adds, which renders one field/value row per source *column* for a single displayed record, not one row per source *record*. `Table.ts:396-404` already establishes this exact precedent for `rowReadOnly`: the rotated `bindView` call hardcodes `() => true` in place of the spec's predicate, because that predicate is written against source records and the rotated projection's rows are a different model entirely, so the source predicate does not apply to them. `setRowVisible`'s predicate must be neutralized the same way for the same reason.
4. Re-evaluates automatically on the same rebind triggers `rowReadOnly`'s doc comment already lists (scroll, `'datachange'`, column show/hide) — the app calls `setRowVisible` again only when the query text changes, never on a store reload.

### Local filtering and the record/rotated view are orthogonal

`plans/table-record-detail-view.md` adds a rotated single-record view (toggle + Previous/Next) to this same toolbar. Per the `setRowVisible` contract above (point 3), the quick-search predicate has no effect once that view is active — the rotated projection always shows the full field/value breakdown of whichever record is displayed, regardless of the grid's current search text. Previous/Next, per that plan's own `stepRecord`/`syncStepEnabled` (its `Internal Structure`), read `dataGrid.getStore().getRecords()` directly — the full loaded set — so stepping is unaffected by whatever quick search currently hides in grid view.

Decision: **do not coordinate the two.** The quick-search field stays enabled and typable while record view is active; typing has no visible effect until the user switches back to grid view, where the narrowed result is already in effect. Making record view respect the search text would mean either the stepper reading the search predicate too — a new coupling between two independently authored plans, whichever lands second — or moving quick search into the store layer, which the "Row hiding requires a new library primitive" decision above already rejected. Neither is worth it for a feature neither plan currently needs.

Consequently, this plan needs no toggle control. `table-record-detail-view.md` proposes a `glyphToggleButton` helper for its own record-view toggle; quick search is a free-text field, not a binary mode switch, so that helper is not used here.

### Toolbar placement: anchored to `Spacer.flex()`, not to a sibling-plan button

`table-record-detail-view.md` inserts its three new buttons "immediately after `Spacer.flex()` and before `filterButton`" ([`TableWorkPanel.ts:99`](frontend/src/dock/TableWorkPanel.ts#L99)) — it does not consume the spacer itself, so the gap it creates is still available. This plan inserts `quickSearchField` and its status label the same way: **immediately after `Spacer.flex()`**, ahead of whatever already follows it.

Anchoring to the spacer (a component that exists today, in the unmodified file) rather than to `recordToggle` (a component that only exists once the sibling plan lands) makes the two plans' insertions order-independent: whichever plan is implemented second still finds `Spacer.flex()` and inserts next to it, landing the newer control closest to the spacer and pushing the earlier one one slot right. Either implementation order produces the same final left-to-right order: `Spacer.flex()`, quick search, [record-view toggle, Previous, Next — once that plan lands], Filter, Export, Refresh.[^toolbar-order-footnote]

### No shared active-state indicator — the field's own text is the indicator

`filterButton` is an icon-only glyph button with no room to show its own state except by tinting its color (`FILTER_ACTIVE_COLOR`); a text field does not have that problem; the typed text is already visible. Decision: quick search gets no color-tint or icon-badge indicator of its own. Its live status label (see "Public API") shows the match count whenever the field is non-empty, which doubles as the "search is active" signal.

### Add/Delete/Save are unaffected

Per the `setRowVisible` contract's point 2, hiding a row from the grid never changes `store.getRecords()`/`getSelectedRecords()`/`hasPendingChanges()`. So: a row selected before the search text hides it stays selected, and its pending edit is untouched; `confirmDelete`, `save_`, `syncDeleteEnabled`, and `syncSaveEnabled` ([`TableWorkPanel.ts:157-168`](frontend/src/dock/TableWorkPanel.ts#L157)) need no changes and are not touched by this plan.

### No debounce

`matchesQuickSearch` is O(field count) per record, and the store holds at most `PAGE_SIZE` (100) records (`frontend/src/data/stores.ts:16`) — filtering the whole loaded page on every keystroke is well under a millisecond. No debounce or throttle is added.[^no-debounce-footnote]

---

## Public API

The library-side prerequisite (`Table.setRowVisible`) is specified above, under "Row hiding requires a new library primitive" — it is **not** implemented by this plan. Everything below is this app's own new code.

```ts
// frontend/src/dock/quickSearchModel.ts — new module

/** The subset of a ModelRecord's API this module reads. */
interface RecordLike {
    getData(): Record<string, unknown>;
}

/**
 * Whether `record` matches a quick-search query: case-insensitive substring,
 * across every primitive (string/number/boolean) field. An empty or
 * whitespace-only query matches every record.
 */
export function matchesQuickSearch(record: RecordLike, query: string): boolean;

/**
 * Format the quick-search status line: how many of the currently loaded rows
 * matched, and — when the server holds more rows than are loaded — a note
 * that those weren't searched.
 */
export function quickSearchStatus(matchedCount: number, loadedCount: number, totalCount: number | undefined): string;
```

`quickSearchStatus`'s worked cases:

| `matchedCount` | `loadedCount` | `totalCount` | Result |
|---|---|---|---|
| 3 | 100 | 100 | `"3 of 100 loaded rows"` |
| 0 | 100 | 4500 | `"0 of 100 loaded rows (4400 more on the server not searched)"` |
| 1 | 1 | 1 | `"1 of 1 loaded row"` |
| 0 | 0 | undefined | `"0 of 0 loaded rows"` |

`loadedCount === 1` uses `"row"`; otherwise `"rows"`. The "more on the server" clause appears only when `totalCount !== undefined && totalCount > loadedCount`, and its count is always `totalCount - loadedCount`.

---

## Internal Structure

`TableWorkPanel`'s new members. Both handlers are arrow-function fields — `applyQuickSearch` is registered by reference on `quickSearchField`'s `"change"` event and `syncQuickSearchStatus` on the store's `"datachange"`/`"load"` events, so both must keep `this` per convention (c) in [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md).

```ts
// New fields, alongside filterButton:
private readonly quickSearchField:      TextField;
private readonly quickSearchStatusText: Text;
```

```ts
// New pre-super() locals, built alongside filterButton:
const quickSearchField      = new TextField({ placeholder: "Quick search (loaded rows)" });
const quickSearchStatusText = new Text("");
```

```ts
// New arrow-function fields, alongside syncDeleteEnabled:

// Registered on quickSearchField ("change") — fires on every keystroke
// (TextInput's native `input` listener). Installs a fresh predicate on every
// call; passing null when the query is empty clears the filter entirely.
private applyQuickSearch = (): void => {
    const query = this.quickSearchField.getValue().trim();

    this.dataGrid.setRowVisible(query === "" ? null : (record) => matchesQuickSearch(record, query));
    this.syncQuickSearchStatus();
};

// Registered on `store` ("datachange", "load") as well as called directly
// from applyQuickSearch. Recomputes the status label from the CURRENT query
// against whatever is currently loaded — it does not touch setRowVisible,
// since the predicate installed by applyQuickSearch keeps re-evaluating
// itself against fresh loaded records on its own (see the setRowVisible
// contract's point 4).
private syncQuickSearchStatus = (): void => {
    const query = this.quickSearchField.getValue().trim();

    if (query === "") {
        this.quickSearchStatusText.setText("");

        return;
    }

    const loaded  = this.store.getRecords();
    const matched = loaded.filter(r => matchesQuickSearch(r, query)).length;

    this.quickSearchStatusText.setText(quickSearchStatus(matched, loaded.length, this.store.getTotalCount()));
};
```

Post-`super()` wiring, alongside the existing filter-wiring block:

```ts
this.quickSearchField.on("change", this.applyQuickSearch);
this.syncQuickSearchStatus();
store.on("datachange", this.syncQuickSearchStatus);
store.on("load", this.syncQuickSearchStatus);
```

`store.on("load", …)` is needed in addition to `"datachange"` because `load()` (`AbstractStore.ts:314-363`) — the path Refresh takes — only emits `'load'`, not `'datachange'`.

---

## Ordered Implementation Steps

1. **Gate check.** Run `grep -rl "setRowVisible" frontend/node_modules/@jimka/typescript-ui/dist/lib/*.js`. If it finds nothing, **stop** — this plan is blocked on the library-side prerequisite in `## Architecture Decisions`; do not build an app-side workaround (e.g. do not fall back to the rejected `MemoryStore`-swap approach). Resume once the symlinked/installed library exposes the method.

2. **Create `frontend/tests/dock/quickSearchModel.test.ts`**, test-first, mirroring [`frontend/tests/dock/tableWriteRules.test.ts`](frontend/tests/dock/tableWriteRules.test.ts)'s duck-typed-record-fixture style. Cover every row of the `matchesQuickSearch` worked example table and the `quickSearchStatus` worked-cases table above, plus: whitespace-only query treated as empty, `"SMITH"` matching `"john smith"` (case-insensitivity), and a `null`/`undefined`-valued field never matching a non-empty query. Run `cd frontend && npm test` — fails to import a module that does not exist yet.

3. **Create `frontend/src/dock/quickSearchModel.ts`** implementing `matchesQuickSearch` and `quickSearchStatus` per `## Public API`. Give the module a header comment stating why it is split out (pure logic, DOM-free, node-vitest — same reason as `tableWriteRules.ts`, since `TableWorkPanel.ts`'s top-level imports touch `document`). Run `npm test` — green.

4. **`frontend/src/dock/TableWorkPanel.ts` — imports.** Add `TextField, Text` to the existing `@jimka/typescript-ui/component/input` import (add the import if it doesn't already exist in this file). Add `matchesQuickSearch, quickSearchStatus` from `./quickSearchModel`. No new glyphs are needed.

5. **`TableWorkPanel.ts` — fields.** Add `quickSearchField: TextField` and `quickSearchStatusText: Text` to the field block at [lines 63-65](frontend/src/dock/TableWorkPanel.ts#L63), alongside `filterButton`. Extend the block's leading comment to name the two new fields (if `table-record-detail-view.md` has already landed and rewritten this comment for its own fields, extend that version additively rather than reverting it).

6. **`TableWorkPanel.ts` — pre-`super()` locals.** Build `quickSearchField` and `quickSearchStatusText` per `## Internal Structure`, right after the `filterButton` local at [line 85](frontend/src/dock/TableWorkPanel.ts#L85).

7. **`TableWorkPanel.ts` — toolbar order.** Insert `quickSearchField, quickSearchStatusText` into the `components` array at [line 99](frontend/src/dock/TableWorkPanel.ts#L99), immediately after `Spacer.flex()` — ahead of whatever component array entry currently follows it (`filterButton` today; `recordToggle` if `table-record-detail-view.md` has already landed). See "Toolbar placement" above for why anchoring to the spacer, not to a named sibling button, keeps this order-independent.

8. **`TableWorkPanel.ts` — post-`super()` wiring.** Assign the two new fields alongside the existing ones. Add the wiring block from `## Internal Structure` (the `"change"` listener, the initial `syncQuickSearchStatus()` call, and the two `store.on(...)` registrations) next to the existing filter-wiring block at [lines 124-128](frontend/src/dock/TableWorkPanel.ts#L124).

9. **`TableWorkPanel.ts` — handlers.** Add `applyQuickSearch` and `syncQuickSearchStatus` as arrow-function fields after `syncDeleteEnabled` ([line 163](frontend/src/dock/TableWorkPanel.ts#L163)), per `## Internal Structure`.

10. **`TableWorkPanel.ts` — header comment.** Extend the file's opening block to mention the quick-search field and its two handlers, the same way it already lists `syncFilterActive`/`syncSaveEnabled`/`syncDeleteEnabled`.

11. **Checkpoint.** `cd frontend && npm run typecheck && npm test`. A typecheck failure on `dataGrid.setRowVisible` at this point means the symlinked library build does not actually have the method yet, despite step 1's grep — re-check step 1 rather than working around the type error.

12. **`README.md`.** Extend the "Data grid" highlight ([line 28](README.md#L28)) to mention the local quick search alongside filter/sort/page. If `table-record-detail-view.md` has already landed and extended this same line for its own feature, append to that wording rather than overwrite it.

13. **Manual verification** — per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/quickSearchModel.ts` |
| Create | `frontend/tests/dock/quickSearchModel.test.ts` |
| Modify | `frontend/src/dock/TableWorkPanel.ts` |
| Modify | `README.md` |

---

## Expected Behaviour

### Unit-testable — `quickSearchModel.ts` (`frontend/tests/dock/quickSearchModel.test.ts`)

- Every row of the `matchesQuickSearch` worked example table under "Matching rule" above.
- Every row of the `quickSearchStatus` worked-cases table under `## Public API` above.
- `matchesQuickSearch`: case-insensitivity (`"SMITH"` matches a record with `name: "John Smith"`); a whitespace-only query (`"   "`) matches every record, same as `""`; a record whose only matching field is `null`/`undefined` does not match a non-empty query; a record with no fields at all (`getData()` returns `{}`) matches only the empty query.
- `quickSearchStatus`: `loadedCount === 1` renders `"row"` (singular); every other count renders `"rows"`; the "more on the server" clause is present exactly when `totalCount !== undefined && totalCount > loadedCount`, and absent when `totalCount === loadedCount` or `totalCount === undefined`.

### Manual — the Data tab of an open table

Use a table with more server-side rows than `PAGE_SIZE` (100) for the "more on the server" cases, and a small table for the rest.

1. **Live narrowing, no network.** Typing in the quick-search field narrows the grid immediately; the browser devtools network panel shows no new request while typing.
2. **Clearing restores everything.** Emptying the field re-shows every currently loaded row.
3. **Zero matches.** A query matching nothing empties the grid and the status label reads `"0 of {loaded} loaded rows"`, plus the "more on the server" clause on a table with more rows than loaded.
4. **Composes with remote Filter.** With a remote filter applied (via the Filter button) and a quick-search query also active, the grid shows rows matching both. Clearing the quick-search field restores every remotely-filtered row; separately clearing the remote filter (via FilterDialog's Clear) leaves the quick-search query and its narrowing untouched.
5. **Selection and pending edits survive hiding.** Select a row, edit a cell (Save enables), then type a query that hides that row: Save stays enabled and the edit is not lost. Clear the query: the row reappears still selected, still with its pending edit.
6. **Delete still targets a hidden-then-cleared row correctly.** Same setup as case 5, but Delete instead of edit: confirming still queues the correct record.
7. **Refresh re-applies the same query.** With a query active, press Refresh: the grid reloads and immediately re-narrows to the same query text against the fresh loaded set; the status label updates to the new counts.
8. **No "more on the server" clause when everything is loaded.** On a table with fewer rows than `PAGE_SIZE`, the status label never shows the parenthetical, regardless of query.
9. **Record view is unaffected (once `table-record-detail-view.md` lands).** With a quick-search query narrowing the grid, toggle into record view: the full record is shown, and Previous/Next step through every loaded record, not just the ones the query currently matches. Toggling back to grid view re-shows the narrowed set.

---

## Verification

- `cd frontend && npm run typecheck` — clean (requires the library prerequisite to be present; see step 1).
- `cd frontend && npm test` — the new `quickSearchModel` suite passes with the rest.
- `grep -rn "setRowVisible" frontend/src/` — exactly one call site, inside `applyQuickSearch`.
- `grep -rn "quickSearchField\|quickSearchStatusText" frontend/src/dock/TableWorkPanel.ts` — both appear in the field block, the pre-`super()` locals, the toolbar's `components` array, and the post-`super()` wiring.
- Manual: the 9 cases above, driven through the running app (see the `verify` skill). Entry point: navigator → a small table's Data tab for cases 1-8 excluding the "more on the server" half of case 3 and case 8's own table; a table with more than 100 rows for the "more on the server" cases.

---

## Documentation Impact

- **`README.md`** — the "Data grid" highlight lists filter/sort/page; add local quick search to it (see step 12's note on composing with `table-record-detail-view.md`'s own edit to the same line).
- **`TODO.md`** — no existing backlog bullet describes this feature (grepped for "search"/"filter"; the only hits are the already-shipped Filter button and an unrelated command-palette bullet), so nothing to rewrite.
- **`LIBRARY_NOTES.md`** — no entry. That file logs bugs and papercuts hit while *using* the library, not library capabilities the app would like to see — the same reasoning `align-with-library-post-0.4.1.md`'s Documentation Impact gives for its own two changes.
- **`CHANGELOG.md`** — no entry; written at release time, not in feature work (established by `plans/implemented/content-derived-column-sizing.md` and `plans/implemented/elkjs-0-12-upgrade.md`).

---

## Potential Challenges

- **The gate in step 1 can pass today and fail tomorrow, or vice versa.** The library prerequisite does not exist in the currently symlinked build (confirmed by grep during this plan's investigation); `/implement` must actually run the step 1 check against the build present at implementation time, not assume either outcome.
- **A wrong library implementation would silently break case 9.** If `setRowVisible`'s eventual implementation does *not* neutralize the predicate in rotated mode (contrary to the stated contract's point 3), record view's Previous/Next would start skipping rows the grid's quick search currently hides — case 9 in `## Expected Behaviour` is exactly the check that would catch this; if it fails, the fix belongs in the library, not a `TableWorkPanel.ts` workaround.
- **ToolBar's default overflow is `"clip"`.** On a narrow window, a growing toolbar (this plan's field plus `table-record-detail-view.md`'s three buttons) can clip. No fix is scoped here — this matches every other toolbar in the app today, none of which handles narrow-viewport overflow specially.

---

## Critical Files

| File | Why |
|---|---|
| [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) | The panel being changed; its arrow-field handler style and pre-`super()` local pattern must be followed exactly. |
| [`frontend/src/dock/FilterDialog.ts`](frontend/src/dock/FilterDialog.ts) / [`frontend/src/dock/filterModel.ts`](frontend/src/dock/filterModel.ts) | The remote-filter mechanism this plan stays independent of — read to confirm quick search touches none of its code paths. |
| [`frontend/src/dock/QueryResultView.ts:64`](frontend/src/dock/QueryResultView.ts#L64) | The `MemoryStore`-over-loaded-rows precedent this plan explicitly does **not** reuse; read it to see why (static read-only data, not a live editable paginated store). |
| [`frontend/src/dock/tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts) / [`frontend/tests/dock/tableWriteRules.test.ts`](frontend/tests/dock/tableWriteRules.test.ts) | The DOM-free pure-module-plus-test convention `quickSearchModel.ts` follows, including the duck-typed `RecordLike` interface pattern. |
| [`frontend/src/data/stores.ts`](frontend/src/data/stores.ts) | `PAGE_SIZE`, `remoteSort`, `remoteFilter` — the configuration every "loaded vs. total" decision in this plan rests on. |
| [`plans/table-record-detail-view.md`](plans/table-record-detail-view.md) | The sibling plan whose toolbar additions and rotated-mode mechanics this plan must compose with — read in full before touching the toolbar. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/AbstractStore.ts` (`getRecords`/`getAll` ~622-633, `applyFilterChange` ~1526-1542, `applyView` ~1821-1855, `getTotalCount` ~483-491) | The loaded-vs-total and reload-on-filter mechanics this plan's decisions rest on. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/Body.ts` (`getVisibleRecords` ~353-364, `setRowReadOnly` ~571-587) | The existing subclassing seam and the naming/doc convention the new library API should extend. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts` (`setDisplayMode` ~388-409, `setStore` ~439-472) | The rotated-mode neutralization precedent `setRowVisible` must follow, and the `setStore` hazards that ruled out the store-swap alternative. |
| `../typescript-ui/packages/lib/src/typescript/lib/component/table/ColumnConfig.ts` (~280-312) | `rowReadOnly`'s doc-comment convention, mirrored (with the live-setter difference noted) by the stated `setRowVisible` prerequisite. |
| `../typescript-ui/packages/lib/src/typescript/lib/data/Field.ts` (~160-209) | `convertValue`/`convertByType` — confirms `date`/`datetime`/`time` fields are `Date` objects by the time `ModelRecord.getData()` returns them, which is why the matching rule excludes them. |

---

## Non-Goals

- **Implementing `Table.setRowVisible` in `@jimka/typescript-ui`.** Library-repo work; this plan states its required shape as a prerequisite and stops there.
- **Force-loading the whole table to search rows beyond the current page.** Rejected under "Local search narrows only the currently loaded rows" — defeats server pagination, and no bulk-load API is wired into this panel's store.
- **A leading search-glyph or a clear ("×") button on the field.** The library's `TextField` has no built-in affix slot; a plain field with a placeholder is enough.
- **Coordinating quick search with the record/rotated view's Previous/Next reach.** Explicitly orthogonal — see "Local filtering and the record/rotated view are orthogonal."
- **Matching against `Date`/JSON-typed column values.** Excluded by the matching rule; searching those columns' *formatted* display text (rather than a raw stringification) would need each column's own cell formatter — the same reason `table-record-detail-view.md` rejects `PropertyValuePanel`'s naive stringification for its own feature.
- **Debouncing input.** Rejected — see "No debounce."
- **Highlighting the matched substring inside grid cells.** A visual enhancement, not requested; the status label's match count is the only feedback this plan adds.

---

## Notes

[^precedent-search]: Searched `frontend/src` for `toLowerCase().includes(`, `toLowerCase().startsWith(`, `SearchField`, `SearchInput`, `quickfilter`, and `quick-filter` (all case-insensitive) — no matches. Also read `frontend/src/navigator/NavigatorTree.ts`, `frontend/src/shell/QueriesView.ts`, and `frontend/src/shell/StartPage.ts` directly for any inline filter box — none of the three has one. The command-palette backlog item in `TODO.md` ("Command palette / keyboard-driven actions") is unbuilt, so it establishes no convention either.

[^filterby-always-reloads]: `AbstractStore.applyFilterChange()` (`AbstractStore.ts:1526-1542`): `const reload = this._remoteFilter || this._pageSize != null;` and, when `reload` is true, `this._page = 1` plus `void this.load()` after the local view rebuild. `frontend/src/data/stores.ts:36`'s `buildStore` always passes `pageSize: PAGE_SIZE` (100, defined at line 16) into every `AjaxStore` this panel uses, so `reload` is `true` unconditionally regardless of `remoteFilter`'s value — there is no way to call `filterBy`/`filter`/`clearFilter` on this store without triggering a page-1 reload.

[^why-not-force-load]: A bulk "load every row, then search" mode was considered. It would need either a new store method (none exists — `AbstractStore` has no "load all pages" operation) or a client-side loop calling `nextPage()` until exhausted, which reintroduces exactly the async, multi-request complexity that `table-record-detail-view.md`'s own footnote on its Previous/Next design already rejected for a different feature (record-view stepping) on this same store. It would also make "quick search" silently expensive on a million-row table — the opposite of "instant feedback."

[^why-skip-objects]: Confirmed via `AbstractModel.createRecord` (`AbstractModel.ts:215`), which runs every field through `field.convertValue(value, source)` before constructing the `ModelRecord` — so `ModelRecord.getData()` (`ModelRecord.ts:489-491`) returns already-coerced values, not raw wire JSON. `Field.ts`'s `convertByType` (`Field.ts:190-200`) coerces `date`/`datetime`/`time` to a real `Date` instance. Stringifying a `Date` (`String(new Date(...))`) produces a verbose, locale-dependent representation the user never typed and would not think to search for, and stringifying a parsed JSON object produces `"[object Object]"` — both are worse than not matching at all, so both are excluded by the same `typeof value === "object"` check rather than given a bespoke (and inevitably wrong) stringification.

[^toolbar-order-footnote]: Verified against `table-record-detail-view.md`'s own step 7, which inserts its three buttons "immediately after `Spacer.flex()` and before `filterButton`" — the same anchor this plan uses, not a position relative to any button this plan introduces. Because both plans describe their insertion relative to the spacer rather than to each other's controls, applying either plan's diff first still leaves a valid, unambiguous insertion point for the other.

[^why-live-setter]: `rowReadOnly` is declared once in the `ColumnSpec` passed to `Table`'s constructor and forwarded into `Body` via `bindView`/`setRowReadOnly` at construction and display-mode switches only (`Table.ts:255,404,1142`) — there is no public path to change it after the fact, and `Body.setRowReadOnly`'s own doc comment says so explicitly ("Internal wiring called by Table — not for consumer use"). That is fine for a value fixed at table-build time (a table's read-only rule does not change while it's open), but quick search's predicate changes on every keystroke, so the new method must be an ordinary public instance method the app calls repeatedly, not a construction-time option.

[^no-debounce-footnote]: Revisit only if a future change makes this panel load more than `PAGE_SIZE` rows into memory at once (e.g. an eventual "load all" mode) — not the case today, and not proposed by this plan (see `## Non-Goals`).
