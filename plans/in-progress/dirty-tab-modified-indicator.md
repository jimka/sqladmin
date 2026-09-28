---
depends-on: [typescript-ui-0-10-0-upgrade, dock-beforeclose-unsaved-guard]
touches-shared: [frontend/src/SqlAdminController.ts, LIBRARY_NOTES.md]
---

# Dirty-Tab Modified Indicator — Implementation Plan

## Overview

A work-area tab with unsaved changes looks exactly like a clean one today. The only
signal is the close prompt, which appears after the user has already clicked ✕.
typescript-ui 0.10.0 adds `Dock.setPanelModified(id, modified)`
([`Dock.ts:1994-1998`](../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts#L1994)),
which shows or hides a small "unsaved changes" dot on a panel's tab. This plan keeps
that dot in step with each open tab's `isDirty()`, so a tab shows the dot exactly when
the close guard would prompt for it.

The wiring lives in the `SqlAdminController` constructor
([`frontend/src/SqlAdminController.ts:220-238`](frontend/src/SqlAdminController.ts#L220)),
inside the existing Dock `"attach"` and `"close"` listeners that feed `_openContents`.
The subscription bookkeeping moves into a new pure module,
`frontend/src/controller/dirtyTabMarker.ts`, so it can be unit-tested under the node
vitest. No panel class changes. Every tab's content is a Dock *identity frame* — the
Dock-owned wrapper component around the panel, carrying the panel id as its own id —
and its `isDirty()`/`onDirtyChange()` already fold in every dirty source below it.

This plan builds on `dock-beforeclose-unsaved-guard.md`. That plan rewrites the close
guard further down the same constructor and adds `_closeBatcher` next to
`_openContents`. This plan edits different lines (the `"close"` and `"attach"`
listeners and one new field), so the two do not conflict. Line numbers below are from
`main` before either plan lands; find each site by its content.

---

## Architecture Decisions

### Subscribe once per identity frame, from the existing `"attach"` listener, and re-sync on every attach

The controller's existing `dock.on("attach", …)` listener calls
`this._dirtyTabs.track(e.content)` right after `this._openContents.add(e.content)`.
`track` subscribes to the frame's `onDirtyChange` only the first time it sees that
frame. On every call, first or repeat, it pushes the frame's current `isDirty()` to
`dock.setPanelModified`.[^why-attach]

`"attach"` fires on a panel's first open and again when the panel enters a new host (a
tear-off into a float, a re-dock back into the tiled tree). The first-time check stops
those repeat attaches from adding a second listener. The repeat push costs nothing and
repairs the dot if a move ever lost it.[^resync-on-attach]

The shape — subscribe to `onDirtyChange` and mirror the flag onto a piece of UI — is
the one `DefinitionEditor` already uses for its Save button
([`frontend/src/dock/definitionEditor.ts:103-104`](frontend/src/dock/definitionEditor.ts#L103):
`this.editor.onDirtyChange(() => this.syncDirty()); this.syncDirty();`). The
"discover every tab through Dock events on the identity frame" part follows the
`_openContents`/`hasUnsavedWork()` wiring set up by
`plans/implemented/app-wide-unsaved-changes-guard.md`.

### Unsubscribe on the Dock's `"close"` event

The existing `dock.on("close", …)` listener calls `this._dirtyTabs.untrack(e.content)`
next to `this._openContents.delete(e.content)`. `untrack` calls `offDirtyChange` with
the same listener reference `track` registered, and forgets the frame.
`onDirtyChange` returns the component (for chaining), not a disposer, so the marker
keeps each listener in a `Map` keyed by frame in order to remove it later.[^why-untrack]

`"close"` fires only when a panel is really destroyed, never for a tear-off. A reopened
panel gets a brand-new identity frame, so it is tracked afresh on its next `"attach"`.

### The bookkeeping is a pure module with no library import

`DirtyTabMarker` lives in `frontend/src/controller/dirtyTabMarker.ts`. It types the
frame by a small structural interface, `DirtySource` (`getId`, `isDirty`,
`onDirtyChange`, `offDirtyChange`), which a library `Component` already satisfies. The
controller hands it a callback that calls `this.dock.setPanelModified`. This mirrors
`controllerText.ts` ("kept free of library imports so the node vitest can load it",
[`controllerText.ts:1-5`](frontend/src/controller/controllerText.ts#L1)) and the
sibling plan's `closeRequestBatcher.ts`.[^pure-module] The callback is an arrow-function
field, because it is passed by reference (`frontend/COMPONENT_CONVENTIONS.md` §(c)).

### The panel id is read once, when a frame is first tracked

A Dock panel id never changes while its frame lives (`DockPanelEvent.id` is "the stable
id of the panel"). The app never renames a panel in place: a table or schema rename
closes the object's tabs with `closeTabsFor` and a later open builds a new frame under
the new id ([`ddlLaunchers.ts:193-203`](frontend/src/controller/ddlLaunchers.ts#L193)).
So `track` reads `source.getId()` once and each listener closes over that id.

### Tear-off, re-dock and layout restore need no extra app code

`setPanelModified` writes the flag to the tab's `LayoutConstraints`, not only to the
live tab button. Those constraints travel with the frame whenever the library moves it
(`Component.moveComponent` carries them), and a new tab button reads them when it is
built. So the dot follows a tab into a float, back into the tiled tree, and into a new
split region by itself.[^durable] The layout serializer also saves the flag, so a
`Dock.setLayoutState` restore keeps it. SQLAdmin never calls `setLayoutState` or
`getLayoutState` today, so no restore path exists to test.

### The library draws the dot; the app adds no styling

The dot is the library's `circle` glyph, pinned over the upper-left corner of the tab's
leading glyph, in `var(--ts-ui-tab-indicator-color, #1a73e8)`
([`TabButton.ts:470-500`](../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts#L470)).
The app uses that default as-is: no CSS, no colour, no size (memory "Prefer library
defaults"). The dot shows only on a tab that has a leading glyph
([`TabButton.ts:546-556`](../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts#L546)).
Every SQLAdmin tab has one: `AsyncPanelSpec.glyph` is required
([`panelHost.ts:56`](frontend/src/controller/panelHost.ts#L56)), and all three direct
`addPanel` calls pass a glyph.

### Only existing dirty sources are shown; `QueryPanel`'s meaning is unchanged

The dot reflects `isDirty()` and adds no dirty state of its own. A scratch query tab
already reports dirty as soon as its SQL differs from the text it opened with, and
clean again if the text goes back to that. "Save…" stores a copy and does not mark the
tab clean. That is the meaning the close guard already uses, so the dot follows it
unchanged.[^query-dirty]

### One library defect is logged; the app adds no workaround

The corner badge over the leading glyph is the library's intended design.[^badge-intended]
Three things around it are wrong in the library:

- **A tab with no glyph shows no dot.** `TabButton.ts:554` computes
  `shown = this._modified && glyph !== null`, so a glyph-less tab marked modified
  shows nothing. This is a code defect; the library's own `TabDemoPanel` reproduces it.
- **The modified state has no accessible exposure.** The dot is visual only: no ARIA
  attribute, no label text. A screen-reader user gets no cue that a tab is dirty.
- **The docs describe the old placement.** They still say the dot trails the label.

A `LIBRARY_NOTES.md` entry records all three and recommends a 0.10.x patch release:
a trailing-dot fallback for glyph-less tabs, an accessible cue, and the doc
corrections. SQLAdmin's dot renders correctly, because every tab has a glyph. Until
the patch ships, SQLAdmin's dirty tabs have no screen-reader cue. The app adds no
workaround (memory "Fix in library, not workaround").

---

## Public API

New module `frontend/src/controller/dirtyTabMarker.ts`:

```ts
/**
 * The part of a Dock identity frame the marker reads. A library Component
 * satisfies it structurally, so this module needs no library import.
 */
export interface DirtySource {
    getId(): string;
    isDirty(): boolean;
    onDirtyChange(listener: (dirty: boolean) => void): unknown;
    offDirtyChange(listener: (dirty: boolean) => void): unknown;
}

/** Shows (true) or hides (false) the modified dot on panel `id`'s tab. */
export type SetPanelModified = (id: string, modified: boolean) => void;

export class DirtyTabMarker {
    /**
     * @param setModified - Called with a panel id and its dirty state whenever
     *   the dot must change.
     */
    constructor(setModified: SetPanelModified);

    /**
     * Start mirroring `source`'s dirty state onto its tab. Subscribes only the
     * first time a given source is seen; every call pushes the current state.
     *
     * @param source - The panel's Dock identity frame.
     */
    track(source: DirtySource): void;

    /**
     * Stop mirroring `source`: removes the listener `track` added. A no-op for
     * a source that is not tracked. Does not call `setModified` — the tab is
     * being destroyed.
     *
     * @param source - The panel's Dock identity frame.
     */
    untrack(source: DirtySource): void;
}
```

`SqlAdminController`'s public surface is unchanged.

---

## Implementation

`dirtyTabMarker.ts` body:

```ts
export class DirtyTabMarker {
    private readonly _setModified: SetPanelModified;
    // The dirty-change listener registered on each tracked frame, kept so
    // untrack() can pass the same reference to offDirtyChange.
    private readonly _listeners = new Map<DirtySource, (dirty: boolean) => void>();

    constructor(setModified: SetPanelModified) {
        this._setModified = setModified;
    }

    track(source: DirtySource): void {
        const id = source.getId();

        if (!this._listeners.has(source)) {
            const listener = (dirty: boolean): void => {
                this._setModified(id, dirty);
            };

            this._listeners.set(source, listener);
            source.onDirtyChange(listener);
        }

        this._setModified(id, source.isDirty());
    }

    untrack(source: DirtySource): void {
        const listener = this._listeners.get(source);

        if (!listener) {
            return;
        }

        source.offDirtyChange(listener);
        this._listeners.delete(source);
    }
}
```

Controller changes (`frontend/src/SqlAdminController.ts`):

```ts
// New field, directly below _openContents (and below the sibling plan's
// _closeBatcher once that has landed):

// Mirrors each open tab's isDirty() onto its tab's modified dot — see the
// "attach"/"close" subscriptions in the constructor.
private readonly _dirtyTabs: DirtyTabMarker;

/**
 * Show or hide panel `id`'s unsaved-changes dot. The result is ignored: it is
 * false only for an id the Dock no longer knows, and then there is no tab to
 * mark. Arrow field: handed to DirtyTabMarker by reference.
 *
 * @param id - The panel's Dock id.
 * @param modified - Whether the panel has unsaved changes.
 */
private markPanelModified = (id: string, modified: boolean): void => {
    this.dock.setPanelModified(id, modified);
};
```

In the constructor, directly above the `this.dock.on("close", …)` block:

```ts
this._dirtyTabs = new DirtyTabMarker(this.markPanelModified);
```

The two listeners after the change:

```ts
this.dock.on("close", (e: DockPanelEvent) => {
    this.disposePanel(e.id);
    this._activeQueryResult.delete(e.id);
    this._activeRoleGrants.delete(e.id);
    this._panelRoutes.delete(e.id);
    this._queryPanelRuns.delete(e.id);
    this._openContents.delete(e.content);
    this._dirtyTabs.untrack(e.content);
});

// ...existing comment, extended with one sentence (step 5)...
this.dock.on("attach", (e: DockPanelEvent) => {
    this._openContents.add(e.content);
    this._dirtyTabs.track(e.content);
});
```

`SqlAdminController` extends nothing, so `markPanelModified` is already set when the
constructor body runs. `this.dock` is assigned before the new line, and the callback
reads it only when called.

---

## Ordered Implementation Steps

1. **Worktree setup.** Symlink the main tree's `frontend/node_modules` into the
   worktree's `frontend/` (memory "Worktree node_modules symlink"). Confirm
   `readlink -f frontend/node_modules/@jimka/typescript-ui` →
   `/home/jika/typescript/typescript-ui/packages/lib`, and
   `grep -n setPanelModified frontend/node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dock.d.ts`
   → one match. Confirm `grep -n "_closeBatcher\|beforeclose" frontend/src/SqlAdminController.ts`
   finds the sibling plan's code (it is a dependency). Do not change `package.json`.
2. **Write the marker tests first.** Create
   `frontend/tests/controller/dirtyTabMarker.test.ts` covering D1-D9 in
   `## Expected Behaviour`. Use a fake source:
   ```ts
   function fakeSource(id: string, dirty = false) {
       const listeners = new Set<(d: boolean) => void>();
       let state = dirty;

       return {
           getId         : () => id,
           isDirty       : () => state,
           onDirtyChange : vi.fn((l: (d: boolean) => void) => { listeners.add(l); }),
           offDirtyChange: vi.fn((l: (d: boolean) => void) => { listeners.delete(l); }),
           flip(d: boolean): void { state = d; listeners.forEach(l => l(d)); },
       };
   }
   ```
   and `const setModified = vi.fn();`. Run `npm test` in `frontend/` — expect failures
   (module missing).
3. **Create `frontend/src/controller/dirtyTabMarker.ts`** per `## Public API` and
   `## Implementation`, with JSDoc on every member. Start it with a header comment in
   the style of `controllerText.ts:1-5`: it mirrors each open Dock tab's `isDirty()`
   onto `Dock.setPanelModified`, and it has no library imports so the node vitest can
   load it. Checks: `grep -n typescript-ui frontend/src/controller/dirtyTabMarker.ts`
   → zero matches; `npm test` → D1-D9 pass.
4. **Add the field and callback to `frontend/src/SqlAdminController.ts`.**
   - Add `import { DirtyTabMarker } from "./controller/dirtyTabMarker";` after the
     `RoleActions` import (line 53).
   - Add the `_dirtyTabs` field with its comment below `_openContents` (line 171; below
     `_closeBatcher` if the sibling put it there), and the `markPanelModified` arrow
     field with its JSDoc next to the sibling's `confirmVetoedClose`.
   - Add `this._dirtyTabs = new DirtyTabMarker(this.markPanelModified);` directly
     above `this.dock.on("close", …)` (line 220).
5. **Wire the two listeners** as in `## Implementation`:
   - `"close"` (lines 220-227): add `this._dirtyTabs.untrack(e.content);` after
     `this._openContents.delete(e.content);`. Extend the comment above it (lines
     215-219) to end: "…so it can't be exported, and stops mirroring its dirty state
     onto the tab."
   - `"attach"` (lines 236-238): add `this._dirtyTabs.track(e.content);` after
     `this._openContents.add(e.content);`. Append to the comment above it (lines
     229-235): "The same first-appearance hook starts mirroring the content's
     isDirty() onto its tab's modified dot (DirtyTabMarker subscribes once per frame
     and re-syncs the dot on every attach)."
   - Checks: `grep -c 'dock.on("attach"' frontend/src/SqlAdminController.ts` → `1`;
     `grep -n "_dirtyTabs" frontend/src/SqlAdminController.ts` → 4 matches (field,
     construction, `track`, `untrack`); `npm run typecheck` → clean.
6. **Add a `LIBRARY_NOTES.md` entry** at the top (newest first), titled
   `` ## 🐞🔎 Tab modified dot: glyph-less tabs show nothing, no accessible cue, docs describe the old placement (0.10.0) ``.
   Say, with paths under `typescript-ui/packages/lib`:
   - **Design is fine.** The dot is a badge over the leading glyph's upper-left
     corner (`TabButton.setModified`, `TabButton.ts:470`). typescript-ui commit
     `df98c1f6` moved it there from trailing the label on purpose.
   - **Code defect.** `positionModifiedBadge` computes
     `shown = this._modified && glyph !== null` (`TabButton.ts:554`), so a tab with
     no glyph marked modified shows no dot at all. The library's `TabDemoPanel`
     reproduces it.
   - **Accessibility gap.** The modified state has no ARIA or other accessible
     exposure, so assistive technology cannot tell a dirty tab from a clean one.
   - **Wrong docs.** These still describe the old trailing-the-label placement:
     `docs/reference/changelog/0.10.0.md:599-603`, `docs/components/TabButton.md:26-37`,
     `docs/layouts/Tab.md:107`, `docs/components/TabBar.md:64`, and the comment at
     `TabButton.ts:21`.
   - **Recommended fix, as a 0.10.x patch:** a trailing-dot fallback for glyph-less
     tabs, an accessible cue for the modified state, and the doc corrections above.
   - **SQLAdmin impact.** The dot renders (every tab has a glyph), but dirty tabs get
     no screen-reader cue until the patch ships. No app workaround.
7. **Run the checks** in `## Verification`, then the manual pass M1-M12.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/controller/dirtyTabMarker.ts` |
| Create | `frontend/tests/controller/dirtyTabMarker.test.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

### `DirtyTabMarker` (unit-testable)

- **D1** — `track(a)` with `a` clean (id `"a"`) → `setModified` called once with
  `("a", false)`; `a.onDirtyChange` called once.
- **D2** — `track(a)` with `a` dirty → `setModified` called once with `("a", true)`.
- **D3** — after `track(a)` (clean): `a.flip(true)` → `setModified` last called with
  `("a", true)`; then `a.flip(false)` → last called with `("a", false)`.
- **D4** (repeat attach) — `track(a)` twice → `a.onDirtyChange` called exactly once;
  `setModified` called twice, each time with `a`'s current state. A later
  `a.flip(true)` adds exactly **one** `setModified` call.
- **D5** — `track(a)`, then `untrack(a)` → `a.offDirtyChange` called once, with the
  same function `a.onDirtyChange` received. A later `a.flip(true)` adds no
  `setModified` call.
- **D6** — `untrack(a)` for a never-tracked `a` → no `offDirtyChange` call, no
  `setModified` call, no throw.
- **D7** — `untrack(a)` does not call `setModified`.
- **D8** — `track(a)`, `untrack(a)`, `track(a)` → `a.onDirtyChange` called twice in
  total; after the second `track`, `a.flip(true)` produces one `setModified("a", true)`.
- **D9** (independence) — `track(a)`, `track(b)`; `b.flip(true)` → the only new
  `setModified` call is `("b", true)`.

### In the running app (manual only — Dock, drag, and rendering are not exercised by the node vitest)

"The dot" is the small blue dot on the upper-left corner of the tab's glyph.

- **M1 Query tab** — open a scratch query tab: no dot. Type `select 1` → dot appears.
  Delete the text back to empty → dot disappears. Type again → dot returns.
- **M2 Definition editor** — open a view's definition tab: no dot. Edit → dot. Save
  (confirm in the SQL preview) → dot disappears once the editor reloads. Edit, then undo
  back to the original text → dot disappears.
- **M3 Table data** — open a table's data tab: no dot. Edit a cell → dot. Save → dot
  disappears. Edit again, then Refresh (discarding the edit) → dot disappears.
- **M4 Sequence / structure / DDL form** — edit a field in a sequence info tab → dot;
  Save → gone. Open a *Create table* DDL form tab and type a name → dot.
- **M5 No false dots on open** — open one tab of each kind (table data, structure,
  view definition, function definition, index info, sequence info, type info, role
  grants, Notes, each diagram kind) and use only the view-state controls
  (diagram legend/direction/depth toggles, chart combos, record-view search). None may
  show a dot. Typing in Notes never shows a dot (it autosaves). If a tab shows a dot
  with no real edit, that panel has a dirty-state bug. Record it under the plan's
  implementation notes; do not fix it in this plan.
- **M6 Lazy tab** — while a lazy tab shows its loading spinner, no dot. After it loads,
  M2/M3 behaviour applies.
- **M7 Tear-off (strip float)** — make a tab dirty, drag it out to a float: the dot is
  still shown in the float's tab strip. Undo the edit in the float → dot disappears.
  Edit again → dot appears.
- **M8 Tear-off (bare float)** — Shift-drag a dirty tab out: the float's tab shows the
  dot. Change dirty state inside it → the dot follows.
- **M9 Re-dock and split** — drag a dirty float tab back onto the tiled tab bar → dot
  still shown; make it clean → gone. Drag a dirty tab to a dock edge to split the work
  area → the dot moves with it and keeps following edits.
- **M10 Close and reopen** — close a dirty tab and confirm the prompt → no console
  errors. Reopen the same object → no dot. Close a float by its chrome ✕ holding a dirty
  tab, confirm → no console errors.
- **M11 Agreement with the close guard** — for every tab in M1-M9, clicking ✕ prompts
  exactly when the dot is shown.
- **M12 Layout restore** — `grep -rn "setLayoutState\|getLayoutState" frontend/src` →
  zero matches, so there is no in-app restore to exercise. Reload the page and confirm
  M1 still works.

---

## Verification

Run in the worktree's `frontend/`:

- `npm run typecheck` — clean.
- `npm test` — all green, including `tests/controller/dirtyTabMarker.test.ts`.
- `grep -n "typescript-ui" src/controller/dirtyTabMarker.ts` — zero matches.
- `grep -c 'dock.on("attach"' src/SqlAdminController.ts` — `1`.
- `grep -n "setPanelModified" src/SqlAdminController.ts` — exactly one match (inside `markPanelModified`).
- Manual pass M1-M12 via the `verify` skill (sign in per memory "sqladmin login when
  driving app"). Confirm the served library chunk is the symlinked 0.10.0 build (memory
  "Verify symlink must target worktree").

---

## Potential Challenges

- **The linked build lacks `setPanelModified`** — typecheck fails on
  `this.dock.setPanelModified`. Rebuild the library with
  `npm run clean && npm run build:lib` in the library repo, then restart the Vite dev
  server (memories "sqladmin consumes built dist/lib", "Clean before tsui release
  build", "Vite dep cache stale across rebuilds").
- **A dirty-change arrives after the panel closed** — `setPanelModified` returns
  `false` for an unknown id and does nothing, and `untrack` has already removed the
  listener anyway.
- **Merge overlap with the sibling plan** — both plans add a field next to
  `_openContents` and an arrow field in the same class. Place the new members after the
  sibling's so the diff is append-only.

---

## Critical Files

- `frontend/src/SqlAdminController.ts` — `_openContents` (171), the `"close"` listener
  (215-227), the `"attach"` listener (230-238), `hasUnsavedWork()` (650-676).
- `plans/dock-beforeclose-unsaved-guard.md` — the dependency; its constructor and field
  changes sit next to this plan's.
- `frontend/src/dock/definitionEditor.ts:103-127` — the `onDirtyChange` → UI-mirror
  precedent.
- `frontend/src/controller/controllerText.ts` and `tests/controller/controllerText.test.ts`
  — the pure-module and test precedent.
- `frontend/COMPONENT_CONVENTIONS.md` §(c) — arrow fields for callbacks passed by
  reference.
- `../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts` — `reconcileHosts`
  (1192, source of every `"attach"`), `adoptFloat` (1308), `onPanelClosed` (1580),
  `onFloatClosed` (1777), `setPanelModified` (1994), `ownerTab` (2065).
- `../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts` —
  `applyDurableTabState` (1291), `setTabModified` (1447).
- `../typescript-ui/packages/lib/src/typescript/lib/component/button/TabButton.ts` —
  `setModified` (470), `positionModifiedBadge` (546).
- `../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts` —
  `onDirtyChange`/`offDirtyChange` (2663-2679), `registerListenerBag` (1126).

---

## Non-Goals

- **Changing what counts as dirty** — e.g. marking a query tab clean after "Save…".
  The dot mirrors the existing `isDirty()` meaning, which the close guard shares.
- **Fixing a panel that turns out to report dirty with no real edit** (M5) — each is
  its own fix, recorded and planned separately.
- **Restyling the dot** or adding a label-side marker — the library default is used.
- **Replacing `_openContents` with the marker's map** — `hasUnsavedWork()` keeps its
  own set; merging the two is an unrelated refactor.
- **Version bump or dependency-range change** — owned by `typescript-ui-0-10-0-upgrade`
  and the manual release steps.
- **Fixing the tab-dot defects in the library** (glyph-less tabs, accessible cue,
  docs) — logged in `LIBRARY_NOTES.md` only, as a recommended 0.10.x patch.
- **An app-side accessible cue for dirty tabs** (e.g. an `aria-label` suffix set by
  the controller) — it belongs in the library's tab button (memory "Fix in library,
  not workaround").

---

## Notes

[^why-attach]: `"attach"` is the Dock's single "a panel appeared in a host" signal,
    emitted from `reconcileHosts` (`Dock.ts:1192-1222`) after the frame is placed in a
    `Tab` region, so `setPanelModified` can already find the frame's owning `Tab`
    (`ownerTab`, `Dock.ts:2065`). A Shift-torn bare float is wrapped in a `Tab` region
    by `adoptFloat` (`Dock.ts:1308`) in the same sweep, so it too has an owning `Tab` by
    then. The existing `_openContents` listener already uses this event for the same
    "every open tab" set, so hooking into it keeps one place that discovers tabs.
    Subscribing inside each panel class was rejected: it would need the Dock and the
    panel id inside a dozen panel types, while the identity frame already folds every
    descendant's dirty state (`plans/implemented/app-wide-unsaved-changes-guard.md`).

[^resync-on-attach]: The flag is durable (see the `durable` note), so a re-sync should
    normally be a no-op. It is kept because it is one call per host change and makes the
    dot correct even if some move path ever builds a tab button without the carried
    constraints. `setTabModified` schedules one layout when the tab button exists;
    attaches are rare user gestures, so that cost does not matter.

[^why-untrack]: The listener bag is cleared when the frame is destroyed
    (`registerListenerBag` adds `onDestroy(() => bag.clear())`, `Component.ts:1126-1130`),
    so a missed `offDirtyChange` would not keep the frame alive by itself. But the
    marker's own `Map` holds a strong reference to every tracked frame, so without
    `untrack` each closed tab's frame would stay reachable from the controller for the
    whole session — the same "detached but never released" shape as the diagram legend
    leak fixed earlier. `"close"` is emitted before the frame is torn down, for a tab ✕
    (`onPanelClosed`, `Dock.ts:1580-1593`) and a float chrome ✕ (`onFloatClosed`,
    `Dock.ts:1777-1787`) alike, so the listener is gone before destruction can fire a
    last dirty change.

[^pure-module]: `frontend/vitest.config.ts` runs tests in node with no DOM. The
    controller constructs library components, so it cannot be unit-tested there, but
    the track/untrack rules can. A structural `DirtySource` also lets the tests drive
    dirty flips with a plain object instead of a real `Component`.

[^durable]: `Dock.setPanelModified` → `Tab.setTabModified` → `applyDurableTabState`
    (`Tab.ts:1291-1317`) writes `constraints.modified` and, if the tab button exists,
    updates it live. A tear-off moves the frame with `moveComponent`, which re-inserts
    it under the constraints it carried from the old parent (`Component.ts:7617-7635`).
    `TabBar.createBarEntry` then applies `constraints.modified` to the new button
    (`TabBar.ts:1873-1875`). `LayoutSerialization.ts:330` and `:540` save and restore
    the same field for `getLayoutState`/`setLayoutState`. This matches the 0.10.0
    changelog's `Dock` and `Tab.setTabModified` entries.

[^badge-intended]: typescript-ui commit `df98c1f6` moved the dot from trailing the
    label to a badge over the glyph's corner on purpose, so the placement SQLAdmin gets
    is the current design, not a regression. The changelog, component pages and the
    `TabButton.ts:21` comment were not updated with that move.

[^query-dirty]: `QueryPanel` builds its editor as `new CodeEditor(initialSql, …)`
    (`QueryPanel.ts:245`), so the opening text is the clean baseline, and `CodeEditor`
    sets dirty as `value !== this._cleanValue` on every change (`CodeEditor.ts:1524`).
    `app-wide-unsaved-changes-guard.md` decided that a query tab has no server-side
    copy, so "Save…" (which writes a named copy) does not mark it clean. Changing that
    would change the close prompt too, so it belongs in its own plan.
