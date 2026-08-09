# Table Record Detail View — Implementation Plan

## Overview

A table's Data tab currently renders every loaded row in one grid ([`frontend/src/dock/TableWorkPanel.ts:70`](frontend/src/dock/TableWorkPanel.ts#L70)). On a wide table — `wide.cols_60` in the seed data has 60 columns — reading a single row means scrolling horizontally across the whole width.

This plan adds a **record view** to that panel: a toolbar toggle that flips the same grid to one record at a time, laid out as one `field` / `value` row per column, with Previous / Next buttons that step through the loaded records. The presentation itself is not built here — `Table` already ships it as `setDisplayMode("rotated")` ([`Table.ts:388`](../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L388)). What this plan builds is the panel's chrome around it: three toolbar buttons, their enable/disable rules, and one pure stepping helper.

The work touches [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) and [`frontend/src/dock/glyphButton.ts`](frontend/src/dock/glyphButton.ts), and adds one new pure module with its unit test. No backend, no store, and no library change.

---

## Architecture Decisions

### The record view is the library's rotated `Table` mode — no new component

The panel keeps its single `dataGrid` and flips it with `setDisplayMode("rotated")` / `setDisplayMode("normal")`. Nothing new is built to render field/value rows.[^why-rotated]

The precedent is the library's own demo for this mode, [`RotatedRecordPanel.ts:164`](../typescript-ui/packages/lib/src/typescript/RotatedRecordPanel.ts#L164): a toolbar with a rotate toggle plus Previous / Next buttons that call `table.selectRecord(...)` with a neighbour from `table.getStore().getRecords()`, clamped at both ends. This plan mirrors that panel's structure exactly.

The app's own key/value-grid precedent, [`frontend/src/properties/PropertyValuePanel.ts:46`](frontend/src/properties/PropertyValuePanel.ts#L46), is **not** reused: it renders a `MemoryStore` of pre-stringified `{property, value}` rows, which would lose the per-column cell types the rotated mode resolves per row.[^why-not-propertyvalue]

### The record view is read-only

Values are displayed, never edited. The user edits in grid view, exactly as today.

This is not a choice the app makes — the library's projection forces `rowReadOnly: () => true` on every value cell ([`Table.ts:1017`](../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L1017)), and the mode's documentation states there is no write-back path from a field/value row to the source record. An editable record-at-a-time editor is therefore a different, much larger feature.[^why-readonly]

Two consequences follow, and both are stated here because the rest of the plan relies on them:

