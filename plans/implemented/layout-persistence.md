# Layout Persistence — Implementation Plan

## Overview

Persist and restore the sqladmin UI's layout across sessions in `localStorage`: `Split` gutter positions and pane collapsed state, and `Accordion` section open/closed state and sizes. A new `LayoutStore` in [frontend/src/data/layoutStore.ts](frontend/src/data/layoutStore.ts) joins the existing `KeyValueStore`-backed stores, and eight layout sites each take a *binding* — the site's saved state plus save hooks — from it.

> **HARD CROSS-REPO DEPENDENCY — three library plans, in this order.** Nothing here compiles until all three are implemented in `/home/jika/typescript/typescript-ui` **and** `npm run build:lib` (NOT `npm run build`) has run there, because sqladmin consumes the library's built `dist/lib` through the symlink at `frontend/node_modules/@jimka/typescript-ui`.
>
> 1. [`plans/split-weight-pin-refill.md`](/home/jika/typescript/typescript-ui/plans/split-weight-pin-refill.md) — fixes `Split`'s refill silently rescaling `weight: 0` panes (measured in *this* app: a dragged 418px sidebar decayed 418 → 368 → 334 → 309 across three viewport cycles). Without it, saving px would faithfully record a corrupted number.
> 2. [`plans/accordion-resize-weight.md`](/home/jika/typescript/typescript-ui/plans/accordion-resize-weight.md) — gives `Accordion` a container-resize weight concept (measured here: `TreeExplorerView`'s inspector read 219.4 / 164.7 / 109.9 at viewport heights 900 / 700 / 500 instead of holding 220px) and **renames `AccordionConstraints.fillWeight` → the inherited `weight`**, a breaking field deletion that hits this app at five lines.
> 3. [`plans/layout-state-api.md`](/home/jika/typescript/typescript-ui/plans/layout-state-api.md) — **the API contract this plan builds against.** Its `## Public API` and `## Consumer contract summary` define exactly what may be called. It `depends-on` the other two, so once it is in `plans/implemented/`, all three have landed.
>
> The plan-frontmatter spec's `depends-on` names plans in *this* repo's `plans/implemented/`, so it cannot express a cross-repo dependency; hence this notice rather than invented syntax. Step 1 gates on it.

Layout state is **global** — deliberately *not* namespaced by `connectionId`, unlike [`NotesStore`](frontend/src/data/notesStore.ts#L24), [`QueryHistoryStore`](frontend/src/data/queryStore.ts#L87), and [`SavedQueryStore`](frontend/src/data/queryStore.ts#L139). Gutter positions are a property of the user's window, not of the database being viewed.

---

## Architecture Decisions

### Per-site manager references and the new events — **not** `serializeLayout`/`restoreLayout`

The library's [`LayoutSerialization.ts`](/home/jika/typescript/typescript-ui/src/typescript/lib/layout/LayoutSerialization.ts) is rejected. Four independent reasons, any one sufficient:

1. **No single root.** `serializeLayout(root)` walks one tree. sqladmin's three `Split`s live in unrelated subtrees — the shell ([SqlAdminShell.ts:188](frontend/src/shell/SqlAdminShell.ts#L188)), and two *inside per-object Dock panels created on demand* ([QueryPanel.ts:188](frontend/src/dock/QueryPanel.ts#L188), [DefinitionPanel.ts:75](frontend/src/dock/DefinitionPanel.ts#L75)). There is no root whose capture covers them, and nothing to capture at startup — the panels don't exist yet.
2. **No stable IDs, and no factory could exist.** `panelIdOf` is `component.getId()` ([LayoutSerialization.ts:175](/home/jika/typescript/typescript-ui/src/typescript/lib/layout/LayoutSerialization.ts#L175)). sqladmin calls `setId` exactly once, on the Dock ([SqlAdminShell.ts:268](frontend/src/shell/SqlAdminShell.ts#L268)); no split pane has one. The required `LayoutFactory = (panelId) => Component` would have to reconstruct CodeMirror editors and grids built from *fetched database metadata* — synchronously, from a string. It cannot be written.
3. **Park-and-rebuild is disproportionate and unsafe here.** Restore tears down and rebuilds the container tree on every startup to remember a gutter position. Re-homing live `CodeEditor` leaves is risk the feature does not justify.
4. **It covers zero of the Accordion requirement.** `LayoutSerialization` recognises `Split`/`Tab`/`Window` only, and an `AccordionNode` is an explicit library non-goal — so this plan's approach is needed for accordions regardless. Adopting `LayoutSerialization` means two mechanisms where one suffices.

The library plan settles the point independently: *"Do not use `getPaneRatios` / `applyPaneRatios` for session persistence — they are `LayoutSerialization`'s weight-agnostic arrangement surface and will restore a pinned pane at the wrong px."* This plan touches neither.

**`SqlAdminController.panelId(ref)` ([SqlAdminController.ts:2601](frontend/src/SqlAdminController.ts#L2601)) is unrelated to LayoutSerialization's panel IDs.** It is a *Dock* panel key (`connectionId/database/schema.name`) passed to `dock.addPanel`/`removePanel`; LayoutSerialization's is a `Component.getId()`. Different concepts on different objects. Do not conflate them, and do not derive layout keys from `panelId`.

### The unit follows the weight — the app persists `LayoutSize[]` verbatim and never interprets it

The library's central decision: each entry carries its own unit (`{ unit: "px" | "ratio"; value: number }`). A resize-pinned entry (`weight: 0`) persists as **px**, because such a pane exists precisely so it does not scale with the viewport; everything else persists as a **ratio** of the space the px entries leave.

This matters to sqladmin more than to any other consumer: **every one of the app's three Splits pins exactly one pane at `weight: 0`** — the sidebar (`SIDEBAR_DEFAULT_WIDTH`), the query editor (`EDITOR_HEIGHT`), the Columns pane (`COLUMNS_PANE_HEIGHT`) — and the Database/Roles rails' inspector is the library plan's own flagship pinned section. A ratio-only contract would have reintroduced exactly the viewport dependence those weights exist to remove.

The app's obligation is narrow and absolute: **persist the array verbatim, never unwrap it to numbers.** The unit tag is what makes the restore correct and what lets the library's drain detect staleness. The store's JSON blob holds `LayoutSize[]` as-is.

### The app validates *shape*; the library validates *fit*

This is the line that keeps the two layers from double-handling, and it is drawn by what each layer can actually know.

- **The library owns the fit check.** `isRestorableSizes` requires exact length, a per-index unit match against the *live* configured weights, finite non-negative values, and at least one positive entry — then discards the whole array. Every persisted entry point routes through it: `SplitOptions.paneSizes`, `Split.applyPaneSizes`, `AccordionOptions.sectionSizes`, `Accordion.applySectionSizes`. The app cannot perform this check: it holds no manager reference at load time and does not know the live weights.
- **The app owns the shape check.** `JSON.parse` can throw, and a hand-edited blob can hold anything. The store guarantees only that what it hands over is a genuine `Array` of well-formed `LayoutSize` entries — because a non-array would reach `isRestorableSizes`' `.every()` and throw, which is the one garbage shape the library does not absorb. (Individual garbage *entries* it does: a `null`, a number, or a bogus `unit` all fail the unit comparison and are discarded cleanly.)

Consequence, stated so it is not "helpfully" re-added: **the store performs no length check and holds no per-site pane count.** The previous revision carried a `SPLIT_PANES` table for exactly that, because the old contract's restore path (`applyPaneRatios`) was lenient and would silently re-normalise a stale array. Every new entry point is strict, so the table is deleted along with its sync hazard. `ACCORDION_DEFAULT_OPEN` stays — open state has no library-side validation at all, since `initiallyOpen` is a per-section constructor flag.

### No app-side versioning or migration

The unit check catches what a length check cannot: changing a `weight: 0` to `weight: 1` in code between releases makes every saved entry's unit disagree with the live layout, so the array is discarded whole and the site falls back to normal first-layout sizing. That is the entire migration story for a shape change. Do not add a schema version, a migration step, or a store-side unit expectation.

### Layout state is global, keyed `sqladmin.layout.<site>`

Firm user decision: no `connectionId` segment. The prefix stays `sqladmin.` so [localStorageWindow.ts](frontend/src/shell/localStorageWindow.ts#L29)'s `APP_KEY_PREFIX = "sqladmin."` dumps and clears the new keys with **no code change** (verified: `allKeys()` enumerates every key, `clearAppKeys()` removes every `sqladmin.*` one). Only its stale header comment is corrected.

### One key per site holding `{sizes, collapsed, open}`, updated read-modify-write

Precedent: [`SavedQueryStore.save`](frontend/src/data/queryStore.ts#L150) reads its one key's array, mutates, writes back. Per-aspect keys would put ~13 entries in the inspector; one object per site gives 8 and reads cleanly. Each field validates independently, so a corrupt `open` cannot poison `sizes`.

Read-modify-write is **load-bearing, not stylistic**: two panels of the same site can be open at once (two query tabs, two structure tabs). `onCollapse`/`onToggle` therefore write **one index** through the store rather than flushing a binding-cached array — otherwise a toggle in panel A would clobber panel B's unrelated section flags. `onSizes` is inherently whole-array and is last-writer-wins by design.

### The store hands each site a *binding*, not the store itself

The controller's `QueryPanel` construction ([SqlAdminController.ts:1971](frontend/src/SqlAdminController.ts#L1971)) states the stance explicitly: *"The store dependency stays here — the panel is a pure view over these injected callbacks"*, mirroring how the controller passes `this._notes.load()` and a save closure to the documentation panel ([SqlAdminController.ts:1422](frontend/src/SqlAdminController.ts#L1422)) rather than the store. Passing `LayoutStore` into panels would contradict a comment written for exactly this decision.

So `bindSplit(site)` / `bindAccordion(site)` return a small object of loaders and hooks, whose signatures match the library events **exactly** so every wiring is a pass-through (`listeners: { paneresize: layout.onSizes, panecollapse: layout.onCollapse }`), not an adapter.

Loaders are **functions, not snapshots**, because QueryPanel restores at first-run rather than at construction and must read the value current then, not at panel build time.

Binding members are arrow properties on a returned object literal — no `this`, so they are safe passed by reference, satisfying [COMPONENT_CONVENTIONS.md](frontend/COMPONENT_CONVENTIONS.md) (c) without an arrow-field class.

### `LayoutSize` is imported from the library as a type — `verbatimModuleSyntax` makes it provably safe

The previous revision spelled every library shape inline, reasoning that `import type` is erased but *"the safety is invisible at the import line and one dropped `type` keyword breaks the test suite"*. **That premise is false in this repo:** [frontend/tsconfig.json](frontend/tsconfig.json) sets `"verbatimModuleSyntax": true`, under which a plain `import { LayoutSize }` of a type-only symbol is a **compile error** (*"'LayoutSize' is a type and must be imported using a type-only import"*), and an `import type` is guaranteed erased. The compiler enforces exactly the invariant the old decision hand-waved.

So `layoutStore.ts` uses `import type { LayoutSize, LayoutSizeUnit } from "@jimka/typescript-ui/layout";` — the library plan's own instruction — and stays DOM-free under sqladmin's node vitest. This is the right call now regardless of the tsconfig: `LayoutSize` is a **data shape the app round-trips through JSON**, not a one-line callback signature. Redeclaring it locally would mean a silent divergence the day the library adds a field. The binding hooks' function shapes stay spelled inline (they are the binding's own contract and are structurally checked at each wiring site), but they are typed *in terms of* the imported `LayoutSize`.

### Site keys and default open flags live in the store

The `AccordionSite` union and `ACCORDION_DEFAULT_OPEN` sit in `layoutStore.ts`, not at each site. The "what you get when nothing is saved" default is part of the **persisted contract**, which makes the store the single registry naming every persisted site and every `bind*` call a one-liner (`bindAccordion("structure")`) with a typo caught by the union type. Cost: a site's `initiallyOpen` default now reads from `layout.loadOpen()[i]`; each site keeps a comment pointing at the table, and the table's comments name each site's file and section order.

The site keys are **not** reused from the Card-page ids the shell already passes (`"database"`, `"roles"`, `"queries"` — [SqlAdminShell.ts:69-71](frontend/src/shell/SqlAdminShell.ts#L69)), even though the strings coincide. Those are the activity bar's view keys; coupling persistence to them would let a Card rename silently reset the user's layout.

### QueryPanel restores imperatively; the other two splits use the option

QueryPanel's split has **one** pane (the editor) until the first run adds the result host ([QueryPanel.ts:249](frontend/src/dock/QueryPanel.ts#L249)) and drops back to one when the last tab closes ([QueryPanel.ts:339](frontend/src/dock/QueryPanel.ts#L339)). Both `paneSizes` and `collapsedPanes` drain **once, on the first layout**, when the child count is 1 — a 2-entry array fails `isRestorableSizes`' length check, and a `[0]` collapse no-ops for want of a serving gutter. Neither is ever retried. So QueryPanel restores inside `ensureResultPaneShown`, where both panes exist.

`applyPaneSizes` needs no laid-out container: `fromLayoutSizes` falls back to a unit base when the budget is 0, writing the px entry verbatim and the ratio entry at ~1. The first real layout's delta block then hands the whole delta to the flexible result host (the editor is `weight: 0`, so it takes none), and the refill holds the editor at its px while the result host absorbs. The editor lands on its saved px exactly. So the restore path needs none of `seedEditorHeight`'s `onFirstLayout` retry, which exists only because `setPaneSize` takes px against a known height.

The shell and definition splits have both panes from construction, so they take the declarative option path.

### The shell guards its save against the collapsed rail

The sidebar's collapse is not `Split` collapse: `ActivityBar` pins the pane to `min == max == SIDEBAR_RAIL_WIDTH` ([SqlAdminShell.ts:221](frontend/src/shell/SqlAdminShell.ts#L221)), which the `Split` refill honours as a **hard** pin. While collapsed, the pane's stored px *is* the rail width — and the gutter stays draggable (only the collapse chevron is suppressed). A drag while collapsed would therefore fire `paneresize` carrying `{ unit: "px", value: SIDEBAR_RAIL_WIDTH }`, and since the rail's collapsed state is itself **not** persisted (see `## Non-Goals`), the next session would restore a rail-width sidebar in its *expanded* state.

So the shell's save hook is the one deliberate non-pass-through: it saves only when the sidebar entry exceeds `SIDEBAR_RAIL_WIDTH`. This mirrors the guard `collapse()` already applies three lines away when capturing `lastWidth` ([SqlAdminShell.ts:214](frontend/src/shell/SqlAdminShell.ts#L214)) — same constant, same reason: a rail-width reading is the pin talking, not the user. (`ActivityBar.collapsed` is private with no accessor, so the width *is* the available signal — and it is the one the file already trusts.)

### The shell Split persists sizes only, never collapse

Its sidebar pane is `collapsible: false` ([SqlAdminShell.ts:198](frontend/src/shell/SqlAdminShell.ts#L198)), and the single gutter serves that pane — so no chevron exists and `setPaneCollapsed` can never fire. Wiring collapse here would be dead code.

`split-weight-pin-refill` does not disturb this: it leaves `isPinnedMain` (`min === max`) and its meaning **untouched**, adding a *separate* soft-pin predicate. The rail collapse rides the hard pin exactly as before. What that plan changes is the *expanded* sidebar — previously mis-classified flexible and rescaled, now a soft pin held at its px. That is the fix this plan depends on, and it touches no collapse path.

### No app-side debounce

The library emits resize events at drag **END**, one per completed drag. One drag is already one write. A debounce would add latency and a lost-final-write hazard for no benefit. Do not add one.

### This plan owns the `fillWeight` → `weight` rename at the app's five call sites

`accordion-resize-weight` deletes `AccordionConstraints.fillWeight` and flags — but explicitly does not own — the app's breakage at [treeExplorerView.ts:80](frontend/src/shell/treeExplorerView.ts#L80), [QueriesView.ts:136-137](frontend/src/shell/QueriesView.ts#L136), and [ExplainDiagramPanel.ts:146-147](frontend/src/dock/ExplainDiagramPanel.ts#L146): *"This plan does not edit the app — the app owns its own plans."*

**This plan owns it**, rather than a separate rename plan, because all three files are already in its `## Files to Create / Modify / Delete` — the rename lands in the very `sections:` arrays whose `initiallyOpen` literals this plan rewrites — and a dedicated plan for five one-word edits would cost more to route than to do. It is a hard `tsc` error (the field is gone from the interface, not silently dropped), so it cannot land quietly wrong.

It is kept as its **own early step** with no dependency on the rest, because the app breaks as soon as `accordion-resize-weight` lands and `build:lib` runs — which may be *before* `layout-state-api` does. See `## Potential Challenges`.

**No behaviour change comes with it**: `TreeExplorerView`'s inspector already omits `fillWeight`, so it pins for free and `accordion-resize-weight` delivers the file's stated intent (*"the tree seeds at fill, the inspector at its preferred 220px"*) verbatim; `QueriesView` (both sections weighted) and `ExplainDiagramPanel` (mixed, but not `resizable`) are untouched.

---

## The site inventory

`grep "new AccordionPanel("` misses the two `extends AccordionPanel` classes, which are the **only** accordions where section *sizes* exist (`resizable: true`). `StructurePanel`'s and `ExplainDiagramPanel`'s accordions are **not** resizable, so `sectionresize` can never fire and `sectionSizes` is meaningless for them — open state only.

Each site's **units** follow from its configured weights, per the library's rule (`Split`: px iff an *explicit* `weight: 0`, an unset weight is flexible; `Accordion`: px iff `weight` unset-or-`0` **and** `setFillHeight` off). Verified per site:

| Site | Manager | Where | Lifetime | Entries | Units | Wiring |
|---|---|---|---|---|---|---|
| `shell` | Split | [SqlAdminShell.ts:188](frontend/src/shell/SqlAdminShell.ts#L188) | singleton | sidebar `{weight:0}`, centre `{weight:1}` | `["px","ratio"]` | sizes (rail-guarded); **no** collapse |
| `query` | Split | [QueryPanel.ts:188](frontend/src/dock/QueryPanel.ts#L188) | per query tab | editor `{weight:0}`, result host *(unset → flexible)* | `["px","ratio"]` | sizes + collapse, **imperative restore** |
| `definition` | Split | [DefinitionPanel.ts:75](frontend/src/dock/DefinitionPanel.ts#L75) | per view/matview tab | Columns `{weight:0}`, editor `{weight:1}` | `["px","ratio"]` | sizes + collapse |
| `database` | Accordion **resizable** | [treeExplorerView.ts:71](frontend/src/shell/treeExplorerView.ts#L71) via [DatabaseExplorerView](frontend/src/shell/DatabaseExplorerView.ts#L20) | singleton | tree `weight:1`, inspector *(unset, fillHeight off)* | `["ratio","px"]` | sizes + open |
| `roles` | Accordion **resizable** | [treeExplorerView.ts:71](frontend/src/shell/treeExplorerView.ts#L71) via [RolesExplorerView](frontend/src/shell/RolesExplorerView.ts#L20) | singleton | tree `weight:1`, inspector *(unset, fillHeight off)* | `["ratio","px"]` | sizes + open |
| `queries` | Accordion **resizable** | [QueriesView.ts:129](frontend/src/shell/QueriesView.ts#L129) | singleton | Saved `weight:1`, Recent `weight:1` | `["ratio","ratio"]` | sizes + open |
| `structure` | Accordion, **not** resizable | [StructurePanel.ts:138](frontend/src/dock/StructurePanel.ts#L138) | per table tab | 4 sections | — | open only |
| `explainDiagram` | Accordion, **not** resizable | [ExplainDiagramPanel.ts:141](frontend/src/dock/ExplainDiagramPanel.ts#L141) | per Diagram tab | 3 sections | — | open only |

Two facts the implementer must not "correct":

- **`database` / `roles` are mixed-unit** — the inspector is the app's flagship pin. `TreeExplorerView` never calls `setFillHeight`; `StructurePanel` is the only site that does ([StructurePanel.ts:150](frontend/src/dock/StructurePanel.ts#L150)), and it is not resizable. Adding `setFillHeight(true)` to `TreeExplorerView` would flip the inspector to `ratio` and silently discard every saved array.
- **The query split's result host takes no constraints at all** ([QueryPanel.ts:249](frontend/src/dock/QueryPanel.ts#L249)). An *unset* weight is flexible on `Split` (only an explicit `0` pins), so it is `ratio`. Do not add `{ weight: 1 }` "for clarity" — it changes nothing, but a hand added to that line invites someone to add `{ weight: 0 }` instead and flip the unit.

Every key is a **constant**, never derived from a `DbObjectRef`. An instanced site's key is shared by all its live panels: drag the editor/result gutter in one query tab and the next query tab you open adopts it. This is the intended reading of "global"; per-object keys would both explode `localStorage` and sit oddly beside the no-connection-segment decision.

---

## Public API

### `frontend/src/data/layoutStore.ts` (new)

```typescript
import type { LayoutSize, LayoutSizeUnit } from "@jimka/typescript-ui/layout";
import type { KeyValueStore }              from "./queryStore";

/** A persisted Split site. The string is the key segment under `sqladmin.layout.`. */
export type SplitSite = "shell" | "query" | "definition";

/** A persisted Accordion site. The string is the key segment under `sqladmin.layout.`. */
export type AccordionSite = "database" | "roles" | "queries" | "structure" | "explainDiagram";

/** One Split site's saved layout plus its save hooks, shaped to wire straight onto Split's events. */
export interface SplitLayoutBinding {
    /** The saved pane sizes, or null when absent, corrupt, or malformed. Read at restore time. */
    loadSizes:     () => LayoutSize[] | null;
    /** The saved collapsed pane indices; `[]` when absent or corrupt. */
    loadCollapsed: () => number[];
    /** Persist the sizes after a completed drag. Wire to `Split`'s `paneresize`. */
    onSizes:       (sizes: LayoutSize[]) => void;
    /** Persist one pane's collapsed flag. Wire to `Split`'s `panecollapse`. */
    onCollapse:    (index: number, collapsed: boolean) => void;
}

/** One Accordion site's saved layout plus its save hooks, shaped to wire straight onto Accordion's events. */
export interface AccordionLayoutBinding {
    /** The saved section sizes, or null when absent, corrupt, or malformed. Meaningful only for a resizable accordion. */
    loadSizes: () => LayoutSize[] | null;
    /** The saved open flags, falling back to the site's defaults. Length always equals the section count. */
    loadOpen:  () => boolean[];
    /** Persist the sizes after a completed gutter drag. Wire to `Accordion`'s `sectionresize`. */
    onSizes:   (sizes: LayoutSize[]) => void;
    /** Persist one section's open flag. Wire to `Accordion`'s `sectiontoggle`. */
    onToggle:  (index: number, open: boolean) => void;
}

/** Global (not per-connection) UI layout persistence, one key per site. */
export class LayoutStore {
    /** @param storage - The backing key-value store (localStorage or a fake). */
    constructor(storage: KeyValueStore);

    bindSplit(site: SplitSite): SplitLayoutBinding;
    bindAccordion(site: AccordionSite): AccordionLayoutBinding;
}
```

### Changed signatures

```typescript
// SqlAdminController — a public readonly field beside `dock` / `properties`;
// the sites reach it as `controller.layout`.
readonly layout: LayoutStore;

// DefinitionPanel
constructor(definition: string, columns: ColumnMeta[],
            onSave: (newDefinition: string) => void | Promise<void>,
            layout: SplitLayoutBinding);

// StructurePanel
constructor(columns: ColumnMeta[], structure: TableStructure,
            onOpenReferenced: (refSchema: string, refTable: string) => void,
            onOpenSequence: OpenSequenceHandler,
            layout: AccordionLayoutBinding,
            actions?: StructureActions);   // `layout` precedes the optional `actions`

// ExplainDiagramPanel
constructor(roots: ExplainPlanNode[], summary: ExplainSummary, layout: AccordionLayoutBinding);
// `summary` loses its `= {}` default — `layout` follows it, so it can no longer be optional.
// The sole call site (QueryPanel.ts:517) already passes `summary`.

// TreeExplorerConfig — one new required member
layout: AccordionLayoutBinding;

// DatabaseExplorerView / RolesExplorerView / QueriesView — unchanged signatures
// (controller, id); each builds its own binding from `controller.layout`.

// QueryPanelOptions — two new required members
splitLayout:          SplitLayoutBinding;      // the editor/result Split
explainDiagramLayout: AccordionLayoutBinding;  // the Explain diagram tab's info-column Accordion
```

---

## Internal Structure

### `layoutStore.ts` — the registry

```typescript
// Default open flags per Accordion site, in section order; the array length is
// also the site's section count. These mirror the `initiallyOpen` literals the
// sites carried before this store existed — keep them in step when a site's
// `sections:` array changes.
//
// There is deliberately no matching table for Split pane counts: the library
// validates a saved array's length AND its per-index units against the live
// layout and discards it whole, so an app-side length check would be a partial
// duplicate of a check it performs completely (see `## Architecture Decisions`).
// Open state has no library-side validation, which is why this table exists.
//
//   database/roles -> tree | inspector                      (shell/treeExplorerView.ts)
//   queries        -> Saved | Recent                        (shell/QueriesView.ts)
//   structure      -> Columns | Indexes | Constraints | FKs  (dock/StructurePanel.ts)
//   explainDiagram -> Summary | Plan tree | Plan steps       (dock/ExplainDiagramPanel.ts)
const ACCORDION_DEFAULT_OPEN: Record<AccordionSite, boolean[]> = {
    database:       [true, true],
    roles:          [true, true],
    queries:        [true, true],
    structure:      [true, false, false, false],
    explainDiagram: [true, true, false],
};

/** One site's stored blob. Every field optional — a site writes only what it has. */
interface StoredLayout {
    sizes?:     LayoutSize[];
    collapsed?: number[];
    open?:      boolean[];
}
```

### `layoutStore.ts` — the validators (module-private, mirroring `queryStore.readArray`)

```typescript
/** Whether one parsed entry is a well-formed {@link LayoutSize}. */
function isLayoutSize(value: unknown): value is LayoutSize {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const size = value as { unit?: unknown; value?: unknown };
    const unit = size.unit as LayoutSizeUnit;

    return (unit === "px" || unit === "ratio")
        && typeof size.value === "number"
        && Number.isFinite(size.value)
        && size.value >= 0;
}

/**
 * A saved size array, or null when it is not one.
 *
 * Shape only — deliberately **no length check and no unit expectation**. The
 * library re-validates length, per-index unit, and value on every restore entry
 * point and discards the whole array when it no longer fits the live layout;
 * duplicating half of that here would need a per-site pane-count table to keep
 * in sync and could only ever disagree. What the library does *not* absorb is a
 * non-array (its validator calls `.every()`), so that is exactly what this
 * guards.
 */
function readSizes(values: unknown): LayoutSize[] | null {
    if (!Array.isArray(values) || values.length === 0 || !values.every(isLayoutSize)) {
        return null;
    }

    return values.map(size => ({ ...size }));
}

/** The saved open flags, or a copy of `defaults` when absent, corrupt, or the wrong length. */
function readOpen(values: unknown, defaults: boolean[]): boolean[] {
    if (!Array.isArray(values) || values.length !== defaults.length
        || !values.every(v => typeof v === "boolean")) {
        return [...defaults];
    }

    return [...(values as boolean[])];
}

/** The saved collapsed pane indices, dropping any entry that is not a non-negative integer. */
function readCollapsed(values: unknown): number[] {
    if (!Array.isArray(values)) {
        return [];
    }

    return (values as unknown[]).filter(
        (v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0,
    );
}
```

### `layoutStore.ts` — the class

```typescript
bindSplit(site: SplitSite): SplitLayoutBinding {
    return {
        loadSizes    : () => readSizes(this._read(site).sizes),
        loadCollapsed: () => readCollapsed(this._read(site).collapsed),
        onSizes      : sizes => this._write(site, { sizes }),
        onCollapse   : (index, collapsed) => this._saveCollapsedPane(site, index, collapsed),
    };
}

bindAccordion(site: AccordionSite): AccordionLayoutBinding {
    const defaults = ACCORDION_DEFAULT_OPEN[site];

    return {
        loadSizes: () => readSizes(this._read(site).sizes),
        loadOpen : () => readOpen(this._read(site).open, defaults),
        onSizes  : sizes => this._write(site, { sizes }),
        onToggle : (index, open) => this._saveOpenSection(site, index, open, defaults),
    };
}

/** Add or drop one pane index in the site's collapsed set, leaving the others alone. */
private _saveCollapsedPane(site: SplitSite, index: number, collapsed: boolean): void {
    if (index < 0) {
        return;
    }

    const current = readCollapsed(this._read(site).collapsed);
    const next    = collapsed
        ? [...new Set([...current, index])].sort((a, b) => a - b)
        : current.filter(i => i !== index);

    this._write(site, { collapsed: next });
}

/** Set one section's open flag, leaving the site's other sections alone. */
private _saveOpenSection(site: AccordionSite, index: number, open: boolean, defaults: boolean[]): void {
    const next = readOpen(this._read(site).open, defaults);

    if (index < 0 || index >= next.length) {
        return;
    }

    next[index] = open;

    this._write(site, { open: next });
}

/** The site's stored blob; `{}` when absent, unparsable, or not a JSON object. */
private _read(site: string): StoredLayout {
    const raw = this._storage.getItem(LAYOUT_KEY_PREFIX + site);

    if (raw === null) {
        return {};
    }

    try {
        const parsed: unknown = JSON.parse(raw);

        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as StoredLayout)
            : {};
    } catch {
        return {};
    }
}

/** Merge `patch` into the site's blob. A corrupt blob repairs itself — `_read` yields `{}`. */
private _write(site: string, patch: StoredLayout): void {
    this._storage.setItem(LAYOUT_KEY_PREFIX + site, JSON.stringify({ ...this._read(site), ...patch }));
}
```

### The two wiring shapes

```typescript
// Static-pane Split (definition; the shell adds its rail guard) — declarative.
const layout = controller.layout.bindSplit("definition");
const body   = Container({ layoutManager: new Split({
    orientation   : "vertical",
    paneSizes     : layout.loadSizes() ?? undefined,
    collapsedPanes: layout.loadCollapsed(),
    listeners     : { paneresize: layout.onSizes, panecollapse: layout.onCollapse },
}) });

// Resizable Accordion (database, roles, queries) — `initiallyOpen` pre-super,
// sizes post-super (AccordionPanel has no `sectionSizes` passthrough; the
// library plan makes that an explicit non-goal, and `getAccordion()` is the
// documented way in).
const open = config.layout.loadOpen();          // local, pre-super()

super({
    id,
    resizable: true,
    sections : [
        { label: "…", component: tree,      initiallyOpen: open[0], weight: 1 },  // ratio
        { label: "…", component: inspector, initiallyOpen: open[1] },             // unweighted -> px
    ],
    onSectionToggle: config.layout.onToggle,
});

const accordion = this.getAccordion();
const saved     = config.layout.loadSizes();

if (saved !== null) {
    accordion.applySectionSizes(saved);
}

accordion.on("sectionresize", config.layout.onSizes);
```

---

## Ordered Implementation Steps

1. **Gate on the library.** In `/home/jika/typescript/typescript-ui`, all three must hit:
   - `grep -n "isResizePinnedMain" src/typescript/lib/layout/Split.ts` (`split-weight-pin-refill`)
   - `grep -n "_resizePinned" src/typescript/lib/layout/Accordion.ts` (`accordion-resize-weight`)
   - `grep -n "getPaneSizes" src/typescript/lib/layout/Split.ts` (`layout-state-api`)

   If any misses, **stop** — that plan is not implemented and nothing below compiles. Then run `npm run build:lib` there (NOT `npm run build`) so sqladmin's symlinked `dist/lib` carries the new API. → verify from sqladmin: `grep -rl "getPaneSizes" frontend/node_modules/@jimka/typescript-ui/` is non-empty.

2. **The `fillWeight` → `weight` rename** — five lines, mechanical, no behaviour change. This step is **independent of every step below** and may be applied on its own the moment `accordion-resize-weight` lands (see `## Potential Challenges`).
   Code — the five `AccordionSectionConfig` entries, `fillWeight: 1` → `weight: 1`:
   - [treeExplorerView.ts:80](frontend/src/shell/treeExplorerView.ts#L80) (the tree section; the inspector at :81 has **no** weight and must stay that way).
   - [QueriesView.ts:136](frontend/src/shell/QueriesView.ts#L136) and [:137](frontend/src/shell/QueriesView.ts#L137).
   - [ExplainDiagramPanel.ts:146](frontend/src/dock/ExplainDiagramPanel.ts#L146) and [:147](frontend/src/dock/ExplainDiagramPanel.ts#L147).

   Prose — seven comments naming `fillWeight`, reworded to `weight`:
   - [treeExplorerView.ts:45](frontend/src/shell/treeExplorerView.ts#L45), [:65](frontend/src/shell/treeExplorerView.ts#L65), [:74](frontend/src/shell/treeExplorerView.ts#L74).
   - [QueriesView.ts:49](frontend/src/shell/QueriesView.ts#L49), [:132](frontend/src/shell/QueriesView.ts#L132), [:315](frontend/src/shell/QueriesView.ts#L315).
   - [ExplainDiagramPanel.ts:139](frontend/src/dock/ExplainDiagramPanel.ts#L139).

   → verify: `grep -rn "fillWeight" frontend/src/` — expect **zero** matches; `cd frontend && npx tsc --noEmit` clean.

3. **Create `frontend/tests/data/layoutStore.test.ts`** covering `## Expected Behaviour` 1-21, copying the `fakeStorage()` helper verbatim from [tests/data/notesStore.test.ts:6](frontend/tests/data/notesStore.test.ts#L6). → verify: `npx vitest run tests/data/layoutStore.test.ts` fails to resolve the module (red).

4. **Create `frontend/src/data/layoutStore.ts`** per `## Public API` and `## Internal Structure`: a header comment in the shape of [notesStore.ts:1-6](frontend/src/data/notesStore.ts#L1) stating the global-not-per-connection choice **and** the shape-vs-fit division of labour; the two `import type` lines and **nothing else**; `LAYOUT_KEY_PREFIX = "sqladmin.layout."`; the two site unions, `ACCORDION_DEFAULT_OPEN`, `StoredLayout`, the four validators, the two binding interfaces, and `LayoutStore`. JSDoc every exported symbol and every method. → verify: `npx vitest run tests/data/layoutStore.test.ts` passes; `grep -c "^import type" frontend/src/data/layoutStore.ts` → `2`; `grep -c "^import {" frontend/src/data/layoutStore.ts` → `0` (a value import of `LayoutSize` would pull a DOM-touching module into the node vitest — and `verbatimModuleSyntax` makes it a compile error anyway).

5. **`SqlAdminController.ts`** — import `LayoutStore` from `./data/layoutStore`; add `readonly layout: LayoutStore;` to the public field block beside `rolesProperties` ([:150-153 region](frontend/src/SqlAdminController.ts#L150)); construct it in the store block after [:257](frontend/src/SqlAdminController.ts#L257) as `this.layout = new LayoutStore(window.localStorage);`, with a comment noting it takes **no** `connectionId` — layout is global by design, unlike the three stores above it. It is public (not private-with-delegators like `_history`) because eight sites bind against it and mirroring the whole store API onto the controller would carry no information.

6. **`frontend/src/shell/SqlAdminShell.ts`** — two edits in `buildWorkArea` ([:187](frontend/src/shell/SqlAdminShell.ts#L187)), **(a)** the Split wiring and **(b)** the `expand()` simplification. Both are correct **only** after `split-weight-pin-refill` has landed and `build:lib` has run — which step 1 already gated, so this step is safe by construction. Do not apply (b) against an unfixed library: it reintroduces the exact collapse/expand decay `split-weight-pin-refill` cures.

   **(a)** Replace [:188](frontend/src/shell/SqlAdminShell.ts#L188) with:

   ```typescript
   const layout = controller.layout.bindSplit("shell");
   const split  = new Split({
       orientation: "horizontal",
       paneSizes  : layout.loadSizes() ?? undefined,
       // No panecollapse/collapsedPanes: the sidebar is `collapsible: false` and
       // is the only pane the single gutter serves, so `setPaneCollapsed` can
       // never fire here. The rail collapse is ActivityBar state (a min/max pin),
       // not Split collapse.
       listeners  : {
           // Skip the save while the rail is collapsed: the pin holds the pane at
           // SIDEBAR_RAIL_WIDTH, so a drag would persist the rail width and the
           // next session — which restores the sidebar expanded, the rail's own
           // collapsed state not being persisted — would open it rail-narrow.
           // Same guard, same constant, same reason as collapse()'s lastWidth
           // capture below.
           paneresize: sizes => {
               if (sizes[0].value > SIDEBAR_RAIL_WIDTH) {
                   layout.onSizes(sizes);
               }
           },
       },
   });
   ```

   Leave `collapse()` ([:210-223](frontend/src/shell/SqlAdminShell.ts#L210)) untouched: it reads the live pane size, so it captures a restored width for free, and its `current > SIDEBAR_RAIL_WIDTH` guard is what (a)'s save hook mirrors.

   **(b)** Simplify `expand()` ([:224-244](frontend/src/shell/SqlAdminShell.ts#L224)). Today it restores **both** panes — `total = getPaneSize(pane) + getPaneSize(center)`, then `setPaneSize(pane, lastWidth)` **and** `setPaneSize(center, total - lastWidth)` — to defeat a proportional refill that, pre-fix, shrank the weight-0 sidebar below `lastWidth` and compounded every cycle. That premise is the `split-weight-pin-refill` bug: the sidebar is `{ weight: 0 }`, so post-fix the refill holds it in the pinned tier and only the Dock (`center`, `weight: 1`) reclaims the freed width. So the `center` rebalance is now dead weight. Reduce the two `setPaneSize` calls and the `total` read to a single `split.setPaneSize(pane, lastWidth);`, and **replace the stale comment** — the "Both panes are flexible once expanded…" justification is now false and would mislead — with: the sidebar is `weight: 0`, so `split-weight-pin-refill`'s refill pins it at `lastWidth` and the flexible Dock alone absorbs the freed width; setting `center` is unnecessary. **Keep `body.doLayout()`**: `Split.setPaneSize` is a raw primitive (`this._sizes.set(pane, size); return this;` — verified in the library source) that does **not** reschedule a layout, so the explicit `doLayout()` is still required to apply the new size. The result:

   ```typescript
   expand(): void {
       // Unpin (max unbounded → draggable again), keep the rail floor.
       pane.setMaxSize(UNBOUNDED, UNBOUNDED);
       pane.setMinSize(SIDEBAR_RAIL_WIDTH, 0);

       // Reopen to the remembered width. The sidebar is weight-0, so
       // `split-weight-pin-refill`'s refill pins it here and the flexible Dock
       // alone reclaims the freed width — no need to set `center` too (which the
       // pre-fix proportional refill required to stop the sidebar decaying below
       // lastWidth). setPaneSize does not reschedule, so lay out explicitly.
       split.setPaneSize(pane, lastWidth);
       body.doLayout();
   }
   ```

7. **`frontend/src/dock/DefinitionPanel.ts`** — add the `layout: SplitLayoutBinding` 4th constructor param (JSDoc it) and apply the static-pane wiring shape at [:75](frontend/src/dock/DefinitionPanel.ts#L75). In `SqlAdminController.ts` [:500](frontend/src/SqlAdminController.ts#L500), pass `this.layout.bindSplit("definition")`.

8. **`frontend/src/dock/StructurePanel.ts`** — add `layout: AccordionLayoutBinding` **before** the optional `actions` param (JSDoc it). At [:138](frontend/src/dock/StructurePanel.ts#L138), take `const open = layout.loadOpen();` above the `new AccordionPanel({…})` and replace the four `initiallyOpen:` literals with `open[0]`…`open[3]`, keeping the existing "Only Columns opens by default" comment and extending it to point at `ACCORDION_DEFAULT_OPEN` in `data/layoutStore.ts`. Add `onSectionToggle: layout.onToggle` to the options bag. Wire **no** sizes — this accordion is not `resizable`. In `SqlAdminController.ts` [:619](frontend/src/SqlAdminController.ts#L619), pass `this.layout.bindAccordion("structure")` as the 5th argument, before `actions`.

9. **`frontend/src/dock/ExplainDiagramPanel.ts`** — add `layout: AccordionLayoutBinding` as the 3rd constructor param and drop `summary`'s `= {}` default (a required param cannot follow an optional one). At [:141](frontend/src/dock/ExplainDiagramPanel.ts#L141), take `const open = layout.loadOpen();` (still pre-`super()`, alongside the other locals), replace the three `initiallyOpen:` literals with `open[0]`…`open[2]`, and add `onSectionToggle: layout.onToggle`. Wire **no** sizes — not `resizable`. (Step 2 already renamed this file's two `weight: 1` entries; leave them.)

10. **`frontend/src/dock/QueryPanel.ts`** — four edits:
    - Add `splitLayout: SplitLayoutBinding` and `explainDiagramLayout: AccordionLayoutBinding` to `QueryPanelOptions` (both required; JSDoc each), and destructure them with the other options at [:189](frontend/src/dock/QueryPanel.ts#L189).
    - At [:188](frontend/src/dock/QueryPanel.ts#L188), add only `listeners: { paneresize: splitLayout.onSizes, panecollapse: splitLayout.onCollapse }`. Add a comment stating why `paneSizes`/`collapsedPanes` are **deliberately absent** (the split has one child at first layout; the once-only drain would discard the 2-entry array on length and never retry — see `## Architecture Decisions`).
    - Add `restoreOrSeedPanes()` next to `seedEditorHeight` ([:313](frontend/src/dock/QueryPanel.ts#L313)) and call it from `ensureResultPaneShown` ([:251](frontend/src/dock/QueryPanel.ts#L251)) **in place of** `seedEditorHeight()`, leaving `seedEditorHeight` itself unchanged as the no-saved-state branch:

      ```typescript
      /**
       * Restore the saved editor/result split, else fall back to the EDITOR_HEIGHT
       * seed. Called once per hidden->shown transition, when both panes exist —
       * the Split's own `paneSizes`/`collapsedPanes` options cannot serve here
       * (see the constructor's comment). `applyPaneSizes` needs no laid-out
       * container (it falls back to a unit base and the first real layout hands
       * the whole delta to the flexible result host), so this needs none of
       * `seedEditorHeight`'s onFirstLayout retry. It is also strict: a stale array
       * is discarded by the library and the panes fall to normal first-layout
       * sizing rather than the seed — narrow, and it self-heals on the next drag.
       */
      function restoreOrSeedPanes(): void {
          const sizes = splitLayout.loadSizes();

          if (sizes === null) {
              seedEditorHeight();

              return;
          }

          split.applyPaneSizes(sizes);

          for (const index of splitLayout.loadCollapsed()) {
              split.setPaneCollapsedImmediate(index, true);
          }
      }
      ```
    - At [:517](frontend/src/dock/QueryPanel.ts#L517), pass `explainDiagramLayout` as `new ExplainDiagramPanel(roots, summary, explainDiagramLayout)`.

    In `SqlAdminController.ts` [:1963](frontend/src/SqlAdminController.ts#L1963), add `splitLayout: this.layout.bindSplit("query")` and `explainDiagramLayout: this.layout.bindAccordion("explainDiagram")` to the options bag.

11. **`frontend/src/shell/treeExplorerView.ts`** — add `layout: AccordionLayoutBinding` to `TreeExplorerConfig` (JSDoc it) and apply the resizable-Accordion wiring shape at [:71-83](frontend/src/shell/treeExplorerView.ts#L71): `const open = config.layout.loadOpen();` pre-`super()`; `initiallyOpen: open[0]` / `open[1]`; `onSectionToggle: config.layout.onToggle` in the options; then post-`super()`, `applySectionSizes` when `loadSizes()` is non-null, and `on("sectionresize", config.layout.onSizes)` beside the existing `setCompact` / `setToolsVisibility` calls. Keep the tree's `weight: 1` and the inspector's **absence** of a weight exactly as step 2 left them — that asymmetry is what makes the inspector the `px` entry. Do **not** add `setFillHeight`. A restore overwrites the fill seed because the library drains pending sizes *before* `computeResizableHeights`'s seed loop, which only writes an unset entry.

12. **`frontend/src/shell/DatabaseExplorerView.ts` / `RolesExplorerView.ts`** — each adds `layout: controller.layout.bindAccordion("database")` / `("roles")` to its `super({…})` config. Signatures unchanged.

13. **`frontend/src/shell/QueriesView.ts`** — apply the same resizable-Accordion shape at [:129](frontend/src/shell/QueriesView.ts#L129) with `controller.layout.bindAccordion("queries")`, hanging the post-`super()` calls off the existing `const accordion = this.getAccordion();` at [:141](frontend/src/shell/QueriesView.ts#L141). Both sections keep `weight: 1`, so both entries are `ratio`. Leave `setQueriesSectionFocus` ([:150](frontend/src/shell/QueriesView.ts#L150)) alone — its `openSection` emits `sectiontoggle` and therefore persists the open, which is correct.

14. **`frontend/src/shell/localStorageWindow.ts`** — comment-only. The header ([:11-15](frontend/src/shell/localStorageWindow.ts#L11)) claims the app's state is "exactly the `sqladmin.*` keys (query history + saved queries)" that "are read fresh on each access, so removing them here needs no cache invalidation". Both halves are now wrong: add notes and layout to the list, and record that a live Split/Accordion keeps its geometry after a clear — the reset lands on reload, and a subsequent drag re-creates the key. Update `APP_KEY_PREFIX`'s comment ([:26](frontend/src/shell/localStorageWindow.ts#L26)) to cite `data/layoutStore.ts` too. **No code change** — `sqladmin.layout.*` is already dumped and cleared by the prefix.

15. **`LIBRARY_NOTES.md`** — correct the existing `Split.setPaneSize` entry per `## Documentation Impact`. Do **not** add a new entry.

16. **Verify** per `## Verification`. → regression checks: `grep -rn "fillWeight" frontend/src/` and `grep -rn "initiallyOpen: true\|initiallyOpen: false" frontend/src/` — both expect **zero** matches.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/data/layoutStore.ts` |
| Create | `frontend/tests/data/layoutStore.test.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |
| Modify | `frontend/src/shell/treeExplorerView.ts` |
| Modify | `frontend/src/shell/DatabaseExplorerView.ts` |
| Modify | `frontend/src/shell/RolesExplorerView.ts` |
| Modify | `frontend/src/shell/QueriesView.ts` |
| Modify | `frontend/src/shell/localStorageWindow.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/src/dock/DefinitionPanel.ts` |
| Modify | `frontend/src/dock/StructurePanel.ts` |
| Modify | `frontend/src/dock/ExplainDiagramPanel.ts` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

### Unit-testable — node vitest, in-memory fake (`frontend/tests/data/layoutStore.test.ts`)

`layoutStore.ts` imports only types, so all of this runs DOM-less. Write `LayoutSize` literals inline (`{ unit: "px", value: 280 }`).

1. `bindSplit("shell").loadSizes()` on empty storage → `null`; `loadCollapsed()` → `[]`.
2. **Mixed units round-trip verbatim.** `onSizes([{unit:"px",value:280},{unit:"ratio",value:1}])` then `loadSizes()` deep-equals the same array — the unit tags survive, unwrapped by nothing.
3. The key is exactly `sqladmin.layout.shell` — **no connection segment** (contrast `sqladmin.notes.default`). Assert on `storage.map`.
4. The stored value is one JSON object per site: after `onSizes([…])` and `onCollapse(0, true)`, `sqladmin.layout.shell` parses to `{ sizes: […], collapsed: [0] }` — the second write **merges**, it does not replace.
5. Corrupt JSON (`storage.map.set("sqladmin.layout.shell", "{not json")`) → `loadSizes()` → `null`, `loadCollapsed()` → `[]`, no throw.
6. A top-level JSON array or string (`"[1,2]"`, `"\"hi\""`) → treated as absent: `loadSizes()` → `null`.
7. A write over a corrupt blob repairs it: with `"{not json"` stored, `onSizes([{unit:"px",value:1}])` then `loadSizes()` → that array.
8. **A non-array `sizes` is rejected** — `{sizes: "nope"}`, `{sizes: 5}`, `{sizes: {}}` → `null`. (This is the one shape the library's `.every()` would throw on; the rest it discards cleanly.)
9. **A malformed entry rejects the whole array** — `{sizes: [{unit:"px",value:1}, null]}` → `null`; `[{unit:"bogus",value:1}]` → `null`; `[{unit:"px"}]` → `null`; `[5]` → `null`; `[{unit:"px",value:NaN}]` → `null`; `[{unit:"px",value:-1}]` → `null`.
10. `{sizes: []}` → `null` (an empty array can restore nothing).
11. **No length check.** `bindSplit("shell").loadSizes()` on a stored **3**-entry well-formed array returns all **3** entries, even though the shell has 2 panes. The store does not know or care; the library's `isRestorableSizes` discards it. This pins the shape-vs-fit division — a length check here would need a per-site pane-count table and could only half-duplicate the library.
12. **No unit expectation.** `[{unit:"ratio",value:0.5},{unit:"ratio",value:0.5}]` loads fine from `"shell"` even though the shell's live units are `["px","ratio"]`. Same reason.
13. `{sizes: [{unit:"px",value:0},{unit:"ratio",value:0}]}` → **loads** (all-zero is the library's discard rule, not the store's).
14. `bindAccordion("structure").loadOpen()` on empty storage → `[true, false, false, false]`; `bindAccordion("database").loadOpen()` → `[true, true]`; `bindAccordion("explainDiagram").loadOpen()` → `[true, true, false]`.
15. Wrong-length open → defaults: `{open: [true, true]}` on `structure` → `[true, false, false, false]`.
16. Non-boolean entries → defaults: `{open: [1, 0, 0, 0]}` on `structure` → `[true, false, false, false]`.
17. `onToggle(1, true)` on `structure` then `loadOpen()` → `[true, true, false, false]`; the other indices are untouched.
18. **`onToggle` is index-scoped, not array-flush.** Two independent bindings for `structure`; `a.onToggle(1, true)` then `b.onToggle(0, false)` → `loadOpen()` → `[false, true, false, false]`. `b` must not clobber `a`'s index 1 with its stale view. (This is the two-open-tabs case.)
19. `onToggle(9, true)` / `onToggle(-1, true)` on `structure` → `loadOpen()` unchanged.
20. `onCollapse(0, true)` then `onCollapse(1, true)` → `loadCollapsed()` → `[0, 1]` (sorted); a repeat `onCollapse(0, true)` does not duplicate; `onCollapse(0, false)` → `[1]`; `onCollapse(-1, true)` is ignored. `{collapsed: [0, 1.5, "x", -2]}` → `[0]`.
21. Sites do not cross-read: `bindSplit("query").onSizes([…])` leaves `bindSplit("shell").loadSizes()` → `null`. And a loader is a **live read, not a construction snapshot**: with a binding held, `onSizes(x)` then `loadSizes()` on that same binding → `x`.

### Manual verification (no automated coverage possible)

sqladmin's vitest is node-only and typescript-ui's UI modules touch `document` at import scope, so **no site wiring is unit-testable here**. Each item is drag, geometry, or reload behaviour the harness cannot exercise. Verify against a running app (`/verify`).

22. **The headline: a pinned pane restores at its exact px, at any window size.** Drag the shell sidebar to ~400px. Resize the browser window narrower, then wider — the sidebar stays at 400px (this is `split-weight-pin-refill`). Reload **at a different window size** → the sidebar is **exactly ~400px**, not a scaled fraction.
23. Run a query, drag the editor/result gutter → reload, run a query → the editor opens at exactly the dragged height.
24. **No saved state → the old behaviour is unchanged**: clear `sqladmin.layout.query`, reload, run a query → the editor seeds at `EDITOR_HEIGHT` exactly as before.
25. Collapse the query editor via the gutter chevron → reload, run a query → the editor is still collapsed.
26. **The rail guard.** Collapse the sidebar via the rail icon, drag the gutter, reload → the sidebar opens at its previous **expanded** width (or the default), **never** rail-narrow. Then confirm `sqladmin.layout.shell` never holds a `px` value equal to `SIDEBAR_RAIL_WIDTH`.
27. **The mixed-unit accordion.** In the Database rail, drag the tree/inspector gutter so the inspector is ~300px. Resize the window taller and shorter — the inspector holds ~300px while the tree absorbs (this is `accordion-resize-weight`). Reload at a different window height → the inspector is **exactly ~300px**. Repeat for Roles.
28. **The all-ratio accordion.** In the Queries rail, drag Saved/Recent to ~3:1 → reload at a different window height → the **proportion** is preserved (both sections are weighted, so both persist as ratios).
29. Collapse the Database rail's inspector section → reload → still collapsed.
30. Open a table's Structure tab, expand Indexes → reload, reopen → Indexes is open, Columns still open.
31. Open **two** different tables' Structure tabs; expand Indexes in one and collapse Columns in the other → reload → both changes survive (the index-scoped write).
32. Open a Diagram tab from an Explain plan, expand Plan steps → reload, reopen → Plan steps is open.
33. Tools ▸ Local Storage lists the `sqladmin.layout.*` keys with no code change, and their values show the `{"unit":"px","value":…}` entries; "Clear SQL Admin data" removes them; reload → every site is back to its default.
34. Hand-edit `sqladmin.layout.database` to `{"sizes":[{"unit":"ratio","value":9}],"open":"nope"}` → reload → the rail renders at its defaults, no console error, no dialog. (The store rejects `open`; the library discards `sizes` on length.)
35. **The unit check does the migration's job.** Hand-edit `sqladmin.layout.shell` to `{"sizes":[{"unit":"ratio","value":0.3},{"unit":"ratio","value":0.7}]}` — the shape a ratio-only release would have written — → reload → the sidebar falls back to its normal first-layout width, with no error and no trace of 0.3.
36. Sign out, log in against a different database → the layout is **unchanged** (global, not per-connection).
37. One drag writes the key **once** — watch the key in the inspector across a slow drag; it must not churn per frame.
38. **Collapse/expand holds `lastWidth` with no decay (step 6b).** Drag the sidebar to a distinctive width (e.g. ~280px). Collapse and expand the rail via the rail icon **repeatedly — at least four cycles**. The sidebar must return to **exactly** its pre-collapse width every time, never decaying (the pre-fix sequence was 280 → 226 → 190 → 165, compounding each cycle). This exercises the simplified `expand()`: only `setPaneSize(pane, lastWidth)` runs, and `split-weight-pin-refill`'s refill must hold the weight-0 sidebar at that px while the Dock alone absorbs. **Not unit-testable** — it is `ActivityBar`-driven collapse/expand over real `Split` geometry, which the node vitest (no DOM) cannot drive; it belongs to the same DOM/drag manual class as the cases above.

---

## Verification

- `cd frontend && npx tsc --noEmit` (in a worktree, symlink first: `ln -s /home/jika/typescript/sqladmin/frontend/node_modules <worktree>/frontend/node_modules`).
- `cd frontend && npx vitest run tests/data/layoutStore.test.ts` — behaviours 1-21.
- `cd frontend && npx vitest run` — the full suite; no existing test touches layout, so all must stay green.
- `grep -rn "fillWeight" frontend/src/` — expect zero matches.
- `grep -rn "initiallyOpen: true\|initiallyOpen: false" frontend/src/` — expect zero matches.
- `grep -c "^import type" frontend/src/data/layoutStore.ts` — expect `2`; `grep -c "^import {" frontend/src/data/layoutStore.ts` — expect `0`.
- `grep -rn "serializeLayout\|restoreLayout\|getPaneRatios\|applyPaneRatios" frontend/src/` — expect zero matches. The ratio surface is `LayoutSerialization`'s and restores a pinned pane at the wrong px.
- `grep -rn "SPLIT_PANES" frontend/src/` — expect zero matches (the length check belongs to the library).
- Manual: behaviours 22-37 against a running app. Entry points — the shell sidebar gutter and the rail icon; a query tab (Run, then the editor/result gutter and its chevron); a table's Structure tab; the Database / Roles / Queries rails; a Diagram tab; Tools ▸ Local Storage.

---

## Documentation Impact

sqladmin publishes no API docs, so there is no doc site, barrel, or catalog to update. Two in-repo docs change:

- **`LIBRARY_NOTES.md`** — **correct the existing entry; add no new one.** The `✂️ Usage note: Split.setPaneSize is a raw, relative primitive` entry ([:81](LIBRARY_NOTES.md#L81)) is partly invalidated by `split-weight-pin-refill`, and leaving it would directly contradict this plan's premise. Precisely:
  - Its headline advice **survives** — `setPaneSize` still seeds one pane without rebalancing siblings.
  - Its **diagnosis is now wrong**. The compounding sidebar decay it records (`280 → 226 → 190 → 165 → …`) is attributed to "the proportional refill" acting as designed. That decay *was* the weight-0 refill bug: the sidebar is `{ weight: 0 }`, and the refill classified it flexible because it tested only `min == max`. Post-fix it is a soft pin and holds.
  - Its **verdict is now wrong**. "**Not a library gap**" was mistaken — the gap was real, in `recalculateSizes`' refill, and is fixed upstream.
  - So: retitle to the `✅ Fixed in library` status and rewrite the entry to say the decay was a library bug (weight-0 panes rescaled by the pin-aware refill, fixed by `split-weight-pin-refill`'s three-tier cascade), and that the app's apportion-both-panes `expand()` workaround **has been removed** as part of this plan (step 6b) — a lone `setPaneSize(sidebar, lastWidth)` now holds, because the fixed refill pins the weight-0 sidebar and the flexible Dock absorbs the freed width. The entry must **not** be left describing the two-pane rebalance as "the fix", because that code no longer exists; point instead at the library refill fix. Keep the surviving "apportion all panes" guidance for the general `setPaneSize` case — a caller forcing a *flexible* pane to a size still has to apportion its siblings; only the weight-0-pin case is now handled by the library.
  - **No new drift entry.** The previous revision of this plan logged the ratio-vs-px contract mismatch as an accepted papercut. The user chose to fix it at the source instead (`LayoutSize`'s per-entry unit), so there is nothing left to log — the concession is obsolete, not merely reworded.
- **`frontend/COMPONENT_CONVENTIONS.md`** — no change. This plan adds no builder→class-first conversion; the binding hooks are arrow properties on a plain object literal, which section (c) already covers.

---

## Potential Challenges

- **Three library plans must land, in order, and then `build:lib`.** `split-weight-pin-refill` + `accordion-resize-weight` → `layout-state-api` → this plan. A *partial* landing is the dangerous case: `layout-state-api`'s capture will not compile without the other two's predicates, but its own plan notes that a half-landed `accordion-resize-weight` (no `_resizePinned` drag-scale fix) would compile and silently mis-scale a dragged pin. Mitigation: step 1 greps for a symbol from each of the three, not just the last.
- **The rename break has its own window, earlier than this plan.** The moment `accordion-resize-weight` lands and someone runs `build:lib`, sqladmin's `tsc` fails on five `fillWeight` errors — possibly well before `layout-state-api` exists to unblock the rest of this plan. Mitigation: step 2 is self-contained and depends on nothing else here; apply it alone to unbreak the app, and return for steps 3+ once `layout-state-api` lands.
- **QueryPanel's dynamic pane count defeats both restore options.** The once-only drain fires when the editor is the split's only child. Mitigation: the imperative `restoreOrSeedPanes` path (step 10). Do not "fix" it by adding `paneSizes` to the constructor — it will silently never apply.
- **A stale array at QueryPanel falls to normal first-layout sizing, not the `EDITOR_HEIGHT` seed.** `applyPaneSizes` discards silently and returns `this`, so `restoreOrSeedPanes` cannot tell a rejected restore from an accepted one and has already skipped the seed. Only reachable when the split's pane count or the editor's `weight: 0` changes in code between releases; it self-heals on the next drag. Mitigation: accept. Detecting it would mean re-deriving the live units app-side, which is exactly the double-handling the shape-vs-fit decision forbids.
- **`ACCORDION_DEFAULT_OPEN` must track its sites.** Adding a fifth Structure section without extending the table leaves `open[4] === undefined` (that section falls to the library default) and — for a resizable site — discards every saved array on length. It degrades safely but silently. Mitigation: the table's comments name each site's file and section order, and each site's comment points back; there is no DOM-free way to assert the link. Note this hazard no longer applies to Splits at all: `SPLIT_PANES` is gone.
- **Concurrent panels of one site.** Two query tabs share `sqladmin.layout.query`. Collapse and toggle are index-scoped read-modify-writes so they compose; sizes are whole-array and last-writer-wins by design. A live panel is never re-laid-out by another's save — restore happens at construction (or first result) only. Intended: the key is the site, not the object.
- **A pin captured while yielding carries a scaled value.** Inherited from `layout-state-api`'s own challenge list: if the Database rail's viewport is so short that the inspector's pin alone overruns the budget, the pin yields, and a drag *at that moment* writes a `_resizeFactor`-scaled value still tagged `px`. Narrow (drag while the window is that short), self-heals on the next drag at a normal size, and the library deliberately rejects the alternative (tagging the unit from transient state would lose the px for good). Mitigation: none app-side; do not try to compensate.
- **"Clear SQL Admin data" does not reset the live layout.** The keys go, but the on-screen Splits keep their dragged geometry and the next drag re-creates the key. Mitigation: none — the reset lands on reload; step 14 corrects the window's comment, which currently claims otherwise.
- **`ExplainDiagramPanel`'s `summary = {}` default is dropped.** A required `layout` cannot follow an optional param. The sole call site already passes `summary` ([QueryPanel.ts:517](frontend/src/dock/QueryPanel.ts#L517)), so this is source-compatible; `tsc` catches it if not.

---

## Critical Files

- [`/home/jika/typescript/typescript-ui/plans/layout-state-api.md`](/home/jika/typescript/typescript-ui/plans/layout-state-api.md) — **the API contract.** Read `## Public API` and `## Consumer contract summary` before writing any wiring. Its *"Units: the unit follows the weight"* decision is this plan's foundation.
- [`/home/jika/typescript/typescript-ui/plans/accordion-resize-weight.md`](/home/jika/typescript/typescript-ui/plans/accordion-resize-weight.md) — defines a pinned section (`effectiveWeight === 0`: `weight` unset-or-`0` **and** `fillHeight` off), and owns the `fillWeight` → `weight` rename this plan applies app-side.
- [`/home/jika/typescript/typescript-ui/plans/split-weight-pin-refill.md`](/home/jika/typescript/typescript-ui/plans/split-weight-pin-refill.md) — defines a pinned pane (`isResizePinnedMain`: an **explicit** `weight: 0`; unset stays flexible) and is why a px capture is stable. Its hard-pin (`min == max`) vs soft-pin distinction is what leaves the rail collapse untouched.
- [`frontend/src/data/queryStore.ts`](frontend/src/data/queryStore.ts) — **the precedent.** `KeyValueStore` (:13), the corrupt-tolerant `readArray` (:59), the key-prefix constant (:47), and `SavedQueryStore`'s read-modify-write `save` (:150).
- [`frontend/src/data/notesStore.ts`](frontend/src/data/notesStore.ts) — the smallest store, and the header-comment shape to copy.
- [`frontend/tests/data/notesStore.test.ts`](frontend/tests/data/notesStore.test.ts) — the `fakeStorage()` helper (:6) and the key-assertion idiom (:53), to mirror verbatim.
- [`frontend/tsconfig.json`](frontend/tsconfig.json) — `verbatimModuleSyntax: true`, which makes the `import type` of `LayoutSize` compiler-enforced rather than a convention.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) — `QueryPanelOptions` and its *"the store dependency stays here"* stance ([SqlAdminController.ts:1971](frontend/src/SqlAdminController.ts#L1971)); the Split (:188), `ensureResultPaneShown` (:247), `seedEditorHeight` (:313), `hideResultPane` (:337), and the `ExplainDiagramPanel` construction (:517).
- [`frontend/src/shell/SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts) — `buildWorkArea` (:187), the `collapsible: false` pane (:198), and the `SidebarSizer` collapse/expand block (:209-245): read `collapse()`'s `current > SIDEBAR_RAIL_WIDTH` guard (:214), which step 6a's save guard mirrors, and `expand()`'s two-pane rebalance (:240-243), which step 6b reduces to a single `setPaneSize(pane, lastWidth)` once the library refill pins the weight-0 sidebar.
- [`frontend/src/shell/treeExplorerView.ts`](frontend/src/shell/treeExplorerView.ts) — the `resizable: true` accordion (:71) shared by both rails, the tree/inspector weight asymmetry (:80-81) that makes the inspector the `px` entry, and the `TREE_MIN_HEIGHT` rationale (:38-47).
- [`frontend/src/shell/localStorageWindow.ts`](frontend/src/shell/localStorageWindow.ts) — `APP_KEY_PREFIX` (:29) and `clearAppKeys` (:79), which already cover the new keys.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — (b) the super-cascade trap (every `loadOpen()` read is a pre-`super()` local) and (c) by-reference handlers must be arrows.
- [`LIBRARY_NOTES.md`](LIBRARY_NOTES.md) — the entry format, and the `Split.setPaneSize` note (:81) this plan corrects.
- [`~/.claude/CODE_CONVENTIONS.md`](~/.claude/CODE_CONVENTIONS.md) — blank-line rules around multi-line statements, JSDoc-never-repeats-types, and documented magic numbers.

---

## Non-Goals

- **`serializeLayout` / `restoreLayout` adoption**, and `getPaneRatios` / `applyPaneRatios`. Rejected on four independent grounds, and the library plan independently forbids the ratio surface for session persistence. Do not reintroduce either "since it's already there".
- **Persisting Dock layout** — which panels are open, tab order, tear-off window rects. A much larger feature, and the one thing `LayoutSerialization` *is* the right tool for. Out of scope entirely.
- **Persisting the shell sidebar's collapsed (rail) state.** It is `ActivityBar` state expressed through the Split's min/max pin, not `setPaneCollapsed`, so `panecollapse` cannot carry it. Its own feature, with its own key — and its absence is precisely why step 6 guards the save.
- **Per-connection or per-object layout keys.** Firm user decision: one global key per site.
- **Making `StructurePanel`'s / `ExplainDiagramPanel`'s accordions `resizable`**, or adding `setFillHeight` to `TreeExplorerView`. The first two are shrink-to-fit inside a scroll host / a fixed-width Border region by design; the third would flip the inspector from `px` to `ratio` and destroy the feature's headline behaviour.
- **An app-side length check, unit expectation, schema version, or migration.** The library validates length and per-index unit and discards whole; the store validates shape. See the shape-vs-fit decision.
- **An app-side debounce.** The library emits at drag end; one drag is one write already.
- **Any library-side work** — events, options, `LayoutSizes`, the pin predicates, `AccordionPanel` passthroughs. The three library plans own all of it.
- **The Dialog auto-focus bug.** Unrelated, already handled.
