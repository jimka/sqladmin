---
depends-on: [typescript-ui-0-10-0-upgrade]
touches-shared: [frontend/src/SqlAdminController.ts, frontend/src/controller/controllerText.ts, LIBRARY_NOTES.md]
---

# Dock `beforeclose` Unsaved-Changes Guard — Implementation Plan

## Overview

SQLAdmin's dirty-tab close guard lives in the `SqlAdminController` constructor
([`frontend/src/SqlAdminController.ts:272-313`](frontend/src/SqlAdminController.ts#L272)).
It finds every `Tab` region through the Dock's `"attach"`/`"move"` events, adds a
`"beforetabclose"` listener to each one (a `WeakSet<Tab>` stops duplicates), vetoes a
dirty tab's close, asks `Dialog.confirm`, and on "yes" calls `dock.removePanel`.
That guard only sees a tab's own ✕. A float window's chrome ✕ (the title-bar close of a
torn-off tab window) closes every tab inside it with no prompt, dirty or not.

typescript-ui 0.10.0 adds a Dock-level vetoable `"beforeclose"` event. It fires for a
tab's ✕ (tiled or floated) and for a float window's chrome ✕, and hands the listener
the panel plus a controller whose `preventDefault()` cancels the close
([`Dock.ts:1710-1734`](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L1710)).
This plan replaces the per-region wiring with one `dock.on("beforeclose", …)`
subscription. Every close the user starts in one gesture is grouped into one batch,
so a float window holding several dirty tabs produces **one** combined confirm, and
confirming closes all of them.

The change touches `SqlAdminController.ts`, adds a small pure batching module
`frontend/src/controller/closeRequestBatcher.ts`, adds one prompt-text function to
`frontend/src/controller/controllerText.ts`, updates one comment in
`frontend/src/dock/DocumentationPanel.ts`, and logs one library papercut in
`LIBRARY_NOTES.md`. `hasUnsavedWork()` and the `beforeunload` guard are unchanged.

---

## Architecture Decisions

### One `dock.on("beforeclose")` listener replaces the per-region `"beforetabclose"` wiring

The controller subscribes once to the Dock's `"beforeclose"` event, next to its other
`dock.on(...)` subscriptions. The `WeakSet<Tab>`, the `wireBeforeTabClose` closure,
its two `"attach"`/`"move"` registrations, and the now-unused `Tab` import are
deleted.[^why-dock-level] The existing `dock.on("attach", …)` that feeds
`_openContents` ([`SqlAdminController.ts:236-238`](frontend/src/SqlAdminController.ts#L236))
stays — it serves `hasUnsavedWork()`, not the close guard.

The overall shape — veto synchronously, ask with `Dialog.confirm`, then close with the
unguarded `dock.removePanel(id)` — is kept from the current guard
([`SqlAdminController.ts:289-309`](frontend/src/SqlAdminController.ts#L289)), which
`plans/implemented/app-wide-unsaved-changes-guard.md` established. Dirtiness is still
read live as `e.content.isDirty()` on the Dock's identity frame, so no per-panel-type
code is needed.

### A batch is every `"beforeclose"` event raised in one synchronous turn

A **batch** is the set of `"beforeclose"` events the Dock emits during one piece of
synchronous JavaScript — one user gesture. The first event of a turn schedules a
flush with `queueMicrotask`; later events in the same turn join the pending batch;
the flush runs after the turn ends and decides whether to prompt.[^turn-is-exact]

The Dock emits these shapes, confirmed in the library source:

| User gesture | `"beforeclose"` events in the turn | Controller objects |
|---|---|---|
| Tab ✕ (tiled or float), context-menu *Close* | 1 | 1 (fresh per tab) |
| Float window chrome ✕, window holds tabs A, B, C | 3 (A, B, C) | 1, **shared** by all three |
| Tab context menu *Close all* / *Close others* / *Close all to the left/right* over A, B, C | 3 | 3 (one fresh one per tab) |

Grouping by turn, rather than by controller object, gives the bulk-close menu rows the
same one-prompt behaviour as the window ✕ at no extra cost.[^bulk-close]

### Which panels a confirmed batch closes: those whose close was actually vetoed

For each event the batcher records the panel id, whether it is dirty, and its
controller. A dirty event calls `preventDefault()` on its controller right away (the
veto must be synchronous). At flush time, the ids to close on "yes" are the ids of
**every event whose controller was vetoed** — dirty or clean. Clean panels whose own
controller was never vetoed have already closed by then, so they are left out.

| Gesture | Events (id, dirty, controller) | Vetoed controllers | Closed on "yes" | Already closed |
|---|---|---|---|---|
| Window ✕ | (A clean, W) (B dirty, W) (C clean, W) | W | A, B, C | — |
| Window ✕ | (A clean, W) (B clean, W) | none | no prompt | A, B (library closes the window) |
| *Close all* | (A clean, V1) (B dirty, V2) (C dirty, V3) | V2, V3 | B, C | A |
| Tab ✕ | (A dirty, V1) | V1 | A | — |

The decision is evaluated at flush, not per event, because a window close's clean
first tab only learns it was vetoed when a later dirty tab vetoes the shared
controller.[^flush-time]

### Closing a confirmed batch uses `dock.removePanel` for each id

On "yes", the controller calls `this.dock.removePanel(id)` for every id in the batch,
in event order. When the last tab leaves a float, the float closes itself; its own
`"beforeclose"` then finds no registered panels and emits nothing, so there is no
second prompt.[^remove-closes-window] On "no" (or the dialog's own ✕ / Escape),
nothing further happens: the vetoed panels stay open.

### The prompt text depends on how many panels close and how many are dirty

A new pure function `closeGuardPrompt(closingCount, dirtyCount)` in `controllerText.ts`
returns the title and message:

| `closingCount` | `dirtyCount` | Title | Message |
|---|---|---|---|
| 1 | 1 | `Close tab` | `This tab has unsaved changes. Are you sure that you want to close it?` |
| 3 | 3 | `Close tabs` | `3 tabs have unsaved changes. Are you sure that you want to close them?` |
| 3 | 1 | `Close tabs` | `1 of the 3 tabs being closed has unsaved changes. Are you sure that you want to close them?` |
| 4 | 2 | `Close tabs` | `2 of the 4 tabs being closed have unsaved changes. Are you sure that you want to close them?` |

Rule: `closingCount === 1` → the single-tab text (unchanged from today). Otherwise, if
every closing tab is dirty → `N tabs have …`; else `D of the N tabs being closed
has/have …` (`has` when `D === 1`).[^single-tab-window]

### The batching logic is a pure module under `controller/`, unit-tested under node vitest

`CloseRequestBatcher` lives in `frontend/src/controller/closeRequestBatcher.ts` with
**no library imports**, so the node vitest can load it. The controller keeps the
library-touching parts (`Dialog.confirm`, `dock.removePanel`) in one private arrow
field it hands to the batcher. This mirrors `controllerText.ts`, which the controller
split pulled out "free of library imports so the node vitest can load it"
([`controllerText.ts:1-5`](frontend/src/controller/controllerText.ts#L1)).[^pure-module]
The confirm callback is an arrow-function field because it is passed by reference
(`frontend/COMPONENT_CONVENTIONS.md` §(c)).

### No library change is needed; the typing gap is logged as a papercut

Clean batching is possible on the 0.10.0 event shape: the shared-controller guarantee
is documented on `onFloatBeforeClose`, and the synchronous-turn boundary follows from
the fact that every emitter reads the veto synchronously, right after emitting.[^turn-is-exact] One real papercut remains:
`Dock.on("beforeclose")` types its listener's controller as `TabCloseController` even
when the Dock forwards a `WindowCloseController`
([`Dock.ts:2275`](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L2275),
[`:2365`](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L2365)). The
two interfaces are identical in shape, so nothing breaks; it is logged in
`LIBRARY_NOTES.md` rather than worked around.[^no-library-change]

---

## Public API

New module `frontend/src/controller/closeRequestBatcher.ts`:

```ts
/**
 * The veto handle a Dock "beforeclose" listener receives. Structurally matches both
 * the library's TabCloseController and WindowCloseController, so this module needs
 * no library import.
 */
export interface CloseVeto {
    preventDefault(): void;
}

/** One gesture's vetoed close, handed to the confirm step. */
export interface VetoedClose {
    /** Every panel whose close was vetoed — dirty or clean — in event order. */
    readonly ids: readonly string[];
    /** How many of `ids` are dirty; always at least 1. */
    readonly dirtyCount: number;
}

/** Schedules `flush` to run once the current synchronous turn has finished. */
export type FlushScheduler = (flush: () => void) => void;

export class CloseRequestBatcher {
    /**
     * @param onVetoed - Called once per batch that vetoed at least one close.
     * @param schedule - Defaults to `queueMicrotask`; tests inject a manual one.
     */
    constructor(onVetoed: (close: VetoedClose) => void, schedule?: FlushScheduler);

    /**
     * Record one "beforeclose" event. Vetoes `veto` synchronously when `dirty`.
     *
     * @param id - The closing panel's Dock id.
     * @param dirty - Whether the panel has unsaved changes right now.
     * @param veto - The controller the Dock handed the listener.
     */
    add(id: string, dirty: boolean, veto: CloseVeto): void;
}
```

Added to `frontend/src/controller/controllerText.ts`:

```ts
/** Title and message for the unsaved-changes close confirm. */
export interface CloseGuardPrompt {
    readonly title  : string;
    readonly message: string;
}

export function closeGuardPrompt(closingCount: number, dirtyCount: number): CloseGuardPrompt;
```

`SqlAdminController`'s public surface is unchanged.

---

## Implementation

`closeRequestBatcher.ts` private state and flush:

```ts
interface CloseEvent {
    readonly id   : string;
    readonly dirty: boolean;
    readonly veto : CloseVeto;
}

export class CloseRequestBatcher {
    private readonly _onVetoed: (close: VetoedClose) => void;
    private readonly _schedule: FlushScheduler;
    // null between turns; the first add() of a turn creates it and schedules a flush.
    private _events: CloseEvent[] | null = null;
    // The controllers this batch has called preventDefault() on.
    private _vetoed: Set<CloseVeto> = new Set();

    constructor(onVetoed: (close: VetoedClose) => void, schedule: FlushScheduler = queueMicrotask) {
        this._onVetoed = onVetoed;
        this._schedule = schedule;
    }

    add(id: string, dirty: boolean, veto: CloseVeto): void {
        if (this._events === null) {
            this._events = [];
            this._schedule(this.flush);
        }

        this._events.push({ id, dirty, veto });

        if (dirty) {
            veto.preventDefault();
            this._vetoed.add(veto);
        }
    }

    // Arrow field: handed to the scheduler by reference.
    private flush = (): void => {
        const events = this._events ?? [];
        const vetoed = this._vetoed;

        this._events = null;
        this._vetoed = new Set();

        const ids        = events.filter(event => vetoed.has(event.veto)).map(event => event.id);
        const dirtyCount = events.filter(event => event.dirty).length;

        if (dirtyCount === 0) {
            return;
        }

        this._onVetoed({ ids, dirtyCount });
    };
}
```

Reset the state **before** calling `_onVetoed`, so a close that the callback triggers
starts a fresh batch.

Controller wiring, replacing lines 272-313 of `SqlAdminController.ts`:

```ts
// Dirty-tab close guard. The Dock's "beforeclose" covers a tab's ✕ (tiled or
// floated), the tab menu's close rows, and a float window's chrome ✕. Every
// event of one gesture joins one batch, so a float holding several dirty tabs
// asks once — see controller/closeRequestBatcher.ts.
this.dock.on("beforeclose", (e: DockPanelEvent, closeController) => {
    const dirty = e.content.isDirty();

    this._closeBatcher.add(e.id, dirty, closeController);
});
```

New members:

```ts
// Groups one gesture's "beforeclose" events into one confirm (see the
// "beforeclose" subscription in the constructor).
private readonly _closeBatcher: CloseRequestBatcher;

/**
 * Ask once about a gesture's vetoed closes, and close every vetoed panel on
 * "yes". dock.removePanel is the unguarded programmatic path, so this cannot
 * re-trigger the prompt. Arrow field: handed to CloseRequestBatcher by reference.
 *
 * @param close - The batch's vetoed panel ids and dirty count.
 */
private confirmVetoedClose = (close: VetoedClose): void => {
    const prompt = closeGuardPrompt(close.ids.length, close.dirtyCount);

    void Dialog.confirm(prompt.title, prompt.message).then(confirmed => {
        if (!confirmed) {
            return;
        }

        for (const id of close.ids) {
            this.dock.removePanel(id);
        }
    });
};
```

Assign `this._closeBatcher = new CloseRequestBatcher(this.confirmVetoedClose);` in
the constructor **before** the `dock.on("beforeclose", …)` line. `SqlAdminController`
extends nothing, so its arrow fields are already initialised when the constructor
body runs.

---

## Ordered Implementation Steps

1. **Worktree setup.** Symlink the main tree's `frontend/node_modules` into the
   worktree's `frontend/` (see memory "Worktree node_modules symlink"). Check that
   `frontend/node_modules/@jimka/typescript-ui` resolves to
   `/home/jika/typescript/typescript-ui/packages/lib` and that
   `grep -n '"beforeclose"' frontend/node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts`
   finds the Dock overload (the 0.10.0 build). Do not change `package.json`.
2. **Write the batcher tests first.** Create
   `frontend/tests/controller/closeRequestBatcher.test.ts` covering cases B1-B9 in
   `## Expected Behaviour`. Inject a manual scheduler
   (`let pending: (() => void) | null = null; const schedule = (f: () => void) => { pending = f; };`)
   and fake vetoes (`{ preventDefault: vi.fn() }`). Run `npm test` in `frontend/` —
   expect failures (module missing).
3. **Create `frontend/src/controller/closeRequestBatcher.ts`** per `## Public API`
   and `## Implementation`, with a header comment in the style of
   `controllerText.ts:1-5` saying it is pure and why. No imports from
   `@jimka/typescript-ui`. Check: `grep -n typescript-ui frontend/src/controller/closeRequestBatcher.ts`
   → zero matches; `npm test` → B1-B9 pass.
4. **Write the prompt tests.** Add a `describe("closeGuardPrompt", …)` block to
   `frontend/tests/controller/controllerText.test.ts` covering P1-P5. Run — expect
   failures.
5. **Add `CloseGuardPrompt` and `closeGuardPrompt` to
   `frontend/src/controller/controllerText.ts`** (after `tableExportFilename`), with
   JSDoc. Check: `npm test` → P1-P5 pass.
6. **Rewire `frontend/src/SqlAdminController.ts`:**
   - Import `CloseRequestBatcher` and `type VetoedClose` from
     `./controller/closeRequestBatcher`, and add `closeGuardPrompt` to the existing
     `./controller/controllerText` import.
   - Add the `_closeBatcher` field (next to `_openContents`, line 171) and the
     `confirmVetoedClose` arrow field with its JSDoc.
   - Delete lines 272-313 (the comment, `wiredTabRegions`, `wireBeforeTabClose`,
     and both `dock.on("attach"/"move", wireBeforeTabClose)` calls). Put the
     `_closeBatcher` assignment and the `dock.on("beforeclose", …)` block from
     `## Implementation` in their place.
   - Change line 14 to `import { HBox } from "@jimka/typescript-ui/layout";`,
     keeping the file's column alignment.
   - Checks: `grep -n 'beforetabclose\|wiredTabRegions\|wireBeforeTabClose\|\bTab\b' frontend/src/SqlAdminController.ts`
     → zero matches; `grep -c 'dock.on("attach"' frontend/src/SqlAdminController.ts`
     → `1` (the `_openContents` one).
7. **Update the comment in `frontend/src/dock/DocumentationPanel.ts:31-33`**: replace
   "SqlAdminController's beforetabclose veto" with "SqlAdminController's Dock
   "beforeclose" veto". Check: `grep -rn beforetabclose frontend/src` → zero matches.
8. **Add a `LIBRARY_NOTES.md` entry** at the top (newest first), titled
   `` ## ✂️🔎 `Dock.on("beforeclose")` types a window close's controller as `TabCloseController` (0.10.0) ``.
   Say: `Dock.ts:2275` (and the `DockOptions.listeners.beforeclose` entry at `:108`)
   types the listener's controller as `TabCloseController`, while `emit` (`:2365`)
   and `onFloatBeforeClose` (`:1730`) pass a `WindowCloseController` for a window
   chrome ✕. The two shapes are identical, so it compiles and works. A fix would type
   the parameter as `TabCloseController | WindowCloseController` (or a shared
   `CloseController`). Also note that a listener cannot tell a tab ✕ from a window ✕
   from the payload (`window` names the float in both cases); SQLAdmin does not need
   to, because it groups one gesture's events by synchronous turn.
9. **Run the full checks** in `## Verification`, then the manual pass.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/controller/closeRequestBatcher.ts` |
| Create | `frontend/tests/controller/closeRequestBatcher.test.ts` |
| Modify | `frontend/src/controller/controllerText.ts` |
| Modify | `frontend/tests/controller/controllerText.test.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/dock/DocumentationPanel.ts` (comment only) |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

### `CloseRequestBatcher` (unit-testable)

"Flush" means calling the function the injected scheduler captured.

- **B1** — `add("a", false, v)`, flush → `v.preventDefault` not called; `onVetoed` not called.
- **B2** — `add("a", true, v)` → `v.preventDefault` called once **before** any flush; `onVetoed` not called yet. After flush → `onVetoed` called once with `{ ids: ["a"], dirtyCount: 1 }`.
- **B3** (window ✕, one dirty) — `add("a", false, w)`, `add("b", true, w)`, `add("c", false, w)`, flush → one call, `{ ids: ["a", "b", "c"], dirtyCount: 1 }`.
- **B4** (window ✕, all dirty) — three `add(…, true, w)` with the same `w`, flush → exactly one `onVetoed` call, `{ ids: ["a", "b", "c"], dirtyCount: 3 }`.
- **B5** (window ✕, all clean) — three `add(…, false, w)`, flush → no `preventDefault`, no `onVetoed`.
- **B6** (bulk close) — `add("a", false, v1)`, `add("b", true, v2)`, `add("c", true, v3)`, flush → `v1.preventDefault` not called; one call `{ ids: ["b", "c"], dirtyCount: 2 }`.
- **B7** — the scheduler is called exactly once for the three `add` calls of B3.
- **B8** (separate gestures) — `add("a", true, v1)`, flush, `add("b", true, v2)`, flush → two `onVetoed` calls, `{ ids: ["a"], … }` then `{ ids: ["b"], … }`; the scheduler was called twice.
- **B9** (re-entry) — an `onVetoed` callback that itself calls `add("z", true, v9)` starts a new batch: the scheduler is called again, and the next flush reports only `["z"]`.

### `closeGuardPrompt` (unit-testable)

- **P1** — `(1, 1)` → `Close tab` / `This tab has unsaved changes. Are you sure that you want to close it?`
- **P2** — `(3, 3)` → `Close tabs` / `3 tabs have unsaved changes. Are you sure that you want to close them?`
- **P3** — `(3, 1)` → `Close tabs` / `1 of the 3 tabs being closed has unsaved changes. Are you sure that you want to close them?`
- **P4** — `(4, 2)` → `Close tabs` / `2 of the 4 tabs being closed have unsaved changes. Are you sure that you want to close them?`
- **P5** — `(2, 2)` → `Close tabs` / `2 tabs have unsaved changes. Are you sure that you want to close them?`

### In the running app (manual only — Dock, drag, and dialogs are not exercised by the node vitest)

An easy dirty tab is a scratch query tab with any typed SQL; a table data tab with an
edited, unsaved cell is another.

- **M1** Tiled tab ✕, dirty → one `Close tab` prompt. No → tab stays. Yes → tab closes.
- **M2** Tiled tab ✕, clean → closes with no prompt.
- **M3** Float tab ✕ (tear a dirty tab into a float window, click its tab ✕) → same as M1; on Yes the emptied float closes too, with no second prompt.
- **M4** Float chrome ✕, float holds 0 dirty tabs (drag two clean tabs into one float) → window closes, no prompt.
- **M5** Float chrome ✕, 1 dirty of 2 tabs → one prompt `1 of the 2 tabs being closed has unsaved changes…`. No → window and both tabs stay. Yes → window and both tabs close.
- **M6** Float chrome ✕, 2 dirty of 2 → one prompt `2 tabs have unsaved changes…` (not two prompts). Yes closes both and the window.
- **M7** Float chrome ✕, float holds one dirty tab → one `Close tab` prompt; Yes closes the tab and the window.
- **M8** Tab context menu *Close all* over 1 clean + 2 dirty tiled tabs → the clean tab closes at once; one prompt `2 tabs have unsaved changes…`; Yes closes both.
- **M9** New regions: split the dock by dragging a tab to an edge, then ✕ a dirty tab in the new region → M1 behaviour. Re-dock a dirty tab from a float into the tiled tree, then ✕ it → M1 behaviour. These are the regions the old `"attach"`/`"move"` wiring existed to find.
- **M10** Layout restore: SQLAdmin never calls `Dock.setLayoutState` (`grep -rn "setLayoutState\|getLayoutState" frontend/src` → zero matches), so there is no in-app Dock restore to exercise. Reload the page instead (which restores `LayoutStore`'s split sizes), open two tabs, make one dirty, and repeat M1 and M6 — both must still prompt.
- **M11** `beforeunload` still works: with a dirty tab open (tiled, then floated), reload the page → the browser's leave-page prompt appears.

---

## Verification

Run in the worktree's `frontend/`:

- `npm run typecheck` — clean.
- `npm test` — all green, including the new `closeRequestBatcher.test.ts` and the `closeGuardPrompt` block.
- `grep -rn "beforetabclose\|wireBeforeTabClose\|wiredTabRegions" frontend/src` — zero matches.
- `grep -n "typescript-ui" frontend/src/controller/closeRequestBatcher.ts` — zero matches.
- Manual pass M1-M11 via the `verify` skill (sign in per memory "sqladmin login when driving app"). Confirm the served library chunk comes from the symlinked 0.10.0 build (memory "Verify symlink must target worktree" — here the symlink targets the library checkout, which must contain the `"beforeclose"` Dock code).

---

## Potential Challenges

- **Double prompts during the transition** — if the old `"beforetabclose"` wiring is left in place, a tab ✕ prompts twice; step 6's grep checks catch it.
- **The 0.10.0 build not present in `dist/lib`** — the `"beforeclose"` overload will be missing and typecheck fails on the `dock.on` call; rebuild the library with `npm run clean && npm run build:lib` in the library repo (memories "sqladmin consumes built dist/lib", "Clean before tsui release build").
- **A panel closes or moves while the dialog is open** — `Dialog.confirm` is modal, so the user cannot do this; if it happens programmatically, `removePanel` returns `false` for an unknown id and the loop moves on.
- **`queueMicrotask` in the node test environment** — it exists in Node, but the tests inject a manual scheduler anyway so flush timing is explicit.

---

## Critical Files

- `frontend/src/SqlAdminController.ts` — the current guard (272-313), the `_openContents`/`hasUnsavedWork()` pair (171, 219-238, 668-676) that must stay intact.
- `frontend/src/controller/controllerText.ts` and `frontend/tests/controller/controllerText.test.ts` — the pure-module precedent and where the prompt text goes.
- `frontend/COMPONENT_CONVENTIONS.md` §(c) — arrow fields for callbacks passed by reference.
- `plans/implemented/app-wide-unsaved-changes-guard.md` — the guard's original design (veto, confirm, `removePanel`).
- `../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts` — `onPanelBeforeClose` (1710), `onFloatBeforeClose` (1730), `removePanel` (1914), `on("beforeclose")` (2275).
- `../typescript-ui/packages/lib/src/typescript/lib/overlay/AbstractWindow.ts` — `requestClose` (959).
- `../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts` — `_onBarTabClose` (1137), `closeHostWindowIfEmpty` (2601).
- `../typescript-ui/packages/lib/src/typescript/lib/component/container/TabBar.ts` — `bulkCloseItem` (2169).

---

## Non-Goals

- **Dirty dots on tabs (`Dock.setPanelModified`)** — a later plan. This plan keeps dirtiness read live from `e.content.isDirty()` in one place and adds no per-panel dirty state, so that plan can add its own listener without touching the close guard.
- **The general 0.10.0 upgrade and the dependency-range bump** — `typescript-ui-0-10-0-upgrade.md` owns it; no version bump here.
- **Changing `hasUnsavedWork()` or the `beforeunload` guard** — they already cover floats.
- **Fixing the `beforeclose` controller typing in the library** — logged in `LIBRARY_NOTES.md` only; it causes no defect.
- **Naming the dirty tabs in the prompt** — the counts are enough for this change.

---

## Notes

[^why-dock-level]: The per-region wiring could never see a window's chrome ✕: that
    close goes through `AbstractWindow.requestClose()`
    (`AbstractWindow.ts:959-973`), not through any `Tab`, so no `"beforetabclose"`
    fires. In 0.9.0 a bare `Window`'s header ✕ even skipped `requestClose` and called
    `onExitAction()` directly (0.10.0 changelog, *Fixed → Overlay*). The Dock now
    subscribes to every float's `"beforeclose"` and every region's
    `"beforetabclose"` itself (`Dock.ts:1111-1134`, `:1377`) and re-emits both as its
    own `"beforeclose"`. It also re-wires a restored root region correctly (0.10.0
    changelog, "A `setLayoutState` restore no longer permanently drops a tiled root
    region's tab wiring"), which the app's `WeakSet` approach could not have noticed.
    Keeping both subscriptions would prompt twice for every tab ✕.

[^turn-is-exact]: A vetoable event must deliver every veto before its emitter checks
    the result, and both emitters check synchronously right after `emit` returns:
    `AbstractWindow.requestClose()` reads its local `prevented` flag on the next line
    (`AbstractWindow.ts:959-973`), and so does `Tab._onBarTabClose` (`Tab.ts:1137-1155`).
    Dock's `onFloatBeforeClose` loops over the window's frames inside that same call
    (`Dock.ts:1730-1734`). So all events of one window close are guaranteed to arrive
    in one synchronous turn, and a microtask queued by the first one is guaranteed to
    run after the last. Two separate user gestures are always separate browser tasks,
    so they can never share a turn. Programmatic `removePanel` never emits
    `"beforeclose"`, so it cannot join a batch either.

[^bulk-close]: `TabBar.bulkCloseItem` loops its target ids and emits `"tabclose"` for
    each inside one menu action (`TabBar.ts:2169-2187`); each emit reaches
    `Tab._onBarTabClose`, which builds a fresh controller per tab. Grouping by
    controller object would therefore give *Close all* one prompt per dirty tab (the
    current behaviour), while grouping by turn gives one. The user asked for one
    prompt per window close; the same rule applied to the menu rows is the consistent
    extension and costs nothing extra.

[^flush-time]: A per-event decision would drop tab A in the table's first row: when A's
    event arrives, controller W has not been vetoed yet. Only after B's event does W
    become vetoed, which means the whole window — A included — stayed open and must be
    closed on "yes". Evaluating membership once, at flush, handles every row in the
    table with one rule.

[^remove-closes-window]: `dock.removePanel(id)` goes through `Tab.closeTab` →
    `closeEntry` (`Dock.ts:1914-1930`, `Tab.ts:1170-1226`). `closeEntry` emits
    `"tabclose"` first — the Dock's `onPanelClosed` then deletes the frame from its
    registry (`Dock.ts:1580-1604`) — and only afterwards calls
    `closeHostWindowIfEmpty()` (`Tab.ts:1222`, `:2601-2607`), which calls
    `requestClose()`. The Dock's `onFloatBeforeClose` then finds no registered frames
    in that window and emits nothing, so the window closes through `onExitAction()`.
    A bare-`Window` float closes the same way through `closeFloatIfEmpty`
    (`Dock.ts:1435-1443`). Calling the float's own close instead was rejected: the
    Dock payload cannot tell a tab ✕ in a float from the window's chrome ✕ (both carry
    the float as `window`), so closing the window after a single tab ✕ would wrongly
    close its other tabs. Closing exactly the vetoed ids is correct for both.

[^single-tab-window]: A float's chrome ✕ over a single dirty tab produces a batch of
    one and gets the `Close tab` text. That is accurate: the result (the tab closes,
    and the emptied float closes with it) is the same as clicking that tab's ✕, and
    the listener cannot tell the two gestures apart anyway (see the
    `remove-closes-window` note). The `D of the N tabs being closed` form appears only
    for a window ✕ with some clean tabs, since in a bulk close the clean tabs have
    already closed and every vetoed tab is dirty.

[^pure-module]: `frontend/vitest.config.ts` runs tests in the node environment with no
    DOM, and library UI modules touch `document` at import time (memory "tsui DOM
    module side effects"). The whole controller therefore cannot be unit-tested, but a
    pure batcher can. Injecting the scheduler (defaulting to `queueMicrotask`) lets the
    tests decide exactly when a flush happens. `closeGuardPrompt` goes in
    `controllerText.ts` rather than the batcher module because that file already
    holds the controller's user-facing strings.

[^no-library-change]: Two library changes were considered and rejected. (1) A single
    aggregated Dock event per close request, carrying every affected panel: it would
    split `"beforeclose"` into two shapes (per-panel for tab ✕, per-window for chrome ✕),
    and still would not group the `TabBar` bulk-close rows, which are N independent
    `Tab` closes. (2) A `source: "tab" | "window"` field on the payload: SQLAdmin's
    design does not need it (see the `remove-closes-window` note). The project rule
    "fix in library, not workaround" applies to defects; grouping several close events
    into one prompt is app policy built on the library's documented guarantees, not a
    workaround for a defect.

---

## Implementation Notes

### Deviation: the batcher calls its scheduler through a local

`## Implementation` has `add()` call `this._schedule(this.flush)`. With the default
scheduler that invokes the browser's `queueMicrotask` as a method of the batcher, and
Chrome throws `TypeError: Illegal invocation`: the first live tab ✕ vetoed the close
but never showed a prompt. Node's `queueMicrotask` does not check its receiver, so
B1-B9 (which inject a manual scheduler) could not catch it. `add()` now copies
`this._schedule` into a local and calls that, so it runs unbound. An extra test in
`closeRequestBatcher.test.ts`, *CloseRequestBatcher default scheduler*, stubs
`queueMicrotask` with a browser-like receiver check. It was written first, failed
with `Illegal invocation`, and passes after the fix.

### Shared file kept minimal

`controllerText.ts` gets only the new `CloseGuardPrompt`/`closeGuardPrompt` block after
`tableExportFilename`. Its header comment, which lists what the module holds, was left
as it was, to keep the diff to this `touches-shared` file small.

### Manual verification

Driven through the real UI in Chrome (chrome-devtools MCP), with the backend and Vite
running from this worktree, signed in to the local Postgres (`localhost`, `sqladmin`).
The served library chunks came from
`/home/jika/typescript/typescript-ui/packages/lib/dist/lib` (0.10.0), whose
`overlay.es.js` contains `onFloatBeforeClose`. Dirty tabs were scratch query tabs with
typed SQL. Tabs were torn into floats and merged by dragging a tab. Every ✕,
window-control ✕, menu row, Cancel and Confirm was a real click. `evaluate_script` was
used only to read tab and float state, to open the tab context menu (right-click
dispatch), and once to click a tab ✕ during the first M1 attempt; M1 was then
repeated with a real click.

- **M1** — tiled dirty tab ✕ → `Close tab` prompt; Cancel kept it, Confirm closed it.
- **M2** — tiled clean tab ✕ → closed, no prompt.
- **M3** — dirty tab alone in a float, its own ✕ → `Close tab`; Confirm closed the tab
  and the emptied float with no second prompt.
- **M4** — float holding two clean tabs, chrome ✕ → window and both tabs closed, no prompt.
- **M5** — float with one dirty and one clean tab, chrome ✕ → one prompt
  `1 of the 2 tabs being closed has unsaved changes…`; Cancel kept both, Confirm closed
  both and the window.
- **M6** — float with two dirty tabs, chrome ✕ → exactly one prompt
  `2 tabs have unsaved changes…`; Confirm closed both and the window.
- **M7** — float holding one dirty tab, chrome ✕ → `Close tab`; Cancel kept it, Confirm
  closed the tab and the window.
- **M8** — context menu *Close all* over two dirty tabs and one clean tab → the clean
  tab closed at once, one prompt `2 tabs have unsaved changes…`; Confirm closed both.
- **M9** — a dirty tab in a new tiled region (a drag split the dock) → `Close tab`
  prompt. A dirty tab dragged from a float back into the tiled strip → `Close tab`
  prompt; Confirm closed it.
- **M10** — after a page reload: a dirty tiled tab ✕ prompted (M1), and a float with
  two dirty tabs prompted once (M6); Confirm closed both.
- **M11** — reload with a dirty tiled tab showed the browser's `beforeunload` dialog.
  So did a reload where the only dirty tab sat in a float; that dialog was dismissed
  and the page stayed.

After the fix, the console showed no errors or warnings.
