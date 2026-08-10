# Data Tab Loading Spinner and Query Error Banner — Implementation Plan

## Overview

`QueryPanel`'s `run()` ([frontend/src/dock/QueryPanel.ts:629](frontend/src/dock/QueryPanel.ts#L629)) awaits `runQuery(sql)` and only then calls `showResult` ([QueryPanel.ts:725](frontend/src/dock/QueryPanel.ts#L725)), which synchronously builds a `QueryResultGrid` and drops it into the "Data" tab of `resultHost`, a `TabPanel` ([QueryPanel.ts:218](frontend/src/dock/QueryPanel.ts#L218)). Nothing in the result pane changes while the fetch is in flight — only the status bar's "Running…" line and the disabled Run button show anything happened. Separately, a failed run reaches `onError` ([QueryPanel.ts:665](frontend/src/dock/QueryPanel.ts#L665)), which shows a 3-second toast plus a status-bar line and then leaves no trace once the toast dismisses.

This plan makes the Data tab load the same way every other async panel in this app does — a tab that appears immediately behind a spinner, per `plans/implemented/lazy-tab-loading-sequence.md` — and adds a durable, in-panel error banner so a failed run's detail does not disappear after three seconds. Both changes are confined to `frontend/src/dock/QueryPanel.ts`; no other file changes. `frontend/src/dock/QueryResultView.ts` and `frontend/src/data/api.ts` need no edits — `QueryResultGrid`'s constructor is already synchronous and cheap, and `runQuery` already returns the one promise both new mechanisms share.

The header comment at the top of the file ([QueryPanel.ts:1-41](frontend/src/dock/QueryPanel.ts#L1)) already documents the Data/Chart/Explain tab family; this plan changes how the Data tab specifically gets built, not its lifecycle rules (still one Data tab, still dropped for a non-row statement, still left alone by an Explain run).

---

## Architecture Decisions

### The Data tab is registered through `TabPanel.addTab`'s lazy-factory path, not built and handed in

`resultHost.addTab(factory, "Data", { glyph: "table" })` replaces the current `resultHost.addTab(nextData.content, "Data", { glyph: "table" })` ([QueryPanel.ts:769](frontend/src/dock/QueryPanel.ts#L769)). The factory is an `async` function that awaits the query, decides whether the result is a rows result, and only then constructs the `QueryResultGrid`. `TabPanel`/`Tab` shows the library's own `createSpinnerWrap()` placeholder for the whole wait and swaps in the built grid on success — the same mechanism `Dock.addLazyPanel` uses for `openTable`/`openAsyncPanel` ([SqlAdminController.ts:2950](frontend/src/SqlAdminController.ts#L2950)), just reached through `TabPanel` directly instead of through `Dock`, because the Data tab lives inside `resultHost`, not at the top-level Dock.[^tabpanel-not-dock]

### `run()` and the Data-tab factory share one `runQuery` promise; `run()` kicks the tab off before it awaits

`run()` calls `const resultPromise = runQuery(sql);` once, then synchronously registers the lazy Data tab against that same promise (`refreshDataTab(resultPromise, seq)`, a new function), *then* awaits `resultPromise` itself for its own bookkeeping (status message, `onRun` history, `onError`). One network round trip feeds both consumers. `run()`'s existing `runSeq`/`seq` staleness guard is threaded into the factory too, so a run superseded by a newer one discards itself instead of clobbering the newer run's tab.[^shared-promise]

### The factory decides rows-vs-not itself, and only removes the old Data tab once it knows the new one is good

The factory is the only place that knows whether this attempt produced rows, so it — not `run()` — now owns `removeDataTab()` for the Data tab specifically. It removes the *old* Data tab (if any) only after confirming the new fetch resolved to a rows result. A genuine fetch error propagates out of the factory unhandled, which tears down only the *new*, still-spinning tab (via the library's standard lazy-tab failure teardown) and leaves an existing good Data tab completely untouched. A non-rows result (a status/DDL statement) explicitly removes the old Data tab itself, matching the file's existing rule that a command-tag result drops the Data tab — that rule is unchanged, just relocated.[^error-vs-nonrows]

The factory's outcome and its effect on the *old* Data tab and *new* (just-added) tab:

| Outcome | Old Data tab (if one existed) | New tab | `dataSlot` |
| --- | --- | --- | --- |
| Stale (`seq !== runSeq`) | untouched | torn down (throw) | untouched |
| Fetch rejects (genuine error) | untouched | torn down (throw propagates) | untouched |
| Resolves, `result.kind !== "rows"` | removed | torn down (throw) | `null` |
| Resolves, `result.kind === "rows"` | removed | becomes the grid | set to the new grid/result |

### A re-run's fetch error never discards an already-loaded Data tab; a first run's error has nothing to protect

This falls out of the previous two decisions rather than needing separate handling: a first run has no old Data tab, so a failed first run just tears down the optimistic spinner tab it added (the pane hides again if that was the only tab — a brief, accepted flash, since the tab is committed before the result kind is known; see `## Potential Challenges`). A re-run's failure never reaches `removeDataTab()` at all (the factory's `await resultPromise` throws before that line), so the prior good grid stays exactly where it was, just no longer the active tab if something else (Chart/Explain, or nothing) ends up selected by the library's default post-close reselection.[^reselect-not-attempted]

### Selecting the freshly-added lazy tab uses the panel's own tab count, not a library index trick

`TabPanel`/`Tab` has no way to `setActiveContent` a tab whose factory has not run yet (`Tab.indexOfContent` matches by built component, which a lazy entry does not have until it resolves). `Tab.setActiveTabIndex(index)` does work on an unbuilt entry — it drives selection through the strip and kicks `materializeAsync` for a `"lazy"` entry. The index of the tab this call is about to add is exactly the count of currently-live tabs (`[dataSlot, chartSlot, explainSlot, diagramSlot].filter(s => s !== null).length`), computed *before* calling `addTab`, since `addDeferredComponent` appends synchronously to the Tab's internal list.[^index-choice]

### No `refreshingTabs` guard around the Data tab add

`refreshingTabs` exists ([QueryPanel.ts:210-216](frontend/src/dock/QueryPanel.ts#L210)) because an *eager* component handed to `addTab` is not registered into the `Tab` manager's content list until the next scheduled layout (`syncUntabbedChildren`, run from `doLayout`), so a synchronous remove-then-add pair can transiently drain the strip to zero. A *lazy factory* is different: `Tab.addDeferredComponent` pushes its entry into that list synchronously, the instant `addTab` returns. Removing the old Data tab from inside the async factory — long after the add — never coincides with a zero-tab window, because the new (still-building) entry has already occupied a slot since the moment it was added. The guard stays exactly as it is today for Chart/Explain/Diagram, which are unaffected by this plan.

### A durable error banner sits at the bottom of the whole query panel, independent of the result pane

A `Component` row (leading warning glyph, wrapping message text, a dismiss button) is added to/removed from `Placement.SOUTH` of `panel` (the `QueryPanelContent`, `QueryPanel.ts:268`) — below the editor when no result pane is shown, below the result pane when one is. This keeps the banner fully decoupled from `resultHost`'s own shown/hidden state (driven entirely by tab count), so it works identically whether a first run fails with nothing else on screen, or a re-run fails while a good Data tab is still showing above it.[^banner-placement] The existing toast (`onError`, unchanged) and status-bar line stay exactly as they are — the banner is additive, per the app's established convention of layering feedback rather than replacing it (`plans/implemented/notification-history-statusbar.md`).

An error-content *Data tab* state (the task's other named option) was considered and rejected: it would require the factory to *resolve* with an error view instead of throwing on failure, which means the library's failure teardown never runs, which means a re-run's failed attempt would sit in the strip as a second tab also labeled "Data" alongside the still-good original — worse, not better, than what exists today.[^rejected-error-tab]

### `clear()` invalidates any in-flight run

`clear()` did not touch `runSeq` before this plan, so a run in flight when the user hits Clear (the Clear button stays enabled while Run is busy — `setBusy` never touches it) would still land its result after the clear completed, undoing it. This was already true for the status/history bookkeeping; this plan's optimistic tab-add makes the same gap produce a visible artifact (a spinner tab reappearing after the panel was cleared) if left alone. `clear()` now starts with `++runSeq`, which the factory's existing staleness check already discards correctly, and ends with `setBusy(false)` (replacing its previous direct `syncChartButton()` call) so the toolbar buttons a suppressed run's own `finally` would otherwise have re-enabled are not left disabled.[^clear-runseq]

---

## Internal Structure

### New helper: live tab count

Placed beside the other small pane helpers (near `removeDiagramTab`, [QueryPanel.ts:338](frontend/src/dock/QueryPanel.ts#L338)):

```typescript
/**
 * How many tabs are currently live in the result pane, across all four slots.
 * Doubles as the index a tab added right now would land at — Tab.addTab always
 * appends, so this count, read before the add, is that tab's index.
 */
function liveTabCount(): number {
    return [dataSlot, chartSlot, explainSlot, diagramSlot].filter(slot => slot !== null).length;
}
```

### New helper: `resultStatusMessage`

Placed beside `resultRowCount` ([QueryPanel.ts:816](frontend/src/dock/QueryPanel.ts#L816)), which it joins as the second small pure helper `run()` calls on its resolved result:

```typescript
/**
 * The status-bar line for a completed run: row count (or a truncation note)
 * for a rows result, else the command tag (or "OK" when the backend gives none).
 */
function resultStatusMessage(result: QueryResult): string {
    if (result.kind === "rows") {
        return result.truncated
            ? `showing first ${result.rowCount} rows — result truncated`
            : `${result.rowCount} row(s)`;
    }

    return result.kind === "status" ? result.command || "OK" : "OK";
}
```

### Replacing `showResult` / `showRowsResult` with `refreshDataTab`

Both `showResult` ([QueryPanel.ts:725-745](frontend/src/dock/QueryPanel.ts#L725)) and `showRowsResult` ([QueryPanel.ts:757-779](frontend/src/dock/QueryPanel.ts#L757)) are deleted. Neither is called from anywhere but `run()`. In their place, one new function:

```typescript
/**
 * Registers `run()`'s in-flight fetch as the Data tab's content source: adds a
 * new lazy tab bound to `resultPromise` and selects it immediately, so the tab
 * and its spinner appear before the fetch resolves — both the query and the
 * grid construction happen behind that spinner. The factory awaits the SAME
 * promise `run()` itself is awaiting, so this is one network round trip, not two.
 *
 * The prior Data tab (if any) is left completely alone until the factory
 * confirms a rows result: only then is it safe to discard, so neither a fetch
 * error nor a non-rows result on a re-run ever destroys a Data tab that already
 * held good rows. A run superseded by a newer one before its fetch resolves
 * discards itself the same way, via the runSeq check.
 *
 * @param resultPromise - The in-flight `runQuery(sql)` call this run started.
 * @param seq - This run's `runSeq` snapshot, re-checked once the fetch resolves.
 */
function refreshDataTab(resultPromise: Promise<QueryResult>, seq: number): void {
    ensureResultPaneShown();

    const insertIndex = liveTabCount();

    resultHost.addTab(async () => {
        const result = await resultPromise;

        if (seq !== runSeq) {
            // Superseded by a newer run before this one resolved. Touch
            // nothing — a newer run may already have installed its own
            // dataSlot, and this attempt's own tab is about to be torn down
            // by the library's normal lazy-tab failure path.
            throw new Error("superseded by a newer run");
        }

        if (result.kind !== "rows") {
            // Matches the file's existing rule (see the header comment): a
            // command-tag/DDL result drops the Data tab, leaving any Chart/
            // Explain tab. This attempt's own (still-spinning) tab is torn
            // down too, by the throw below.
            removeDataTab();
            syncExportToActiveTab();
            syncChartButton();
            throw new Error("statement returned no rows");
        }

        const grid = new QueryResultGrid(result);

        removeDataTab(); // safe now — this run produced rows and won
        dataSlot = { content: grid.content, result };
        setActiveExport({ kind: "rows", result });
        syncChartButton();

        return grid.content;
    }, "Data", { glyph: "table" });

    tab.setActiveTabIndex(insertIndex);

    // Selecting a tab moves DOM focus to its strip button (the roving tab
    // index); reclaim it for the editor once the freshly-added tab's cell
    // exists (next layout), so the "run, tweak, re-run" loop keeps working
    // without waiting for the fetch. Runs on every call, including one later
    // found stale — the keystroke that triggered it is real either way.
    Component.afterNextLayout(() => editor.focus());
}
```

### `run()`

Replaces [QueryPanel.ts:629-673](frontend/src/dock/QueryPanel.ts#L629):

```typescript
async function run(): Promise<void> {
    const sql = editor.getValue().trim();

    if (!sql) {
        notify("Enter a SQL statement");

        return;
    }

    const seq = ++runSeq;

    historyCursor = null;
    setBusy(true);
    notify("Running…");
    hideErrorBanner();

    const resultPromise = runQuery(sql);

    refreshDataTab(resultPromise, seq);

    try {
        const result = await resultPromise;

        if (seq === runSeq) {
            notify(resultStatusMessage(result));
            onRun?.({ sql, timestamp: Date.now(), ok: true, rowCount: resultRowCount(result) });
        }
    } catch (error) {
        if (seq === runSeq) {
            onError(error);
            showErrorBanner(error);
            onRun?.({ sql, timestamp: Date.now(), ok: false, rowCount: 0 });
        }
    } finally {
        if (seq === runSeq) {
            setBusy(false);
        }
    }
}
```

The `Component.afterNextLayout(() => editor.focus())` that used to live in the `try` block ([QueryPanel.ts:661](frontend/src/dock/QueryPanel.ts#L661)) moves into `refreshDataTab`, above — tab selection now happens synchronously at the top of `run()`, not after the fetch resolves, so the refocus has to follow the same timing.

### The error banner

Three new closures, placed after `syncDiagramButton` ([QueryPanel.ts:519-521](frontend/src/dock/QueryPanel.ts#L519)) and three new `let`s beside the other pane state ([QueryPanel.ts:193-216](frontend/src/dock/QueryPanel.ts#L193)):

```typescript
// The durable error banner for a failed run, built once on first use and
// reused (content replaced) on every later failure. Lives at the bottom of
// the whole panel (Placement.SOUTH), independent of resultHost's own
// shown/hidden state, so it works the same whether a Data tab exists or not.
let errorBanner: Component | null = null;
let errorBannerText: Text | null = null;
let errorBannerShown = false;
```

```typescript
/** Build the banner row on first use: warning glyph, wrapping message text, dismiss button. */
function ensureErrorBanner(): Component {
    if (!errorBanner) {
        const icon    = new Glyph("circle-exclamation", { foregroundColor: DESTRUCTIVE_COLOR });
        const dismiss = glyphButton("xmark", NEUTRAL_COLOR, "Dismiss", () => hideErrorBanner());

        errorBannerText = new Text("", { whiteSpace: "normal", truncate: false });

        errorBanner = Container({ layoutManager: new HBox({ spacing: 8, stretching: true }) });
        errorBanner.addComponent(icon);
        errorBanner.addComponent(errorBannerText, { weight: 1 });
        errorBanner.addComponent(dismiss);
        errorBanner.setBackgroundColor(ERROR_BANNER_BG);
    }

    return errorBanner;
}

/** Show (or refresh) the error banner with `error`'s message. */
function showErrorBanner(error: unknown): void {
    const banner = ensureErrorBanner();

    errorBannerText!.setText(error instanceof Error ? error.message : String(error));

    if (!errorBannerShown) {
        panel.addComponent(banner, { placement: Placement.SOUTH });
        errorBannerShown = true;
        panel.doLayout();
        syncToolbarButtons();
    }
}

/** Hide the error banner (Dismiss, a new run starting, or Clear). A no-op when not showing. */
function hideErrorBanner(): void {
    if (errorBannerShown) {
        panel.removeComponent(errorBanner!);
        errorBannerShown = false;
        panel.doLayout();
        syncToolbarButtons();
    }
}
```

A new module-level constant beside `EDITOR_HEIGHT` ([QueryPanel.ts:89](frontend/src/dock/QueryPanel.ts#L89)):

```typescript
// A light wash derived from DESTRUCTIVE_COLOR's channel values (rgb(198, 40,
// 40)) at low opacity, so the banner reads as "error" without competing with
// the grid/toolbar for attention.
const ERROR_BANNER_BG = "rgba(198, 40, 40, 0.08)";
```

`error.message` is used directly rather than the richer extraction `SqlAdminController.errorMessage` performs ([SqlAdminController.ts:3010](frontend/src/SqlAdminController.ts#L3010)): every error this banner ever sees comes from `runQuery` → `postJson` ([data/api.ts:122](frontend/src/data/api.ts#L122)), which already throws a plain `Error` whose `.message` is `readDetail`'s fully-extracted backend detail string. `errorMessage`'s extra cases (an object with a `.body`, FastAPI's array-shaped validation `detail`) do not occur on this path.

### `clear()`

Replaces [QueryPanel.ts:467-475](frontend/src/dock/QueryPanel.ts#L467):

```typescript
function clear(): void {
    ++runSeq; // invalidate any in-flight run — see the clear()/runSeq decision above

    editor.setValue("");
    removeDataTab();
    removeChartTab();
    removeDiagramTab();
    removeExplainTab(); // the last removal empties the strip → "empty" → hideResultPane
    hideErrorBanner();
    setActiveExport(null);
    setBusy(false); // re-enable run/explain/chart/diagram buttons in case a run was in flight
}
```

### `syncToolbarButtons()`

`clearButton`'s condition in [QueryPanel.ts:509](frontend/src/dock/QueryPanel.ts#L509) gains the banner as a third reason to stay enabled — a user who cleared the editor text after a first-run error (no result pane, `resultShown === false`) can still reach Clear to dismiss the banner, not just the banner's own × button:

```typescript
clearButton.setEnabled(hasSql || resultShown || errorBannerShown);
```

### Imports and glyph registration

Add to the existing imports:

```typescript
import { Border as BorderLayout, Split, HBox } from "@jimka/typescript-ui/layout";
import { Text }                                 from "@jimka/typescript-ui/component/input";
import { circle_exclamation }                   from "@jimka/typescript-ui/glyphs/solid/circle_exclamation";
import { xmark }                                from "@jimka/typescript-ui/glyphs/solid/xmark";
```

(`Component`, `Container`, `Glyph`, `Placement`, `DESTRUCTIVE_COLOR`, `NEUTRAL_COLOR`, `glyphButton` are already imported.)

Add `circle_exclamation, xmark` to the file's `Glyph.register(...)` call ([QueryPanel.ts:85](frontend/src/dock/QueryPanel.ts#L85)).

---

## Ordered Implementation Steps

1. **`QueryPanel.ts` — imports and glyph registration.** Add `HBox` to the layout import, `Text` from `component/input`, the `circle_exclamation`/`xmark` glyph imports, and register both glyphs, per `## Internal Structure`.
2. **`QueryPanel.ts` — new module constant.** Add `ERROR_BANNER_BG` beside `EDITOR_HEIGHT`.
3. **`QueryPanel.ts` — new pane state.** Add `errorBanner`, `errorBannerText`, `errorBannerShown` beside the existing slot `let`s ([QueryPanel.ts:193-216](frontend/src/dock/QueryPanel.ts#L193)).
4. **`QueryPanel.ts` — `liveTabCount`.** Add near `removeDiagramTab`.
5. **`QueryPanel.ts` — the error banner functions.** Add `ensureErrorBanner`, `showErrorBanner`, `hideErrorBanner` after `syncDiagramButton`.
6. **`QueryPanel.ts` — `syncToolbarButtons`.** Widen `clearButton`'s condition to include `errorBannerShown`.
   - Check: `grep -n "clearButton.setEnabled" frontend/src/dock/QueryPanel.ts` shows the three-way condition.
7. **`QueryPanel.ts` — `resultStatusMessage`.** Add beside `resultRowCount`.
8. **`QueryPanel.ts` — `refreshDataTab`.** Add per `## Internal Structure`, placed where `showRowsResult` currently sits.
9. **`QueryPanel.ts` — delete `showResult` and `showRowsResult`.**
   - Check: `grep -n "function showResult\|function showRowsResult\|showResult(\|showRowsResult(" frontend/src/dock/QueryPanel.ts` — zero matches anywhere in the file.
10. **`QueryPanel.ts` — rewrite `run()`** per `## Internal Structure`, including the `hideErrorBanner()` call at the top and the moved `Component.afterNextLayout` (now inside `refreshDataTab`, not here).
11. **`QueryPanel.ts` — rewrite `clear()`** per `## Internal Structure` (the `++runSeq`, the `hideErrorBanner()` call, and `setBusy(false)` replacing the old trailing `syncChartButton()`).
    - Check: `grep -n "syncChartButton();$" frontend/src/dock/QueryPanel.ts` inside `clear()`'s old body no longer appears there (it still appears inside `setBusy`, which is fine).
12. **`QueryPanel.ts` — file header comment.** Update [QueryPanel.ts:1-41](frontend/src/dock/QueryPanel.ts#L1) to describe: the Data tab now appears immediately with a spinner covering both the fetch and the grid build; a re-run's failure or non-rows result never discards an already-loaded Data tab; and the new error banner alongside the unchanged toast/status-bar convention.
13. **Typecheck.** `cd frontend && npm run typecheck` — clean.
14. **Grep invariants** (run from `frontend/`):
    - `grep -n "refreshingTabs = true" src/dock/QueryPanel.ts` — still exactly 3 (Chart, Explain, Diagram); none added around the Data tab.
    - `grep -n "resultHost.addTab" src/dock/QueryPanel.ts` — 4 call sites (Data via the factory, Chart, Explain, Diagram), and the Data one is the only one whose first argument is not a bare `content`/`editor` variable.
    - `grep -rn "showResult\b\|showRowsResult\b" src/dock/` — zero matches.
15. **Manual verification** per `## Expected Behaviour`.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `frontend/src/dock/QueryPanel.ts` |

No other file changes. `QueryResultView.ts`, `data/api.ts`, and `SqlAdminController.ts` are read-only context for this plan.

---

## Expected Behaviour

The SQLAdmin frontend's vitest harness runs with `environment: "node"` (`frontend/vitest.config.ts`) and covers pure data helpers only — `QueryPanel` is entirely DOM/event-bound, so every case below is **manual-verify** in a running browser against a real database, per the same constraint `plans/implemented/lazy-tab-loading-sequence.md` and `plans/implemented/result-pane-tabs.md` both recorded for this file.

**First run in a fresh panel (rows result)**
1. Type a `SELECT` and hit Run. A "Data" tab appears in the (newly-shown) result pane within one frame, showing the library's centred spinner, selected. The status bar reads "Running…".
2. When the fetch resolves, the spinner is replaced by the grid in the same tab (no tab close/reopen, no strip repositioning). The status bar shows the row count; the Export and Chart buttons enable as appropriate.
3. The editor keeps keyboard focus throughout (verify by typing immediately after clicking Run, before the fetch resolves).

**First run in a fresh panel (non-rows: INSERT/UPDATE/DDL)**
4. Run a non-`SELECT` statement. A "Data" tab may flash briefly (spinner) if the fetch takes longer than a couple of frames, then vanishes once the backend responds, and the result pane hides again (no tabs left). The status bar shows the command tag. This brief flash is expected — see `## Potential Challenges`.

**Re-run with an existing Data tab (success)**
5. Run a query successfully, then edit and re-run. A new "Data" tab (spinner) becomes active; the prior tab's content is gone once the new one lands — end state is exactly one Data tab, freshly populated. The gutter position is preserved.

**Re-run with an existing Data tab (fetch error)**
6. Run a query successfully, then edit the SQL into something invalid and re-run. The old Data tab (with its original rows) is **not** destroyed — it remains in the strip with its data intact, though it may no longer be the active tab (the library selects a neighbor once the failed attempt's own tab is torn down). The toast, status-bar error line, and the new error banner (case 9 below) all appear.

**Re-run with an existing Data tab (non-rows result)**
7. Run a query successfully, then run an UPDATE/DDL statement in the same panel. The old Data tab **is** removed (matching today's existing behavior for a command-tag result) — any Chart/Explain tab survives.

**Overlapping runs (accepted limitation)**
8. Trigger two runs in quick succession via Ctrl/Cmd+Enter before the first's fetch resolves (the Run button disables during a run, but the shortcut does not check it). Both attempts' tabs may transiently coexist; once both fetches settle, exactly one Data tab reflects the newer run's result — the older one's own tab is silently torn down by its own staleness check. No wrong data is ever shown as final.

**Error banner**
9. Any failed run (first or re-run) shows a banner at the bottom of the whole query panel (below the editor when no result pane is shown, below the result pane otherwise) with a warning icon, the full error text (wrapping, not clipped), and a × dismiss button — alongside the unchanged 3-second toast and status-bar line.
10. Clicking × hides the banner. Starting a new run (Run again) hides any existing banner immediately, before the new fetch begins, and shows a fresh one only if the new run also fails.
11. Clear hides the banner (and everything else the button already resets, per today's behavior).
12. Clear is enabled whenever the banner is showing, even if the editor is empty and no result pane is open (case 4's "flash and vanish" state, then editor cleared).

**Existing behavior, unaffected**
13. Chart, Explain, Explain Analyze, and Explain diagram continue to build synchronously exactly as today — no spinner change for any of them.
14. `autoRun` (Open-as-query "Execute") and `autoExplain` (view panel's Explain actions) still work: `autoRun` produces a spinner-then-grid Data tab on open, same as a manual first run.

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm run test` — unaffected existing suite still passes (no test file touches `QueryPanel.ts`).
- `cd frontend && npm run build` — clean.
- The grep invariants in `## Ordered Implementation Steps`, step 14.
- Manual smoke per `## Expected Behaviour`, cases 1-14, against a real database: `docker compose up`, sign in, open a query tab, and walk the cases — the same manual-verify convention `plans/implemented/lazy-tab-loading-sequence.md` used for this same file.

---

## Potential Challenges

- **Chart button staleness for a few milliseconds.** `run()`'s own `try`/`catch`/`finally` is attached to `resultPromise` before the Data-tab factory (which only starts running after the library's two-`requestAnimationFrame` yield), so `setBusy(false)`'s defensive `syncChartButton()` call can run slightly before the factory sets `dataSlot`. The factory calls `syncChartButton()` itself once it finishes a few milliseconds later, so the button self-corrects; the visible staleness window is sub-frame and not worth engineering around.
- **The library's default post-close tab reselection, not the old Data tab, may become active after a re-run error.** Deliberately not overridden — see `## Notes`. The data itself is preserved either way.
- **A first-run non-rows statement briefly flashes a "Data" tab.** Accepted trade-off of committing to the tab *before* knowing the result kind, which is required to cover the fetch itself with a spinner — the alternative (waiting to know the result kind before adding a tab) would mean the network fetch itself is never covered by a spinner, defeating the point of this plan.
- **`clear()` now bumps `runSeq`.** Forgetting the companion `setBusy(false)` would leave the toolbar buttons disabled forever after a Clear that interrupted an in-flight run, since `run()`'s own `finally` would then see `seq !== runSeq` and skip re-enabling them.

---

## Critical Files

- [frontend/src/dock/QueryPanel.ts](frontend/src/dock/QueryPanel.ts) — the entire change.
- [frontend/src/dock/QueryResultView.ts](frontend/src/dock/QueryResultView.ts) — `QueryResultGrid`'s constructor, confirmed synchronous; unchanged, but the factory constructs it, so its shape matters.
- [frontend/src/data/api.ts:122-134,271-273](frontend/src/data/api.ts#L122) — `postJson`/`readDetail`/`runQuery`: confirms every error the banner sees is a plain `Error` with a pre-extracted `.message`.
- `plans/implemented/lazy-tab-loading-sequence.md` — the async-factory-plus-spinner idiom this plan reuses (`Dock.addLazyPanel` + `Tab`'s lazy materialization), including its own `PanelLoadError`/staleness reasoning that this plan's `runSeq` check mirrors at the `TabPanel` level.
- `plans/implemented/result-pane-tabs.md` — the current Data/Chart/Explain `TabPanel` architecture this plan modifies; its `refreshingTabs` guard and add-before-remove convention are why `## Architecture Decisions` explains why the Data tab does *not* need that guard.
- [frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/container/TabPanel.d.ts](frontend/node_modules/@jimka/typescript-ui/dist/lib/types/component/container/TabPanel.d.ts) (source: `packages/lib/src/typescript/lib/component/container/TabPanel.ts` in the typescript-ui repo) — `addTab`/`addLazyTab`'s exact factory-accepting signature.
- `packages/lib/src/typescript/lib/layout/Tab.ts` in the typescript-ui repo — `materializeAsync` (the spinner/factory mechanics), `setActiveTabIndex`/`setActiveContent`/`indexOfContent` (why index-based selection is required for an unbuilt lazy entry), `closeEntry`/`failEntry` (what a factory rejection tears down), and `addDeferredComponent` (confirms the synchronous vs. next-layout registration asymmetry between a lazy factory and an eager component).
- [frontend/src/SqlAdminController.ts:2950-2980](frontend/src/SqlAdminController.ts#L2950) — `openAsyncPanel`, the `Dock`-level sibling of this plan's `refreshDataTab`; read for the parallel structure, not because this plan touches it.

---

## Non-Goals

- **An error banner for Explain / Explain Analyze / Explain diagram failures.** Scoped to `run()`'s query errors, per the task's own framing. Extending the banner to the other actions is straightforward later (they share `onError`) but is not requested here.
- **Cancelling the in-flight fetch itself.** `postJson`/`fetch` carry no `AbortController`; a superseded or cleared run's HTTP request still completes, its result is just discarded. Adding real cancellation is a separate, larger change to `data/api.ts`.
- **Re-selecting the surviving Data tab after a re-run error.** The library's default neighbor-reselection is accepted as-is; see `## Notes` for why a more precise reselect was not attempted.
- **Preventing the brief "Data" tab flash on a first-run non-rows statement.** Inherent to committing to the tab before the result kind is known; see `## Potential Challenges`.
- **Changing Chart, Explain, Explain Analyze, or the Explain diagram tab's build mechanics.** All three stay exactly as they are today (synchronous, add-then-remove under `refreshingTabs`).
- **A persistent (`duration: 0`) toast instead of a banner.** `Notification.show` supports it, but it does not address the task's "no in-panel indication near the editor/result pane" complaint — only placement does.

---

## Notes

[^tabpanel-not-dock]: `openTable`/`openAsyncPanel` register a top-level `Dock` tab via `Dock.addLazyPanel`, which internally wraps the lazy factory in a dedicated single-tab identity frame (its own strip-hidden `Tab`) so the *frame* — an already-built, eager component — can be the target of the outer region's `setActiveContent`. `resultHost` here is not the Dock; it is an ordinary `TabPanel` the query panel owns directly, sitting among up to three sibling tabs (Data/Chart/Explain). `TabPanel.addTab`/`addLazyTab` expose the exact same underlying `Tab.addDeferredComponent` + `Tab.materializeAsync` + `createSpinnerWrap()` machinery `Dock` uses, reached one layer more directly, with no need for a wrapper frame — confirmed by reading `TabPanel.ts` and `Tab.ts` in the typescript-ui source rather than assumed from the `Dock` precedent.

[^shared-promise]: `run()`'s single `await runQuery(sql)` was previously the one place both the rows-vs-status decision and the grid build happened, plus feeding `onRun` history and the `runSeq` staleness guard. Splitting the fetch from its two consumers without sharing the promise would mean two network round trips per run (one for the tab, one for `run()`'s own bookkeeping) — wrong on both cost and correctness grounds (the two round trips could theoretically race to different results under retries/timeouts). Restructuring `run()` so its own bookkeeping and the tab-affecting logic are two independent `await`s of one already-started promise, rather than nesting one inside the other, is what lets the Data tab's spinner appear at click time while `run()`'s status/history bookkeeping keeps its exact current shape and timing.

[^error-vs-nonrows]: Both cases end the same way for the Data tab (no tab, via a thrown error inside the factory), but they reach that end differently on purpose. A non-rows *current* run is a successful execution with nothing to show in Data — the factory actively cleans up (`removeDataTab`, `syncExportToActiveTab`, `syncChartButton`) before throwing, exactly mirroring what `showResult`'s old status branch did. A fetch rejection is not cleaned up by the factory at all; it is simply allowed to propagate, so `removeDataTab` is never reached and an existing good tab survives untouched. Collapsing these into one code path (e.g., always calling `removeDataTab()` before throwing) would silently break the "a re-run's error doesn't discard prior good data" requirement this plan exists to satisfy.

[^reselect-not-attempted]: After a re-run error, the newly-added (now failing) Data tab is torn down by the library's own `closeEntry`, which reselects the closed tab's left neighbor. If Chart or Explain sit between the surviving old Data tab and the new one in the strip (the new tab is always appended at the end, so this happens whenever another tab was opened after Data), the user lands on Chart/Explain rather than back on their good data. Explicitly re-selecting the surviving `dataSlot.content` from `run()`'s own `catch` block was considered, but discarding it: `run()`'s own promise continuation and the factory's internal one are both attached to `resultPromise`, and their firing order relative to each other (needed to know whether an explicit reselect in `run()`'s catch would run before or after the library's own reselect, which would otherwise clobber it) depends on V8's microtask-queue attachment order across a `requestAnimationFrame`-delayed continuation — an implementation detail, not a contract, and not something worth encoding a UX nicety on. The important guarantee — the data is not destroyed — holds regardless of which tab ends up focused.

[^banner-placement]: An earlier angle considered nesting the banner into a new header wrapper (a `VBox` of `[toolbar, banner]`) replacing the toolbar's direct `Placement.NORTH` slot on `panel`. Rejected for `Placement.SOUTH` on the *existing* `panel` instead: `Placement.SOUTH` needs no restructuring of the toolbar's existing placement, and it puts the banner physically adjacent to what the user is looking at — right below the editor on a first-run failure (no result pane at all), or right below the still-visible good Data tab on a re-run failure — rather than at the very top of the panel, above the toolbar, which is comparatively far from either.

[^rejected-error-tab]: The task's own framing offered two shapes for the durable error surface: an inline banner, or an error-content Data-tab state (the factory *resolving* with an error view instead of throwing). The latter was rejected because it does not compose with the "don't discard good data on a re-run error" requirement: if the factory resolves (successfully, from the library's point of view) with an error view, the library never runs its failure teardown on the new tab, so on a re-run the strip would end up with *two* tabs both labeled "Data" — the old one (still good, inactive) and the new one (now permanently showing an error, active) — until the user runs again. A banner avoids this entirely: it has no tab-identity concerns, so it works identically for a first run (nothing to preserve) and a re-run (something to preserve) with one code path.

[^index-choice]: Two alternatives to the tab-count-based index were considered and rejected. `Tab.setActiveTabIndex(Number.MAX_SAFE_INTEGER)` (relying on `setActiveTabIndex`'s documented clamp-to-`[0, tabCount-1]` behavior to always land on the tab just appended) is technically correct but reads as a trick with no existing precedent anywhere in this codebase or the library's own call sites (`grep`-checked). Wrapping the lazy factory in a dedicated single-tab identity frame, mirroring `Dock.addLazyPanel`'s internal mechanism exactly, was rejected as needless indirection for a `TabPanel` that is not the `Dock` and has no serialization/re-open-dedup requirement driving that extra layer in `Dock`'s case (see `## Architecture Decisions`'s `TabPanel`-not-`Dock` decision above). Counting the panel's own four slots is mechanical, uses only public API, and already has to exist for other reasons (`syncChartButton`, `clear()` all reason about the same four slots).

[^clear-runseq]: Before this plan, `clear()` never touched `runSeq`, so a run in flight when Clear was pressed would still land: `run()`'s `finally` block would see `seq === runSeq` (unchanged) and call `setBusy(false)` correctly, but its success branch would also still fire (`showResult`/the equivalent bookkeeping), silently repopulating whatever the user had just cleared. This was a latent, low-visibility bug before this plan (a stale result reappearing after Clear); this plan's optimistic tab-add makes the same gap produce a more visible artifact (a spinner tab reappearing in an emptied panel), which is why it is fixed here rather than left for a separate change. The fix (`++runSeq` in `clear()`) has one side effect that must be compensated: `run()`'s `finally` now also sees `seq !== runSeq` and skips its own `setBusy(false)`, so `clear()` must re-enable the buttons itself — which it now does, replacing its old direct `syncChartButton()` call with the strictly-more-complete `setBusy(false)`.