- **Save keeps working untouched.** `syncSaveEnabled` ([`TableWorkPanel.ts:157`](frontend/src/dock/TableWorkPanel.ts#L157)) is driven by the store's `datachange` event and `hasPendingChanges()`, neither of which knows about display mode.
- **There is no unsaved-edit hazard when stepping records.** Stepping only re-targets which record the projection reads; it never writes, never reloads, and never discards a pending edit. A cell edited in grid view stays pending and shows its edited value in record view.

### Navigation stops at the loaded page

Previous / Next step within `store.getRecords()` — the records currently loaded — and clamp at both ends. Next is disabled once the last loaded record is displayed; it never turns the store's page.[^why-clamp]

The store pages server-side at 100 rows ([`frontend/src/data/stores.ts:16`](frontend/src/data/stores.ts#L16)), and this panel ships no pagination control, so the grid can only reach page one. Clamping gives the record view exactly the reach the grid has, in exactly the grid's row order (`getRecords()` is the filtered, sorted view, and both sorting and filtering are remote).

### The grid's selection *is* the current record

There is one selection, not a grid selection plus a record-view cursor. `setDisplayMode("rotated")` adopts the currently selected grid row (falling back to the first loaded record, then to nothing), and `setDisplayMode("normal")` re-selects whatever record was displayed. Both directions are library behaviour; the panel adds one call.

| User action | Result |
|---|---|
| Select row 12, toggle to record view | Record view opens on row 12's record |
| Toggle with no row selected | Record view opens on the first loaded record |
| Toggle with an empty store | Record view opens empty; the first `load` targets the first record |
| Step to record 15, toggle back to grid | Row 15 is selected **and scrolled into view** |

The last row is the one addition: `setDisplayMode("normal")` re-selects the record but does not reveal it, so `toggleRecordView` follows it with `dataGrid.selectRecord(record)`, whose normal-mode path scrolls the row into view ([`Table.ts:747`](../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L747)).

### Only Add changes meaning between the two views

Every toolbar button keeps its current behaviour and its current privilege gating. Add is the single exception: it creates a record that only the grid can fill in, so it is disabled while the record view is showing, with a tooltip that says why.

| Button | Grid view | Record view |
|---|---|---|
| Add | enabled iff INSERT granted | **disabled**, tooltip adds "Switch to the grid view to add a row" |
| Delete | enabled iff DELETE granted and a live row is selected | unchanged code — deletes the displayed record[^delete-unchanged] |
| Save | enabled iff a write right and a pending change | unchanged |
| Filter / Export / Refresh | enabled | unchanged |
| Record view toggle | off | on |
| Previous / Next | disabled | enabled iff a neighbour exists in the loaded records |

### Stepping arithmetic lives in a pure module

The clamp-and-detect-no-move rule goes in a new `frontend/src/dock/recordNavigation.ts` so it can be unit-tested under the project's DOM-less node vitest. This mirrors [`frontend/src/dock/tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts), which exists for exactly that reason — `TableWorkPanel.ts`'s imports touch `document` at module-load time.

---

## Public API

### `frontend/src/dock/recordNavigation.ts` — new module

```ts
/**
 * The index to step to, or null when there is nowhere to go.
 *
 * @param currentIndex - Index of the displayed record, or -1 when none is displayed.
 * @param delta        - -1 for the previous record, 1 for the next.
 * @param count        - Number of records currently loaded.
 */
export function stepIndex(currentIndex: number, delta: number, count: number): number | null;
```

The result is `currentIndex + delta` clamped into `[0, count - 1]`, and `null` when that clamp lands back on `currentIndex` or the store is empty:

| `count` | `currentIndex` | `delta` | Result | Why |
|---|---|---|---|---|
| 120 | 0 | -1 | `null` | already the first record |
| 120 | 0 | 1 | `1` | ordinary step |
| 100 | 99 | 1 | `null` | last **loaded** record — the page boundary |
| 120 | -1 | 1 | `0` | nothing displayed yet → first record |
| 120 | -1 | -1 | `0` | nothing displayed yet → first record |
| 0 | -1 | 1 | `null` | empty store |

### `frontend/src/dock/glyphButton.ts` — new export

```ts
export function glyphToggleButton(glyph: string, color: string, label: string, selected: boolean): ToggleButton;
```

Same glyph-only face as `glyphButton`, built from the module's existing `glyphButtonOptions` bag plus `selected`. It takes **no** handler: a toggle's handler almost always needs the owning component, which is unavailable while the button is being built as a pre-`super()` local, so the caller wires `.on("action", …)` after `super()` returns.

---

## Internal Structure

`TableWorkPanel`'s new members. `toggleRecordView` and `syncStepEnabled` are arrow-function fields because they are registered by reference on `recordToggle` / `dataGrid` / `store` events, which would drop `this` from a plain method (convention (c) in [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md)). `syncAddEnabled` is only ever called as `this.syncAddEnabled()`, but stays an arrow field to match its siblings in the same file.

```ts
private toggleRecordView = (): void => {
    const record = this.dataGrid.getSelectedRecord();

    if (this.recordToggle.isSelected()) {
        this.dataGrid.setDisplayMode("rotated");
    } else {
        this.dataGrid.setDisplayMode("normal");
        // setDisplayMode re-selects the displayed record but does not reveal it;
        // selectRecord's normal-mode path scrolls the row back into view.
        this.dataGrid.selectRecord(record);
    }

    this.syncAddEnabled();
    this.syncStepEnabled();
};

private syncAddEnabled = (): void => {
    const rotated = this.dataGrid.getDisplayMode() === "rotated";

    this.addButton.setEnabled(this.privileges.insert && !rotated);
    this.addButton.setDescription(rotated ? "Switch to the grid view to add a row" : "");
};

private syncStepEnabled = (): void => {
    const rotated = this.dataGrid.getDisplayMode() === "rotated";
    const records = this.store.getRecords();
    const current = this.dataGrid.getSelectedRecord();
    const index   = current ? records.indexOf(current) : -1;

    this.prevButton.setEnabled(rotated && stepIndex(index, -1, records.length) !== null);
    this.nextButton.setEnabled(rotated && stepIndex(index,  1, records.length) !== null);
};
```

The stepper itself is a stateless module-level function, alongside `save_` and `confirmDelete`. It takes everything it needs as parameters, so the Previous / Next buttons can be wired while they are still pre-`super()` locals, through an inline arrow that closes over the `dataGrid` local alone:

```ts
function stepRecord(dataGrid: Table, delta: number): void {
    const records = dataGrid.getStore().getRecords();
    const current = dataGrid.getSelectedRecord();
    const target  = stepIndex(current ? records.indexOf(current) : -1, delta, records.length);

    if (target !== null) {
        dataGrid.selectRecord(records[target]);
    }
}
```

---

## Ordered Implementation Steps

1. **Create `frontend/tests/dock/recordNavigation.test.ts`** covering every row of the `stepIndex` table in _Public API_, plus `count === 1` (both deltas yield `null`). Model it on [`frontend/tests/dock/tableWriteRules.test.ts`](frontend/tests/dock/tableWriteRules.test.ts). Run `cd frontend && npm test` — the suite fails to import a module that does not exist yet.

2. **Create `frontend/src/dock/recordNavigation.ts`** with `stepIndex` per _Public API_. Give the module a header comment stating why it is split out (pure logic, node-vitest, same reason as `tableWriteRules.ts`). Run `npm test` — green.

3. **`frontend/src/dock/glyphButton.ts`** — add `glyphToggleButton` per _Public API_, built as `new ToggleButton("", { ...glyphButtonOptions(glyph, color, label), selected })`. Import `ToggleButton` from `@jimka/typescript-ui/component/button` alongside the existing `Button` import. Document in its JSDoc why it takes no handler. Extend the module header comment so the "one owner, so the variants cannot drift apart" sentence covers three variants, not two.

4. **`frontend/src/dock/TableWorkPanel.ts` — imports and glyph registration.** Add `ToggleButton` to the `component/button` import, `stepIndex` from `./recordNavigation`, `glyphToggleButton` from `./glyphButton`, and the three glyph modules `table_list`, `angle_left`, `angle_right` from `@jimka/typescript-ui/glyphs/solid/…`. Append all three to the existing `Glyph.register(...)` call at [line 41](frontend/src/dock/TableWorkPanel.ts#L41).

5. **`TableWorkPanel.ts` — fields.** Add `private readonly addButton: Button;`, `recordToggle: ToggleButton`, `prevButton: Button`, `nextButton: Button` to the field block at [lines 63-65](frontend/src/dock/TableWorkPanel.ts#L63). Rewrite the comment above it — it currently says `addButton` "is set once and never revisited", which stops being true in step 8.

6. **`TableWorkPanel.ts` — build the three buttons as pre-`super()` locals**, after `filterButton` at [line 85](frontend/src/dock/TableWorkPanel.ts#L85):

   ```ts
   const recordToggle = glyphToggleButton("table-list", PRIMARY_COLOR, "Record view (one record as field/value rows)", false);
   const prevButton   = glyphButton("angle-left",  PRIMARY_COLOR, "Previous record", () => stepRecord(dataGrid, -1));
   const nextButton   = glyphButton("angle-right", PRIMARY_COLOR, "Next record",     () => stepRecord(dataGrid, 1));
   ```

   The two handlers close over the `dataGrid` local only — no `this`, which is unavailable before `super()`.

7. **`TableWorkPanel.ts` — toolbar order.** Insert `recordToggle, prevButton, nextButton` into the `components` array at [line 93](frontend/src/dock/TableWorkPanel.ts#L93), immediately after `Spacer.flex()` and before `filterButton`, so the view actions read: record view, Previous, Next, Filter, Export, Refresh.

8. **`TableWorkPanel.ts` — post-`super()` wiring.** Assign the four new fields alongside the existing ones at [lines 117-119](frontend/src/dock/TableWorkPanel.ts#L117). Then:
   - Replace `addButton.setEnabled(privileges.insert);` at [line 132](frontend/src/dock/TableWorkPanel.ts#L132) with `this.syncAddEnabled();` and update the comment above it — Add is no longer a fixed capability.
   - Add `this.recordToggle.on("action", this.toggleRecordView);`.
   - Add `this.syncStepEnabled();`, `dataGrid.on("selection", this.syncStepEnabled);`, and `store.on("datachange", this.syncStepEnabled);` next to the existing `syncDeleteEnabled` wiring at [lines 142-144](frontend/src/dock/TableWorkPanel.ts#L142).

9. **`TableWorkPanel.ts` — the handlers.** Add `toggleRecordView`, `syncAddEnabled`, and `syncStepEnabled` as arrow-function fields after `syncDeleteEnabled` ([line 163](frontend/src/dock/TableWorkPanel.ts#L163)), and `stepRecord` as a module-level function beside `save_` and `confirmDelete`, all per _Internal Structure_.

10. **`TableWorkPanel.ts` — header comment.** The file's opening block lists what the panel owns and names its arrow-function fields; extend it to cover the record-view toggle, the stepper, and the read-only nature of the record view.

11. **Checkpoint** — `cd frontend && npm run typecheck && npm test`.

12. **`README.md`** — extend the "Data grid" highlight ([line 28](README.md#L28)) to mention flipping a row into a field/value record view.

13. **`TODO.md`** — rewrite the "Row-detail viewer" backlog bullet ([line 14](TODO.md#L14)) per _Documentation Impact_. Check with `grep -n 'Row-detail' TODO.md` that exactly one bullet matches.

14. **Manual verification** — per _Verification_.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/recordNavigation.ts` |
| Create | `frontend/tests/dock/recordNavigation.test.ts` |
| Modify | `frontend/src/dock/TableWorkPanel.ts` |
| Modify | `frontend/src/dock/glyphButton.ts` |
| Modify | `README.md` |
| Modify | `TODO.md` |

---

## Expected Behaviour

### Unit-testable — `stepIndex` (`frontend/tests/dock/recordNavigation.test.ts`)

Every row of the table in _Public API_, plus:

- `count === 1`, `currentIndex === 0`: both `delta: 1` and `delta: -1` return `null`.
- A `delta` larger than the remaining distance clamps rather than overshooting: `stepIndex(98, 5, 100) === 99`.

Nothing else in this plan is unit-testable — the remaining behaviour is display-mode and toolbar state inside DOM-backed library components, which the project's node-environment vitest deliberately does not cover.

### Manual — the Data tab of an open table

Open `wide.cols_60` (60 columns and more than one page of rows, so the 100-row page boundary is reachable) unless stated otherwise.

1. **Toggle in.** Click the record-view toggle: the grid is replaced by two columns of field/value rows, one row per table column, in the table's own column order. The toggle reads as pressed.
2. **Seeding from the grid.** Select the 12th row, toggle in: the values shown are that row's. Toggle out: the 12th row is selected **and visible** without scrolling.
3. **No selection.** Open a fresh tab and toggle in without clicking any row: the first record is shown.
4. **Stepping.** Next advances one record; Previous goes back. On the first record Previous is disabled; on the 100th record (the last one loaded) Next is disabled, even though the table holds more rows than that.
5. **Stepper is inert in grid view.** Both stepper buttons are disabled whenever the toggle is off.
6. **Read-only.** Double-clicking any value cell does not open an editor.
7. **Pending edits survive.** In grid view, edit a cell (Save enables). Toggle in: the edited value is shown on its record, and Save stays enabled. Step away and back: the edit is still pending and still shown. Toggle out and Save: the change persists.
8. **Add.** In record view the Add button is disabled and its tooltip carries the "Switch to the grid view to add a row" line. Toggling out re-enables it (on a table where INSERT is granted).
9. **Delete.** In record view with DELETE granted, Delete is enabled and its dialog reports one row. Confirming queues the displayed record and the view re-targets to the **first** loaded record — library behaviour when the displayed record leaves the store.
10. **Refresh.** Pressing Refresh while in record view reloads and the view re-targets to the first record; the panel stays in record view.
11. **Filter.** Applying a filter while in record view reloads the store, and the view re-targets to the first matching record. Clearing it does the same.
12. **Empty and no-privilege tables.** On a table with no rows the record view shows no rows and both steppers are disabled. On a table with no UPDATE/INSERT/DELETE the toggle and steppers still work; only the write buttons stay disabled.
13. **Export.** Export → CSV from record view still exports the whole relation, not the field/value projection.

---

## Verification

- `cd frontend && npm run typecheck` — clean.
- `cd frontend && npm test` — the new `recordNavigation` suite passes with the rest.
- `grep -rn 'setDisplayMode' frontend/src/` — exactly two matches, both inside `toggleRecordView`.
- `grep -rn 'addButton.setEnabled' frontend/src/` — one match, inside `syncAddEnabled`.
- Manual: the 13 cases above, driven through the running app (see the `verify` skill). Entry point: navigator → `wide` → `cols_60` → the table's Data tab; and `public.customers` for the write-privilege cases.

---

## Documentation Impact

- **`README.md`** — the "Data grid" highlight lists what the grid can do; add the record view to it.
- **`TODO.md`** — the backlog carries **"Row-detail viewer — expand one row (wide tables, JSON / large-text columns) into a form/panel."** This plan ships the read-only half. Rewrite the bullet to keep the unshipped half visible, naming what remains: editing a record field-by-field, and reading a JSON / large-text value in full (the record view's value column is width-capped by the library).
- **`CHANGELOG.md`** — no entry. SQLAdmin's changelog is written at release time, not in feature work; `plans/implemented/content-derived-column-sizing.md` and `plans/implemented/elkjs-0-12-upgrade.md` both set that precedent.
- **`LIBRARY_NOTES.md`** — no entry. It records library defects and papercuts the app hits; this plan consumes a library feature as documented. See _Potential Challenges_ for the one observation that would earn an entry if manual verification turns it into a real problem.
- **`frontend/COMPONENT_CONVENTIONS.md`** — unaffected. The panel stays a class-first `Container` under rules (b), (c), and (d).

---

## Potential Challenges

- **`this` is unavailable while the buttons are built.** The three new buttons are constructed before `super()`, so the toggle's handler is wired afterwards and the steppers' handlers close over the `dataGrid` local. Writing `() => this.stepRecord(-1)` in the pre-`super()` block is a compile error.
- **The projection's headers read `field` and `value` in lower case.** The projection model is internal to the library and declares no field descriptions, so the app cannot relabel them. Cosmetic; leave it.
- **A long value is clipped at 360px.** The library caps the projection's `value` column, and the cell is read-only, so there is no editor to expand it. Make no app-side workaround: if manual case 6 shows a `text` or `json` value that cannot be read at all, log it in `LIBRARY_NOTES.md` as a `✂️🔎` papercut against the library's column-width policy.
- **Delete jumps to the first record, not the next one.** `Table` re-targets to `getRecords()[0]` whenever the displayed record leaves the store. Accepted as library behaviour; case 9 pins it so it is not mistaken for a bug later.
- **`selectRecord` fires `"selection"`.** `toggleRecordView` calls it on the way out of record view, which re-runs `syncDeleteEnabled` and `syncStepEnabled`. Both are idempotent, so the extra pass is harmless.

---

## Critical Files

| File | Why |
|---|---|
| [`frontend/src/dock/TableWorkPanel.ts`](frontend/src/dock/TableWorkPanel.ts) | The panel being changed; its arrow-field handler style and pre-`super()` local pattern must be followed exactly. |
| [`../typescript-ui/packages/lib/src/typescript/RotatedRecordPanel.ts`](../typescript-ui/packages/lib/src/typescript/RotatedRecordPanel.ts) | The precedent this plan mirrors: toggle + Previous/Next over `setDisplayMode` and `selectRecord`. |
| [`../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts:388`](../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L388) | `setDisplayMode`, `selectRecord`, `getSelectedRecord(s)`, and `onSourceStoreChange` — the exact semantics every _Expected Behaviour_ case rests on. |
| [`../typescript-ui/packages/lib/docs/components/Table.md`](../typescript-ui/packages/lib/docs/components/Table.md) | The "Rotated record view" section: the mode's contract in prose, including its read-only rule. |
| [`frontend/src/properties/PropertyValuePanel.ts`](frontend/src/properties/PropertyValuePanel.ts) | The app's existing key/value grid, and the rejected alternative — read it to see why it does not carry a live table's typed values. |
| [`frontend/src/dock/glyphButton.ts`](frontend/src/dock/glyphButton.ts) | Single owner of the toolbar's glyph-only button face; the new toggle variant must reuse `glyphButtonOptions`. |
| [`frontend/src/dock/tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts) | The template for the new pure module: why it exists, and its header-comment style. |
| [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) | Rules (b) super-cascade and (c) arrow-function handler fields, both load-bearing here. |

---

## Non-Goals

- **Editing in record view.** The library projection is read-only with no write-back path; an editable record-at-a-time editor is a separate feature against a different mechanism.
- **Paging from the record view.** Next never turns the store's page. Adding a `PaginationBar` to this panel — as [`frontend/src/dock/RoleGrantsPanel.ts:51`](frontend/src/dock/RoleGrantsPanel.ts#L51) does — is its own change; when it lands, the stepper follows for free, because it reads `store.getRecords()` fresh on every step.
- **Keyboard shortcuts for Previous / Next.** The app's shortcuts are registered centrally in `frontend/src/shell/shortcutRegistry.ts` and scoped globally or to the editor; a panel-scoped binding needs a mechanism that does not exist yet.
- **Remembering the display mode** across tab closes, or defaulting a wide table into record view. Every tab opens in grid view.
- **A `CHANGELOG.md` entry or a version bump.** Both belong to the release step.
- **Any library change.** `setDisplayMode` shipped in `@jimka/typescript-ui` 0.3.0 and is present in the released `^0.4.1` the app depends on, so this plan is not gated on an unreleased build.

---

## Notes

[^why-rotated]: The alternative was a second `Table` over a `MemoryStore` of `{property, value}` rows, rebuilt per record — the shape [`PropertyValuePanel`](frontend/src/properties/PropertyValuePanel.ts) already uses. It was rejected once the library search turned up `Table.setDisplayMode`, which does the same job with none of the code: it owns the projection store, rebuilds it on the source store's `load` / `add` / `remove` / `datachange` events, resolves each row's cell variant from its source field's type, and keeps `getSelectedRecord(s)` returning source records so the panel's existing delete gating needs no change at all. Building a second grid would have duplicated all of that and then drifted from it.

[^why-not-propertyvalue]: `PropertyValuePanel` declares both its columns `type: "string"` and its callers pre-format every value, which is right for an inspector summarising metadata. A table row is not that: a `boolean` column should render a checkbox, a `date` a date cell, a numeric column right-aligned digits. The rotated projection declares its `value` field `'auto'` and resolves each row's cell variant from the source field ([`Table.ts:1066`](../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L1066)), which is exactly the fidelity a stringified mirror would throw away.

[^why-readonly]: Making the record view editable would mean abandoning the library's projection and hand-building a mirror store plus a write-back path — parse each edited display value back to its column's native type, push it through `ModelRecord.set`, and re-derive the required-field outlines and the per-column read-only rules that [`buildColumnSpec`](frontend/src/dock/tableWriteRules.ts) already computes for the grid. That is a larger feature than this one, with its own validation surface, and it would leave two independent edit paths writing to the same store. The grid remains the single editing surface.

[^why-clamp]: Turning the page transparently was the alternative. `AbstractStore.nextPage()` ([`AbstractStore.ts:517`](../typescript-ui/packages/lib/src/typescript/lib/data/AbstractStore.ts#L517)) exists and would work, but it drags in three things this feature does not otherwise need: an asynchronous reload between the click and the record appearing; a `pagechangeblocked` event to surface when the store has pending changes (`nextPage` refuses to move then); and a re-target dance, because after a reload `Table` lands the projection on the new page's *first* record — right when stepping forward, wrong when stepping back. It would also give the record view a reach the grid does not have, since this panel has no pagination control at all. Clamping keeps the two views showing the same 100 records.

[^delete-unchanged]: `syncDeleteEnabled` reads `this.dataGrid.getSelectedRecords()`, and in rotated mode `Table` returns the single displayed source record ([`Table.ts:795`](../typescript-ui/packages/lib/src/typescript/lib/component/table/Table.ts#L795)) — never a projection row. `confirmDelete` then passes that record to `store.remove`. Both work in record view with no edit, and the existing `dataGrid.on("selection", …)` registration keeps firing, because `selectRecord` emits `"selection"` while rotated too.
