---
depends-on: [menu-anchored-placement]
touches-shared: []
---

# MenuButton Adoption for the Dock's Button-Triggered Menus — Implementation Plan

## Overview

Four of sqladmin's dock toolbars open a `Menu` from a **left-click button** but anchor it to the **pointer** — `menu.show(event.clientX, event.clientY, …)`. The menu lands under the cursor, overlapping the button's own borders, and the library's `show()` path clamps-but-never-flips, so a trigger near the viewport bottom would slide its menu *up over itself*. These read as acceptable today only because three of the four sit in toolbars pinned near the top of the viewport, where the clamp never fires. The fourth — the Structure accordion's section header tools — genuinely can reach the bottom edge (see *Architecture Decisions → The one site where the flip is observable*).

This plan migrates those four to the library's `MenuButton`, which anchors to the **button's rect** and flips above it when the room below is short. The four sites:

- [`frontend/src/dock/exportButton.ts:34`](frontend/src/dock/exportButton.ts#L34) — `buildExportButton`, the shared CSV/JSON chooser used by [`TableWorkPanel.ts:90`](frontend/src/dock/TableWorkPanel.ts#L90) and [`RoleGrantsPanel.ts:70`](frontend/src/dock/RoleGrantsPanel.ts#L70).
- [`frontend/src/dock/StructurePanel.ts:231`](frontend/src/dock/StructurePanel.ts#L231) — the Alter-column menu.
- [`frontend/src/dock/StructurePanel.ts:301`](frontend/src/dock/StructurePanel.ts#L301) — the Add-constraint menu.
- [`frontend/src/dock/QueryPanel.ts:274`](frontend/src/dock/QueryPanel.ts#L274) — the query-result Export menu.

**⚠️ CROSS-REPO HARD DEPENDENCY.** `MenuButton` does not exist yet. It is specified by an already-written plan in a **different repository**: `/home/jika/typescript/typescript-ui/plans/menu-anchored-placement.md`. That plan adds `MenuButton` at `~/component/button/MenuButton.ts`, changes `Menu.toggleFor` to take a `Rect` **and to open nothing when its item list is empty**, and adds `positionFlexibleAnchored` to `core/OverlayPosition.ts`. Read its *Architecture Decisions* before implementing this one: two of its entries — the constructor overload pair, and the empty-list suppression — are load-bearing for the decisions below. **This plan cannot start until that plan has shipped AND the library has been rebuilt with `npm run build:lib` in the library repo** — sqladmin consumes the library's *built* `dist/lib` through a gitignored symlink, so an un-rebuilt library will not expose `MenuButton` no matter what the source says. See `## Verification` step 0. Do not re-plan or modify the library from this repo.

---

## Architecture Decisions

### `glyphButton` gains a `MenuButton` sibling — it does not compose, and the sites do not drop the helper

This is the plan's main design question; the answer is **a sibling helper in the same module**.

`glyphButton` ([`frontend/src/dock/glyphButton.ts:18`](frontend/src/dock/glyphButton.ts#L18)) *constructs* a `Button` and wires an `action` handler. It cannot compose with `MenuButton`: `MenuButton` is a `Button` **subclass**, so the concrete class must be chosen at construction time, and `MenuButton` wires its **own** `action` listener — `glyphButton`'s `handler` parameter is exactly the thing `MenuButton` replaces. Dropping the helper is also wrong: its `{ showText: false, showDescription: false, compact: true }` bag is what makes a glyph-only toolbar face, and these four buttons sit **in the same toolbars as** plain `glyphButton`s ([`TableWorkPanel.ts:79-106`](frontend/src/dock/TableWorkPanel.ts#L79), [`QueryPanel.ts:199-227`](frontend/src/dock/QueryPanel.ts#L199)) — inlining the bag at four sites would let them drift visually from their neighbours.

So: extract the shared bag into a private `glyphButtonOptions(glyph, color, label)` and add `glyphMenuButton(glyph, color, label, menuItems): MenuButton` beside `glyphButton`. Both helpers stay ~4 lines, the bag has one owner, and the module's stated responsibility ("a glyph-only toolbar button") is unchanged.

### `glyphMenuButton` constructs with the options-only call form, exactly like `glyphButton`

`MenuButton` mirrors `Button`'s constructor **overload pair, in `Button`'s order** — options-only last — so `MenuButton({ glyph, … })` typechecks (library plan, *`MenuButton` mirrors `Button`'s constructor overload pair*; the ordering is verified empirically there against `tsconfig.lib.json`). `glyphMenuButton` therefore calls `MenuButton({ ...glyphButtonOptions(glyph, color, label), menuItems })`, the exact shape `glyphButton` already uses for `Button` at [`glyphButton.ts:27`](frontend/src/dock/glyphButton.ts#L27). No dummy `undefined`, no divergence between the two helpers.

**Trap — do not "tidy" this into the text-first form.** `MenuButton("Export", { menuItems })` as a **call** is a `TS2554: Expected 1 arguments, but got 2`, because `callable()`'s call signature is `ConstructorParameters<T>` = the *last* overload. This is precedented and deliberate: `Button("Save", { glyph })` is already the same error today, which is why `glyphButton` folds the text into the options bag as `text: label` rather than passing it positionally. Text-plus-options construction goes through `new`. Neither helper in this plan needs it — both construct options-only — but if a future call site does, the fix is `new MenuButton(…)`, **never** reordering the library's overloads (that would break the options-only form every consumer depends on).

### The per-open item-builder is a provider only where items actually vary — two of four sites use the static array form

`MenuButtonOptions.menuItems` accepts `MenuItemConfig[] | (() => MenuItemConfig[])`. Use the **array** form where the items are fixed for the button's lifetime, and the **provider** form only where they are not:

| Site | Form | Why |
| --- | --- | --- |
| `exportButton.ts` (CSV/JSON) | array | Two fixed entries closed over `onExport`. |
| `StructurePanel` Add-constraint | array | A fixed `.map` over the module constant `ADD_CONSTRAINT_KINDS`, closed over `actions`. |
| `StructurePanel` Alter-column | **provider** | Items close over `selectedColumn(columns, grid)`, which changes with the grid selection. |
| `QueryPanel` Export | **provider** | Items branch on `activeExport.kind` (`"rows"` → CSV/JSON, `"plan"` → text/JSON), which changes per run. |

Do not reach for the provider form "just in case" — a static array is rebuilt per open anyway (a rebuild-mode `Menu` re-creates its items on every `show`), so the provider buys nothing where nothing varies.

### Both early-returns become a plain `[]` — no placeholder at either site

`Menu.toggleFor` now **suppresses the open when `configs` is empty** (library plan, *An empty item list means "don't open"*): it fires `onClose`, records no opener, and mounts nothing. So `[]` from a provider means exactly what today's early-returns mean — *show nothing* — and both guards translate directly:

- [`StructurePanel.ts:227-229`](frontend/src/dock/StructurePanel.ts#L227) — `if (!column) { return; }` → `buildAlterColumnItems` returns `[]`
- [`QueryPanel.ts:259-261`](frontend/src/dock/QueryPanel.ts#L259) — `if (!activeExport) { return; }` → `buildQueryExportItems` returns `[]`

This is a **per-site call, and it came out the same way at both** — but for two different reasons, so both are recorded. The competing option is the library's disabled-placeholder idiom (`NotificationHistoryButton`'s `[{ text: "No notifications yet", enabled: false }]`, [`NotificationHistoryButton.ts:134`](../../typescript-ui/src/typescript/lib/overlay/NotificationHistoryButton.ts#L134)), which remains fully supported and is the right answer when the empty state is **normal and worth explaining**. Neither of these two states is:

- **Query export → `[]`.** The guard is *exactly* co-extensive with the button's disabled state: `setActiveExport` runs `exportButton.setEnabled(active !== null)` ([`QueryPanel.ts:247`](frontend/src/dock/QueryPanel.ts#L247)), and `setEnabled(false)` sets the native `disabled` attribute ([`Button.ts:2408`](../../typescript-ui/src/typescript/lib/component/button/Button.ts#L2408)), which suppresses pointer events. A click therefore *cannot* reach the builder with `active === null` — QueryPanel's own comment already calls the guard "defensive". A placeholder here would ship a user-visible string that no user can ever see. `[]` preserves today's exact behaviour with no dead UI.
- **Alter-column → `[]`.** This guard is marginally wider than its disabled state — `gateOnSelection` checks only `getSelectedRecord() !== null` ([`StructurePanel.ts:244`](frontend/src/dock/StructurePanel.ts#L244)) while `selectedColumn` additionally needs `findColumn` to resolve the name ([`StructurePanel.ts:257`](frontend/src/dock/StructurePanel.ts#L257)) — so a real click *can* reach the builder. But the only way it does is a `.find()` miss over `columns`, **the very array the grid's rows were built from** ([`buildColumnsGrid(columns)`](frontend/src/dock/columnsGrid.ts)): a data-integrity impossibility, not a user state. Decisive point: **there is no honest placeholder text for it.** "No column selected" would be a lie — a row *is* selected — and "Column metadata unavailable" is a dead end that explains nothing actionable. A placeholder earns its keep by explaining; one that misleads is worse than an inert button. `[]` it is.

The "silently non-opening button reads as broken" concern is real and is why this was weighed per-site rather than blanket-applied — but it bites when a *reachable, legitimate* empty state leaves the user with no feedback. Neither site has one, and in both cases `[]` reproduces today's shipped behaviour byte-for-byte, which is the conservative default for a migration whose remit is placement, not UX.

**Rejected alternative:** resolving the column *inside* each item's `action` (making the list unconditionally 6 entries). It works — the selection cannot change while the menu is open — but it silently offers six live-looking actions that all no-op, and hides the guard inside six closures instead of stating it once.

**Two library-side guarantees this relies on, both pinned by regression tests in the library repo — not this plan's job to implement or re-test, but do not be surprised by them.** (1) The empty check sits *after* `toggleFor`'s `_currentOpener` toggle-shut branch, so a click meant to *close* an open menu whose provider has since gone empty still closes it rather than stranding the panel; a suppressed open also records no opener, so the next press is a clean open. (2) A suppressed open still fires `onClose` once. Neither of this app's sites passes an `onClose` or has an optimistic open-state affordance to revert, so (2) is inert here — it exists for `SplitButton`'s chevron.

### Item builders move to a new **DOM-free** module so vitest can pin them

Anything importing a library UI *value* is un-importable under sqladmin's node-environment vitest — verified empirically: importing `src/dock/exportButton.ts` in a node test throws `ReferenceError: document is not defined` from `ProgressSpinner.ts:20` via `StyleRule.ensureKeyframes` (the library's modules touch `document` at import scope; see the memory note *tsui DOM module side effects*). `vitest.config.ts` pins `environment: "node"` and its comment states the rule: *"component/DOM behaviour is verified live, not here."*

So the item lists — the only part of this change carrying real logic (the `kind` branch, the two guards) — move into a new **`frontend/src/dock/menuItems.ts`** whose only library import is `import type { MenuItemConfig } from "@jimka/typescript-ui/component/container"`. A `import type` is erased at compile time, so the module stays node-importable — the same idiom as [`src/dock/ddlSpecs.ts`](frontend/src/dock/ddlSpecs.ts) (whose header comment states this rule verbatim) and [`src/dock/filterModel.ts`](frontend/src/dock/filterModel.ts), both pinned by node tests.

**Trap:** `Glyph.register(...)` calls **stay in the panel modules** ([`exportButton.ts:18`](frontend/src/dock/exportButton.ts#L18), [`StructurePanel.ts:69`](frontend/src/dock/StructurePanel.ts#L69), and QueryPanel's). `menuItems.ts` only ever references glyphs by their registered **string name** (`"file-csv"`, `"file-code"`, `"file-lines"`). Moving a `Glyph.register` into it would re-break its node-importability.

### The app-owned `const menu = Menu()` at each site becomes redundant and is deleted

Each site creates its `Menu` once outside the handler and reuses it across clicks — [`exportButton.ts:31`](frontend/src/dock/exportButton.ts#L31), [`StructurePanel.ts:221`](frontend/src/dock/StructurePanel.ts#L221), [`StructurePanel.ts:298`](frontend/src/dock/StructurePanel.ts#L298), [`QueryPanel.ts:220`](frontend/src/dock/QueryPanel.ts#L220). `MenuButton` already does exactly this internally: `private _menu: Menu | null = null`, lazily created on first open (`this._menu ??= new Menu()…`) and reused for the life of the button. The reuse is **preserved, and becomes the library's job** — delete the app-side `Menu` locals, and with them the now-unused `import { Menu } from "@jimka/typescript-ui/overlay"` in all three modules.

`MenuButton` is strictly better than the hand-rolled version: it also passes the button's element as `toggleFor`'s `openerEl`, so a second click on the button toggles the menu shut instead of light-dismissing and immediately reopening.

### The one site where the flip is observable — and it is not a toolbar

Three of the four buttons live in a `ToolBar` placed at `Placement.NORTH` of their panel ([`TableWorkPanel.ts:121`](frontend/src/dock/TableWorkPanel.ts#L121), [`RoleGrantsPanel.ts:55`](frontend/src/dock/RoleGrantsPanel.ts#L55), [`QueryPanel.ts:230`](frontend/src/dock/QueryPanel.ts#L230)). A NORTH toolbar is pinned to the *top* of its dock tab, so it can never approach the viewport bottom. For these three the win is anchoring correctness only: the menu leaves the button's border alone instead of landing under the pointer.

**`StructurePanel` is the exception, and it is the manual-verification scenario.** Its Alter-column and Add-constraint buttons are `tools` on *accordion section headers* ([`StructurePanel.ts:153-156`](frontend/src/dock/StructurePanel.ts#L153)), hosted in an `autoScroll` VBox that **scrolls** once the open sections exceed the tab (per the module's own header comment, lines 10-18). Expanding all four sections and scrolling down puts the **Constraints** header — and its "Add constraint" tool — within a few pixels of the viewport bottom. Today its menu would clamp upward over itself; after this change it must flip cleanly above the button. Named concretely in `## Verification` step 6.

---

## Public API

App-internal only; nothing is published.

```typescript
// frontend/src/dock/glyphButton.ts — NEW export beside the existing glyphButton

/**
 * Build a compact, glyph-only toolbar button whose click opens a dropdown menu
 * anchored under the button (flipping above it when the room below is short).
 *
 * @param glyph - Registered glyph name for the button face.
 * @param color - Foreground (glyph) color.
 * @param label - Hover tooltip and accessible name; not shown on the face.
 * @param menuItems - The dropdown's items, or a provider re-invoked on every open.
 *
 * @returns The wired menu button.
 */
export function glyphMenuButton(
    glyph:     string,
    color:     string,
    label:     string,
    menuItems: MenuItemConfig[] | (() => MenuItemConfig[]),
): MenuButton;
```

```typescript
// frontend/src/dock/menuItems.ts — NEW module (DOM-free; type-only library import)

export function buildTableExportItems(onExport: (format: "csv" | "json") => void): MenuItemConfig[];

export function buildQueryExportItems(active: ActiveExport | null, notify: Notify): MenuItemConfig[];

export function buildAlterColumnItems(column: ColumnMeta | undefined, actions: StructureActions): MenuItemConfig[];

export function buildAddConstraintItems(actions: StructureActions): MenuItemConfig[];
```

```typescript
// frontend/src/dock/exportButton.ts — CHANGED return type
export function buildExportButton(label: string, onExport: (format: "csv" | "json") => void): MenuButton;
```

`MenuButton extends Button`, so every existing consumer of `buildExportButton`'s result (`ToolBar` `components` arrays, `setEnabled`, `Button[]` tool arrays) keeps typechecking unchanged.

---

## Internal Structure

### `frontend/src/dock/glyphButton.ts`

```typescript
import { Button }     from "@jimka/typescript-ui/component/button";
import { MenuButton } from "@jimka/typescript-ui/component/button";
import type { ButtonOptions }   from "@jimka/typescript-ui/component/button";
import type { MenuItemConfig }  from "@jimka/typescript-ui/component/container";

/**
 * The shared glyph-only face: showText:false keeps the face glyph-only while the
 * label drives the tooltip and aria-label; showDescription:false keeps any
 * description (e.g. the Filter button's "(active)" state) in the tooltip only.
 * One owner, so the plain and menu variants cannot drift apart in a toolbar that
 * mixes them.
 */
function glyphButtonOptions(glyph: string, color: string, label: string): ButtonOptions {
    return { glyph, text: label, showText: false, showDescription: false, foregroundColor: color, compact: true };
}

export function glyphButton(glyph: string, color: string, label: string, handler: (event: MouseEvent) => void): Button {
    const button = Button(glyphButtonOptions(glyph, color, label));

    button.on("action", handler);

    return button;
}

export function glyphMenuButton(
    glyph: string, color: string, label: string, menuItems: MenuItemConfig[] | (() => MenuItemConfig[]),
): MenuButton {
    // Options-only call form, exactly as glyphButton constructs its Button — the
    // label rides in the bag as `text`, never positionally (MenuButton("x", {…})
    // as a *call* is TS2554, same as Button today). MenuButton wires its own
    // "action" listener, so there is no handler to pass.
    return MenuButton({ ...glyphButtonOptions(glyph, color, label), menuItems });
}
```

### `frontend/src/dock/menuItems.ts` (new)

Header comment must state: *DOM-free (see memory "tsui DOM module side effects") so the node-only vitest can pin them — the library import is type-only and erases. Glyph names are strings here; the `Glyph.register` calls stay in the panel modules that render these buttons.*

`ALTER_COLUMN_ACTIONS` ([`StructurePanel.ts:87`](frontend/src/dock/StructurePanel.ts#L87)) and `ADD_CONSTRAINT_KINDS` ([`StructurePanel.ts:99`](frontend/src/dock/StructurePanel.ts#L99)) **move here verbatim**, comments included — each is used only by its builder, and co-locating them lets the test pin label/order.

```typescript
import type { MenuItemConfig }   from "@jimka/typescript-ui/component/container";
import type { ActiveExport }     from "../data/explain";
import type { Notify }           from "./QueryPanel";
import type { StructureActions } from "./StructurePanel";
import type { AlterColumnAction, ColumnMeta, ConstraintKind } from "../contract";
import { exportQueryResult } from "./exportQueryResult";
import { exportExplainPlan } from "./exportExplainResult";

export function buildTableExportItems(onExport: (format: "csv" | "json") => void): MenuItemConfig[] {
    return [
        { text: "Export CSV (.csv)",   glyph: "file-csv",  action: () => onExport("csv") },
        { text: "Export JSON (.json)", glyph: "file-code", action: () => onExport("json") },
    ];
}

export function buildQueryExportItems(active: ActiveExport | null, notify: Notify): MenuItemConfig[] {
    // Nothing to export: an empty list means "don't open" (Menu.toggleFor
    // suppresses it), reproducing the early-return this replaced. Defensive —
    // the Export button is disabled whenever `active` is null (setActiveExport).
    if (!active) {
        return [];
    }

    if (active.kind === "rows") {
        return [
            { text: "Export CSV (.csv)",   glyph: "file-csv",  action: () => exportQueryResult(active.result, "csv", notify) },
            { text: "Export JSON (.json)", glyph: "file-code", action: () => exportQueryResult(active.result, "json", notify) },
        ];
    }

    return [
        { text: "Export text (.txt)",  glyph: "file-lines", action: () => void exportExplainPlan(active.plan, "txt", notify) },
        { text: "Export JSON (.json)", glyph: "file-code",  action: () => void exportExplainPlan(active.plan, "json", notify) },
    ];
}

export function buildAlterColumnItems(column: ColumnMeta | undefined, actions: StructureActions): MenuItemConfig[] {
    // Unresolvable column: an empty list means "don't open" (Menu.toggleFor
    // suppresses it), reproducing the early-return this replaced. Reachable only
    // via a findColumn miss over the array the grid was built from — so there is
    // no honest placeholder text for it; see Architecture Decisions.
    if (!column) {
        return [];
    }

    return ALTER_COLUMN_ACTIONS.map(a => ({ text: a.label, action: () => actions.onAlterColumn(column, a.action) }));
}

export function buildAddConstraintItems(actions: StructureActions): MenuItemConfig[] {
    return ADD_CONSTRAINT_KINDS.map(k => ({ text: k.label, action: () => actions.onAddConstraint(k.kind) }));
}
```

The `import type` back to `QueryPanel` / `StructurePanel` is erased at runtime, so there is **no import cycle** at load time — this is the same pattern `filterModel.test.ts` relies on. `exportQueryResult` / `exportExplainPlan` are value imports but are themselves DOM-free (they reach the DOM only through `../data/download`, which the tests already `vi.mock` — see [`tests/dock/exportExplainResult.test.ts:4`](frontend/tests/dock/exportExplainResult.test.ts#L4)).

### `frontend/src/dock/exportButton.ts`

```typescript
export function buildExportButton(label: string, onExport: (format: "csv" | "json") => void): MenuButton {
    return glyphMenuButton("file-export", PRIMARY_COLOR, label, buildTableExportItems(onExport));
}
```

Delete the `Menu` import, the `Button` import, and `const menu = Menu()`. Keep the `Glyph.register(file_export, file_csv, file_code)` line and the module header (update its "pops a CSV / JSON chooser at the click point" wording to "under the button").

### `frontend/src/dock/StructurePanel.ts`

```typescript
const alterButton = glyphMenuButton("pencil", PRIMARY_COLOR, "Alter column",
                                    () => buildAlterColumnItems(selectedColumn(columns, grid), actions));
```

```typescript
const addButton = glyphMenuButton("plus", CONSTRUCTIVE_COLOR, "Add constraint", buildAddConstraintItems(actions));
```

Delete `const alterMenu = Menu()` (221), `const addMenu = Menu()` (298), the `Menu` import (43), and the moved constants (87-105). `gateOnSelection(grid, [alterButton, dropButton])` at line 244 is **unchanged** — it stays the primary gate, so the builder's `[]` branch remains the defensive backstop it is today rather than the button's normal "nothing to offer" state. Update the two doc comments' `{@link ALTER_COLUMN_ACTIONS}` / `{@link ADD_CONSTRAINT_KINDS}` references, which now point at `./menuItems`.

### `frontend/src/dock/QueryPanel.ts`

```typescript
const exportButton = glyphMenuButton("file-export", PRIMARY_COLOR, "Export results (CSV / JSON)",
                                     () => buildQueryExportItems(activeExport, notify));
```

The provider closes over the `let activeExport` at [`QueryPanel.ts:241`](frontend/src/dock/QueryPanel.ts#L241) and is re-invoked on every open, so it always reads the current value. **Ordering constraint:** `activeExport` is declared at line 241 but `exportButton` is built at line 217 — the closure body only *runs* on click, so the TDZ is never hit; leave the declarations where they are. `setActiveExport`'s `exportButton.setEnabled(active !== null)` (247) is unchanged.

Delete `const exportMenu = Menu()` (219-220), the whole `openExportMenu` function (250-275), the `Menu` import, and the now-unused `exportQueryResult` / `exportExplainPlan` imports (74-75) — both moved to `menuItems.ts`.

---

## Ordered Implementation Steps

0. **Precondition — do not start until both hold.** (a) `/home/jika/typescript/typescript-ui/plans/menu-anchored-placement.md` is implemented (it will have moved to `plans/implemented/`); (b) the library has been rebuilt: `cd /home/jika/typescript/typescript-ui && npm run build:lib` — **`build:lib`, not `build`**. Confirm with `grep -rl "MenuButton" /home/jika/typescript/sqladmin/frontend/node_modules/@jimka/typescript-ui/dist/lib/ | head -1` — a match means sqladmin can see it. If empty, stop; the dependency has not shipped.
1. **Worktree setup (if working in one):** `ln -s /home/jika/typescript/sqladmin/frontend/node_modules <worktree>/frontend/node_modules`. Without it every `npm run typecheck` / `npx vitest` in the worktree fails to resolve `@jimka/typescript-ui`.
2. **Create `frontend/src/dock/menuItems.ts`** per *Internal Structure*, moving `ALTER_COLUMN_ACTIONS` and `ADD_CONSTRAINT_KINDS` over from `StructurePanel.ts:87-105` verbatim (with their comments). Full JSDoc on each exported function per the global CODE_CONVENTIONS.
3. **Create `frontend/tests/dock/menuItems.test.ts`** covering *Expected Behaviour* §1, following [`tests/dock/exportExplainResult.test.ts`](frontend/tests/dock/exportExplainResult.test.ts)'s idiom (`vi.mock("../../src/data/download", …)` at the top, before the imports under test). Run `cd frontend && npx vitest run tests/dock/menuItems.test.ts` — red until step 2 lands, green after. **Checkpoint:** this file must import cleanly under `environment: "node"`; a `document is not defined` here means a library *value* import leaked into `menuItems.ts`.
4. **`frontend/src/dock/glyphButton.ts`** — extract `glyphButtonOptions` and add `glyphMenuButton` per *Internal Structure*. Update the module header comment to mention both variants.
5. **`frontend/src/dock/exportButton.ts`** — rewrite `buildExportButton` per *Internal Structure*; drop the `Menu` / `Button` imports and the `Menu()` local; keep `Glyph.register`.
6. **`frontend/src/dock/StructurePanel.ts`** — rewrite `buildColumnsTools`'s `alterButton` (224-235) and `buildConstraintsTools`'s `addButton` (300-305) per *Internal Structure*. Delete the two `Menu()` locals, the `Menu` import (43), and the two moved constants; add the `glyphMenuButton` / `buildAlterColumnItems` / `buildAddConstraintItems` imports. Keep `gateOnSelection`, `selectedColumn`, and `findColumn` exactly as they are.
7. **`frontend/src/dock/QueryPanel.ts`** — rewrite `exportButton` (217) per *Internal Structure*; delete `exportMenu` (219-220), `openExportMenu` (250-275), and the `Menu` / `exportQueryResult` / `exportExplainPlan` imports. Keep `setActiveExport` and the `Glyph.register` for `file-lines`/`file-csv`/`file-code`.
8. **Checkpoint — the migration is total and the context menus are untouched:**
   - `grep -rn "clientX" frontend/src/dock/` → **zero matches**.
   - `grep -rln "clientX" frontend/src/` → exactly `navigator/NavigatorTree.ts`, `roles/RolesTree.ts`, `shell/QueriesView.ts` — the three genuine right-click sites, unmodified.
   - `grep -rn "Menu()" frontend/src/dock/` → **zero matches**.
9. **Checkpoint:** `cd frontend && npm run typecheck` — clean.
10. **Checkpoint:** `cd frontend && npm test` — all green (the new §1 suite plus the untouched existing suites).
11. **Manual verification** — `## Verification` step 6. Nothing about the placement is unit-testable from this repo.
12. **`LIBRARY_NOTES.md`** — append a `## ✅ Fixed in library: button-triggered menus were anchored to the pointer` entry per `## Documentation Impact`.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `frontend/src/dock/menuItems.ts` |
| Create | `frontend/tests/dock/menuItems.test.ts` |
| Modify | `frontend/src/dock/glyphButton.ts` |
| Modify | `frontend/src/dock/exportButton.ts` |
| Modify | `frontend/src/dock/StructurePanel.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `LIBRARY_NOTES.md` |

`frontend/src/dock/TableWorkPanel.ts` and `frontend/src/dock/RoleGrantsPanel.ts` are **not** modified: `buildExportButton`'s return type widens from `Button` to its subclass `MenuButton`, which both consumers accept unchanged.

---

## Expected Behaviour

### §1 `menuItems.ts` builders — unit-testable (node vitest, `tests/dock/menuItems.test.ts`)

This is the whole automatable surface of the change: the guards, the branch, and the item content. Assert on `text` / `glyph` / `enabled` and drive `action()` against mocks.

**`buildTableExportItems`**
- Returns exactly two items: `["Export CSV (.csv)", "Export JSON (.json)"]` with glyphs `["file-csv", "file-code"]`.
- Invoking item 0's `action()` calls `onExport("csv")`; item 1's calls `onExport("json")`.

**`buildQueryExportItems`**
- `null` active → **`[]`** (length 0). This is the contract `Menu.toggleFor`'s empty-list suppression consumes: an empty list opens nothing.
- `{ kind: "rows", result }` → two items `["Export CSV (.csv)", "Export JSON (.json)"]`, glyphs `["file-csv", "file-code"]`; `action()` calls `exportQueryResult(result, "csv" | "json", notify)` respectively.
- `{ kind: "plan", plan }` → two items `["Export text (.txt)", "Export JSON (.json)"]`, glyphs `["file-lines", "file-code"]`; `action()` calls `exportExplainPlan(plan, "txt" | "json", notify)` respectively.
- Every returned item in both non-null branches is enabled (no `enabled: false`).

**`buildAlterColumnItems`**
- `undefined` column → **`[]`** (length 0).
- A `ColumnMeta` → exactly six items, in order: `["Rename column…", "Change type…", "Set NOT NULL", "Drop NOT NULL", "Set default…", "Drop default"]`.
- Item 2's `action()` calls `actions.onAlterColumn(column, "setNotNull")` — the column instance is passed through by identity, and each item carries its own `AlterColumnAction`.

**`buildAddConstraintItems`**
- Always exactly four items, in order: `["Primary key…", "Unique…", "Check…", "Foreign key…"]` — never empty, so its button always opens.
- Item 3's `action()` calls `actions.onAddConstraint("foreignKey")`.

### §2 Button wiring and placement — **manual verification only**

Not unit-testable from this repo: `vitest.config.ts` pins `environment: "node"`, and any module importing a library UI value throws `ReferenceError: document is not defined` at import (empirically confirmed against `src/dock/exportButton.ts`). The library's own `installTestDOM` harness — which *does* model rects and viewport offline — lives in the library repo and covers `MenuButton`/`Menu` placement there; duplicating it here is out of scope (see `## Non-Goals`). Verify by driving the app (`## Verification` step 6):

- Each of the four menus opens flush under its button's **bottom-left corner**, clearing the button's border — never under the pointer, and never overlapping the button.
- Clicking the same button a second time **closes** the menu (`MenuButton` passes the button element as `toggleFor`'s `openerEl`, which is new behaviour — today's `show()` sites reopen instead).
- Structure ▸ Constraints ▸ "Add constraint" with the header scrolled near the viewport bottom opens **above** the button, its bottom flush at the button's top edge.
- The Query Export menu's contents follow the shown result: CSV/JSON after a `SELECT`, text/JSON after an `EXPLAIN` — proving the provider re-runs per open rather than caching the first list.
- The disabled Alter/Export buttons remain unclickable — no menu, and in particular **no bare empty panel** ever appears.
- **Regression:** the right-click context menus in the navigator tree, the roles tree, and the Queries sidebar still open with their **top-left at the cursor**.

---

## Verification

0. **The library dependency, first — this is the step that most commonly bites.** sqladmin resolves `@jimka/typescript-ui` through a **gitignored symlink** (`frontend/node_modules/@jimka/typescript-ui -> ../../../../typescript-ui`) and consumes that checkout's **built `dist/lib`**, not its `src/`. After `menu-anchored-placement` lands in the library:
   ```
   cd /home/jika/typescript/typescript-ui && npm run build:lib
   ```
   **`npm run build:lib`, NOT `npm run build`** — `build` builds the demo app and leaves `dist/lib` stale, so sqladmin would keep failing to resolve `MenuButton` with no obvious cause.
1. **Worktree only:** `ln -s /home/jika/typescript/sqladmin/frontend/node_modules <worktree>/frontend/node_modules` — a fresh worktree has no `frontend/node_modules`, and without the symlink every check below fails at module resolution.
2. `cd frontend && npm run typecheck` — clean.
3. `cd frontend && npm test` — all green, including the new `tests/dock/menuItems.test.ts` (§1) and every pre-existing suite.
4. **Grep invariants** (from the repo root):
   - `grep -rn "clientX" frontend/src/dock/` → zero matches.
   - `grep -rn "Menu()" frontend/src/dock/` → zero matches.
   - `grep -rln "clientX" frontend/src/` → exactly `navigator/NavigatorTree.ts`, `roles/RolesTree.ts`, `shell/QueriesView.ts`.
   - `git diff --stat` touches no file outside the `## Files to Create / Modify / Delete` table.
5. `cd frontend && npm run build` — clean (it chains `tsc --noEmit` then `vite build`).
6. **Manual smoke** — run the app (backend + `cd frontend && npm run dev`) and sign in (Host `sqladmin-db`, not `localhost`):
   - **The flip (the headline case).** Navigator ▸ right-click a table ▸ *Show ▸ Structure*. In the Structure tab, expand **all four** sections (Columns, Indexes, Constraints, Foreign Keys) so the accordion stack overflows its tab and the host VBox scrolls; scroll until the **Constraints** header sits within ~40px of the viewport bottom. Click its "Add constraint" tool: the four-item menu must open **above** the button with its bottom flush at the button's top edge, must not cover the button, and must not be clipped. Shrink the window vertically to reproduce more easily.
   - **Anchoring.** In the same panel with Constraints near the *middle* of the screen, click "Add constraint" near the button's left edge and again near its right edge — the menu must land in the **same** place both times (rect-anchored), unlike today where it follows the cursor.
   - **Toggle.** Click "Add constraint" twice — the second click closes the menu.
   - **Alter column.** Select a row in the Columns grid, click the pencil tool: six items, and "Rename column…" opens the rename dialog for the selected column. With no row selected the pencil is greyed out and unclickable.
   - **Query export.** Open a SQL tab, run `SELECT 1;` → the Export button's menu offers CSV/JSON. Then *Explain* the same statement → reopen Export: it now offers text/JSON. Export JSON downloads a file.
   - **Table / grants export.** Open a table's data tab and a role's grants tab; each Export button opens its CSV/JSON chooser under the button and downloads.
   - **Context-menu regression.** Right-click a navigator schema, a role in the Roles tree, and a saved query in the Queries sidebar — each menu's **top-left must still land at the cursor**.

---

## Documentation Impact

No public API and no user-facing docs — sqladmin publishes nothing. Two in-repo doc obligations:

- **`LIBRARY_NOTES.md`** (newest entries first, per its header) — this migration is the resolution of a library-side bug the app was silently living with, which is exactly what that file logs. Add a top entry under the `✅ fixed in library` status: the four dock buttons passed `event.clientX/clientY` to `Menu.show`, which cursor-anchors and clamps-but-never-flips; it looked fine only because three of the four sat in top-pinned toolbars, while the Structure accordion's scrollable header tools could reach the bottom edge. Fixed in the library by `MenuButton` + rect-anchored `Menu.toggleFor` (`typescript-ui` plan `menu-anchored-placement`), adopted here. Record that adopting it surfaced two API gaps which were **raised and fixed in the library before this migration landed** — so log them as `✅`, not as open `✂️` papercuts: (a) an early draft mandated a single non-overloaded `MenuButton` constructor, which would have forced every options-first construction to pass a dummy `undefined` text; it now mirrors `Button`'s overload pair, so `MenuButton({ … })` works. (b) A per-open item provider had no way to say "open nothing" — an empty array mounted a bare ~8px panel; `Menu.toggleFor` now suppresses the open (and still fires `onClose`), which is what lets this app's two dynamic builders return `[]` instead of inventing placeholder strings. Worth noting as the file's running theme: both gaps were found only by a second consumer trying to *use* the component, which is what this app is for.
- **Module header comments** — `exportButton.ts`'s header says the menu pops "at the click point"; `StructurePanel.ts`'s says the tools are "launchers". Update `exportButton.ts` (and `QueryPanel.ts:219`'s "shown under the Export button; reused across clicks" comment, which is now the library's job) to describe rect-anchoring. `frontend/COMPONENT_CONVENTIONS.md` needs no change — this plan converts no builder to class-first.

---

## Potential Challenges

- **The library isn't rebuilt.** By far the likeliest failure: `MenuButton` resolves in the library's `src/` but not in sqladmin, because `dist/lib` is stale. Mitigation: Step 0's `grep` against `frontend/node_modules/@jimka/typescript-ui/dist/lib/` before writing any code.
- **`menuItems.ts` silently loses node-importability.** Adding a single library *value* import (or a `Glyph.register`) breaks every test in the file with an opaque `document is not defined` from deep inside the library. Mitigation: the module's header comment states the rule, and step 3's checkpoint catches it immediately.
- **"Tidying" `MenuButton({ …, menuItems })` into `MenuButton("Export", { menuItems })`.** The text-first *call* form is `TS2554` — `Button("Save", { glyph })` already is, so it is precedented, not a defect. Mitigation: the comment in `glyphMenuButton`, plus `npm run typecheck` failing immediately. The fix is `new MenuButton(…)`, never reordering the library's overloads.
- **Assuming `[]` suppresses *every* menu.** The suppression lives in `Menu.toggleFor` only; `Menu.show(x, y, [])` still mounts an empty panel, deliberately and permanently (library plan, *Non-Goals*). This costs nothing here — the three `show()` context menus are out of scope and build their items for one specific click — but do not "simplify" any of them toward an empty-list guard on the strength of this plan.
- **`Notify` / `StructureActions` imported from DOM-bound modules.** They must stay `import type`; converting either to a value import would pull `QueryPanel`/`StructurePanel` — and the whole library — into the node test. Mitigation: `npx vitest run tests/dock/menuItems.test.ts` fails loudly and instantly.
- **The Structure accordion is hard to get near the bottom edge on a tall monitor.** Mitigation: `## Verification` step 6 says to shrink the window vertically.

---

## Critical Files

- `/home/jika/typescript/typescript-ui/plans/menu-anchored-placement.md` — **read in full first.** The `MenuButton` API this plan consumes; its *Public API* and *Internal Structure* sections are the contract.
- [`frontend/src/dock/glyphButton.ts`](frontend/src/dock/glyphButton.ts) — the helper being extended (32 lines; read all of it).
- [`frontend/src/dock/exportButton.ts`](frontend/src/dock/exportButton.ts) — the simplest of the four migrations; do it first.
- [`frontend/src/dock/StructurePanel.ts`](frontend/src/dock/StructurePanel.ts) — `ALTER_COLUMN_ACTIONS` (87), `ADD_CONSTRAINT_KINDS` (99), `buildColumnsTools` (220), `gateOnSelection` (180), `selectedColumn` (257), `buildConstraintsTools` (297); the module header (1-30) explains the scrolling accordion the flip depends on.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) — `exportButton` (217), `exportMenu` (220), `activeExport` (241), `setActiveExport` (244), `openExportMenu` (258).
- [`frontend/src/dock/ddlSpecs.ts`](frontend/src/dock/ddlSpecs.ts) — the DOM-free-module idiom `menuItems.ts` follows; its header comment states the rule.
- [`frontend/tests/dock/exportExplainResult.test.ts`](frontend/tests/dock/exportExplainResult.test.ts) — the `vi.mock("../../src/data/download")` idiom the new test copies.
- [`frontend/vitest.config.ts`](frontend/vitest.config.ts) — `environment: "node"`, and the comment stating that component/DOM behaviour is verified live, not here.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — the class-first rules (no conversion here, but read (c) before touching any handler).
- `~/.claude/CODE_CONVENTIONS.md` — blank-line rules, JSDoc on every exported function, explicit return types.

---

## Non-Goals

- **The library work itself.** `MenuButton`, `Menu.toggleFor`'s `Rect` signature, and `positionFlexibleAnchored` are specified and implemented by `menu-anchored-placement` in `/home/jika/typescript/typescript-ui`. Do not edit, re-plan, or work around the library from this repo; if its API is wrong, the two `## Architecture Decisions` feedback notes are the deliverable.
- **The three genuine right-click context menus.** [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) (lines 177, 211, 222, 238, 326), [`frontend/src/roles/RolesTree.ts:83`](frontend/src/roles/RolesTree.ts#L83), and [`frontend/src/shell/QueriesView.ts:303`](frontend/src/shell/QueriesView.ts#L303) are all wired to a `"contextmenu"` event (verified: `NavigatorTree.ts` and `RolesTree.ts:76` via `this.on("contextmenu", …)`, `QueriesView.ts:296` via `list.on("contextmenu", …)`). For a right-click there **is no button rect** — the cursor *is* the anchor, and `Menu.show(x, y, …)`'s clamp-don't-flip is the correct and library-supported behaviour. Migrating them would be a regression. They keep `clientX`/`clientY`, and the grep in `## Verification` step 4 asserts they still do.
- **Porting the library's `installTestDOM` harness into sqladmin** to unit-test placement here. The library already covers `Menu`/`MenuButton` geometry offline in its own repo; standing up a second DOM harness in a node-only test suite to re-test library code is duplicated effort. Placement stays a manual check here.
- **Converting `exportButton.ts` / `StructurePanel.ts` / `QueryPanel.ts` to class-first.** `COMPONENT_CONVENTIONS.md` says to convert only when already touching a module for another reason — but the touch here is four call sites, not a rewrite, and `QueryPanel` is that document's named composition-fallback example. Out of scope.
- **`SplitButton` / `ToolBar` adoption, or any other app menu.** The four sites named in `## Overview` are the complete set; `grep -rn "\.show(" frontend/src` surfaces only `Dialog.show`, `Notification.show`, `Window.show`, and the three context menus besides them.
