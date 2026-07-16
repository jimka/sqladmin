# Table Required-Cell Adoption — Implementation Plan

## Overview

The `@jimka/typescript-ui` library shipped a built-in required-column affordance: a **header asterisk** on columns marked `required`, and a **red outline** (inset box-shadow) on cells of those columns whose bound value is empty. SQLAdmin's row-CRUD data grid already knows which columns are required — it computes exactly that predicate at Save time — but today surfaces it only as a status-bar message *after* the user hits Save. This plan wires the existing predicate into the grid's column spec so requiredness is visible *while editing*.

The change is small and almost entirely inside one file: [`frontend/src/dock/tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts). The required predicate — currently inlined in `missingRequiredFields` at [`tableWriteRules.ts:38`](frontend/src/dock/tableWriteRules.ts#L38) — is extracted to a named exported helper `isRequiredColumn`, and `buildColumnSpec` ([`tableWriteRules.ts:29`](frontend/src/dock/tableWriteRules.ts#L29)) starts emitting `required` per column from that same helper. `TableWorkPanel` ([`frontend/src/dock/TableWorkPanel.ts:70`](frontend/src/dock/TableWorkPanel.ts#L70)) needs **no change** — it already passes `buildColumnSpec(columns, privileges.update)` straight to `Table`.

There is a hard prerequisite: SQLAdmin consumes the library's **built, symlinked `dist/lib`**, and the required-cell API is **not in the current build**. `npm run build:lib` must run in `typescript-ui` before this plan will typecheck. See _Ordered Implementation Steps_ step 1.

---

## Architecture Decisions

### Use the static `required` flag, not `requiredPredicate` — requiredness is schema, not record state

SQLAdmin derives requiredness from [`ColumnMeta`](frontend/src/contract.ts#L40) (`!nullable && !isGenerated && !hasDefault`). Every one of those three fields is a property of the **column in the database schema**, identical for every record in the store. It cannot vary per record, so `requiredPredicate` — which the library re-evaluates for every visible cell on *every* render pass ([`Body.ts:1139`](../../typescript-ui/src/typescript/lib/component/table/Body.ts#L1139)) — would burn work recomputing a constant.

Decisive point: **the header asterisk is driven by the static flag only** ([`Header.ts:469`](../../typescript-ui/src/typescript/lib/component/table/Header.ts#L469) calls `cell.setRequired(col?.isRequired() ?? false)`; the header cell has no bound record to run a predicate against). The asterisk is the *most valuable half* of this feature for SQLAdmin — it is the always-visible, discoverable cue telling the user which columns must be filled before Save succeeds, visible before they add a row at all. Choosing `requiredPredicate` would silently forfeit it. Use `required: boolean`.

### The two config fields compose with OR — you cannot narrow the outline with a predicate

Worth stating because it forecloses an otherwise-attractive option. The library resolves required as `config?.required === true || config?.requiredPredicate?.(record) === true` ([`Body.ts:1146-1147`](../../typescript-ui/src/typescript/lib/component/table/Body.ts#L1146)) — **OR**, not AND. So `required: true` plus a `requiredPredicate` returning `false` does *not* suppress the outline; the static flag alone already turned it on.

The consequence: it is impossible to have "asterisk + outline restricted to new/dirty rows". The choice is genuinely binary — static `required` (asterisk, outline on *every* empty required cell), or predicate-only (no asterisk, outline scoped to pending rows). **Do not attempt to combine them.**

### Accept the outline on clean rows holding an empty string

The one case where static `required` outlines a cell that `missingRequiredFields` would *not* report: a **clean, persisted** row whose NOT-NULL/no-default column holds `''`. `NOT NULL` permits the empty string, so this row can exist in the database; `missingRequiredFields` skips it ([`tableWriteRules.ts:42-44`](frontend/src/dock/tableWriteRules.ts#L42)) because it is neither new nor dirty, but the library outlines it because its value is empty ([`Body.ts:1107`](../../typescript-ui/src/typescript/lib/component/table/Body.ts#L1107) treats `''` as empty).

This is **accepted, not a bug to work around**. The outline is honest: by SQLAdmin's own required rule that cell holds no value, and it *is* actionable — editing it makes the row dirty, at which point Save reports it. The case is rare (empty strings in NOT NULL columns), and the only way to suppress it is to drop to `requiredPredicate` and lose the asterisk — a bad trade.

### `isRequiredColumn` is the single source of truth; both call sites take it as a function reference

The predicate `!c.nullable && !c.isGenerated && !c.hasDefault` must exist **exactly once**. Extract it to an exported `isRequiredColumn(column: ColumnMeta): boolean` in `tableWriteRules.ts`. Both consumers call it, neither restates it:

- `buildColumnSpec` → `required: isRequiredColumn(c)` per column.
- `missingRequiredFields` → `columns.filter(isRequiredColumn)`.

`Array.prototype.filter` passes `(value, index, array)`; `isRequiredColumn` declares one parameter, so the extra arguments are harmless and the bare reference is correct — do **not** wrap it in `c => isRequiredColumn(c)`.

Both call sites live in the same module as the helper, so drift is prevented by construction, and the existing node-environment vitest suite ([`frontend/tests/dock/tableWriteRules.test.ts`](frontend/tests/dock/tableWriteRules.test.ts)) can assert the helper directly. This is exactly why `tableWriteRules.ts` exists as a DOM-free module.

### `readOnly` suppressing the outline yields correct behaviour in both cases — leave `required` permission-independent

`buildColumnSpec` sets `readOnly: !canUpdate || c.isGenerated`, and the library gives readOnly **precedence** over the required outline ([`Cell.ts:336`](../../typescript-ui/src/typescript/lib/component/table/cell/Cell.ts#L336): `if (this._requiredEmpty && !this._readOnly)`). Both interactions check out:

- **Generated columns** — `readOnly: true`, but `isRequiredColumn` already excludes `isGenerated`, so `required` is `false` anyway. No interaction; neither asterisk nor outline. Correct: the DB assigns the value.
- **No UPDATE privilege** — every column goes `readOnly: true`, so no outline paints anywhere. Correct: an outline nagging the user to fill a cell they are forbidden from editing would be misleading, which is precisely the precedence rationale the library settled on.

Note the **asterisk is not suppressed by readOnly** — it comes from the static column config, not the cell state. A user without UPDATE still sees asterisks on NOT-NULL/no-default columns. This is **intended**: the asterisk documents the schema ("this column requires a value"), which is true and useful regardless of the viewer's privileges. Therefore `required` stays derived purely from `ColumnMeta` and does **not** take `canUpdate` into account — do not thread the permission flag into `isRequiredColumn`.

### Save-time validation stays

`save_` ([`TableWorkPanel.ts:176`](frontend/src/dock/TableWorkPanel.ts#L176)) keeps its `missingRequiredFields` check and its `Required field(s) missing: …` status-bar message. The affordance is **inline guidance, not a backstop**, for three independent reasons:

1. **The outline only exists for rendered rows.** The library paints it in the visible window ([`Body.ts:782`](../../typescript-ui/src/typescript/lib/component/table/Body.ts#L782)). A pending row scrolled out of view shows nothing — only the Save check catches it.
2. **The outline is passive.** The library's own docs state it "does not block commits or integrate with store-level validation" ([`ColumnConfig.ts:233`](../../typescript-ui/src/typescript/lib/component/table/ColumnConfig.ts#L233)). Nothing stops `store.sync()` but `save_`.
3. **The two have different scopes** (see the empty-string decision above), so neither subsumes the other.

Removing the Save check would regress straight to the raw Postgres NOT NULL error on the round-trip that the check was written to avoid.

### No app-side theme work — the library's stock theme already defines the token

SQLAdmin registers no custom theme and ships no CSS files (verified: no `.css` under `frontend/`, no `ThemeManager.setTheme` call in `frontend/src/`). The library auto-applies `ModernTheme` from [`core/Body.ts:57`](../../typescript-ui/src/typescript/lib/core/Body.ts#L57), and all three stock themes define `table.cell.requiredEmptyOutlineColor`, registered as `--ts-ui-table-cell-required-outline` ([`Theme.ts:1042`](../../typescript-ui/src/typescript/lib/core/Theme.ts#L1042)). The token resolves with no app change. **Do not add a token, a CSS file, or a theme override.**

---

## Public API

### `frontend/src/dock/tableWriteRules.ts`

```typescript
/**
 * Returns whether the user must supply a value for this column on insert.
 * Required = NOT NULL, not generated, and no DB default.
 */
export function isRequiredColumn(column: ColumnMeta): boolean;
```

`buildColumnSpec` and `missingRequiredFields` keep their existing signatures. `buildColumnSpec`'s emitted per-column object gains one field:

```typescript
// was: { field: c.name, readOnly: !canUpdate || c.isGenerated }
// now: { field: c.name, readOnly: !canUpdate || c.isGenerated, required: isRequiredColumn(c) }
```

`ColumnConfig.required` is already typed in the library ([`ColumnConfig.ts:214`](../../typescript-ui/src/typescript/lib/component/table/ColumnConfig.ts#L214)) — no cast or local type needed once `dist/lib` is rebuilt.

---

## Ordered Implementation Steps

1. **PREREQUISITE — rebuild the library's `dist/lib`.** SQLAdmin imports the library's built, symlinked `dist/lib` (`frontend/node_modules/@jimka/typescript-ui` → `../../typescript-ui`), **not** its source. The required-cell API is **not** in the current build — verified: `grep -rl "setRequiredEmpty\|requiredPredicate" /home/jika/typescript/typescript-ui/dist/` returns nothing, and `dist/lib/types/component/table/ColumnConfig.d.ts` predates the feature. Run:

   ```
   cd /home/jika/typescript/typescript-ui && npm run build:lib
   ```

   **`build:lib`, NOT `build`** — `build` (`npm run typecheck && vite build`) builds the *demo app* and does not emit `dist/lib`. Confirm before continuing:

   ```
   grep -rl "requiredPredicate" /home/jika/typescript/typescript-ui/dist/lib/types/component/table/ColumnConfig.d.ts
   ```
   → expect one hit. If it is empty, stop; every later step will fail to typecheck.

2. **`frontend/src/dock/tableWriteRules.ts` — extract the predicate.** Add the exported `isRequiredColumn` (signature and JSDoc under _Public API_) above `buildColumnSpec`. Per the repo's doc conventions the JSDoc is description-only — the signature already carries the types, and there is nothing to say about the single parameter beyond its name.

3. **`frontend/src/dock/tableWriteRules.ts` — consume it in `missingRequiredFields`.** Replace the inlined filter at L38:

   ```typescript
   const required = columns.filter(c => !c.nullable && !c.isGenerated && !c.hasDefault);
   ```

   with:

   ```typescript
   const required = columns.filter(isRequiredColumn);
   ```

   Leave the rest of the function — the new/dirty gate, the emptiness check, the `Set` — untouched. Its doc comment's "Required = not nullable, not generated, no default" sentence now duplicates `isRequiredColumn`'s doc; trim it to point at the helper instead (e.g. "Required as per `isRequiredColumn`.").

4. **`frontend/src/dock/tableWriteRules.ts` — emit `required` from `buildColumnSpec`.** Change the map body at L30 to:

   ```typescript
   return { columns: columns.map(c => ({ field: c.name, readOnly: !canUpdate || c.isGenerated, required: isRequiredColumn(c) })) };
   ```

   Extend the function's doc comment with one sentence stating that required columns (NOT NULL, not generated, no default) get a header asterisk and an empty-cell outline from the library, and that read-only wins over the outline — so a grid without UPDATE shows asterisks but no outlines.

5. **`frontend/tests/dock/tableWriteRules.test.ts` — update the two `buildColumnSpec` expectations.** Both use exact-object `toEqual` and **will fail** until they carry the new field. In "marks every column read-only when the caller lacks UPDATE" the fixture columns come from `column({ name: "a" })`, whose default is `nullable: true` → `required: false`. Same for the second test's columns. So:

   ```typescript
   expect(spec.columns).toEqual([
       { field: "a", readOnly: true, required: false },
       { field: "b", readOnly: true, required: false },
   ]);
   ```

   and the analogous change in "marks only generated columns read-only when the caller has UPDATE".

6. **`frontend/tests/dock/tableWriteRules.test.ts` — add the new coverage** listed under _Expected Behaviour_ (a `describe("isRequiredColumn")` block, plus a `buildColumnSpec` case proving `required` tracks the predicate). Reuse the existing `column()` fixture helper at L5.

7. **Verify no drift.** The predicate must survive in exactly one place — `isRequiredColumn`'s body. Note the helper's own body contains the `nullable && !` fragment, so the invariant is **one** match, not zero:

   ```
   grep -rn "nullable && !" frontend/src/
   ```
   → expect exactly **1** hit, inside `isRequiredColumn` in `tableWriteRules.ts`. Two hits means step 3 didn't replace the copy in `missingRequiredFields`.

   ```
   grep -rn "isRequiredColumn" frontend/src/
   ```
   → expect exactly **4** hits: the definition, the call in `buildColumnSpec`, the `filter` reference in `missingRequiredFields`, and `missingRequiredFields`'s doc comment ("Required as per `isRequiredColumn`.", per step 3) cross-referencing the helper by name. The last hit is a prose pointer, not a second implementation of the predicate — it does not violate the single-source-of-truth invariant this step exists to check.

8. **`cd frontend && npm run typecheck`** → clean. A failure naming `required` as an unknown property on `ColumnConfig` means step 1's rebuild didn't land.

9. **`cd frontend && npm run test`** → green.

10. **Manual verification** — the outline and asterisk are visual and cannot be exercised by the node-environment vitest suite. Run the checks under _Verification → Manual smoke_.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/dock/tableWriteRules.ts` |
| Modify | `frontend/tests/dock/tableWriteRules.test.ts` |

`frontend/src/dock/TableWorkPanel.ts` is **deliberately unmodified** — it already forwards `buildColumnSpec(...)` to `Table` at L70, and `save_` at L176 stays exactly as-is.

---

## Expected Behaviour

### Unit-testable (`frontend/tests/dock/tableWriteRules.test.ts`, node env)

`isRequiredColumn` — build fixtures with the existing `column()` helper:

- `column({ nullable: false })` (not generated, no default) → `true`.
- `column({ nullable: true })` → `false`.
- `column({ nullable: false, isGenerated: true })` → `false`.
- `column({ nullable: false, hasDefault: true })` → `false`.
- `column({ nullable: false, isGenerated: true, hasDefault: true })` → `false`.
- Default fixture `column()` (`nullable: true`) → `false`.

`buildColumnSpec` — `required` tracks the predicate and is independent of `canUpdate`:

- With `canUpdate: true`, columns `[column({ name: "email", nullable: false }), column({ name: "note" })]` → `[{ field: "email", readOnly: false, required: true }, { field: "note", readOnly: false, required: false }]`.
- With `canUpdate: false` and the same columns → `[{ field: "email", readOnly: true, required: true }, { field: "note", readOnly: true, required: false }]`. **`required` stays `true` under `readOnly`** — this pins the "asterisk is permission-independent" decision.
- A generated NOT-NULL column `column({ name: "id", nullable: false, isGenerated: true })` with `canUpdate: true` → `{ field: "id", readOnly: true, required: false }`.

`missingRequiredFields` — all five existing tests must still pass unchanged; the extraction is behaviour-preserving. Do not edit them.

### Manual-verify only (visual — the vitest env is `node`, with no DOM and no theme tokens)

- A table with a NOT-NULL, no-default, non-generated column (e.g. a `text NOT NULL` column) shows a **trailing asterisk** in that column's header.
- A nullable column, a generated column, and a defaulted column show **no** asterisk.
- Clicking **Add row** produces a new row whose empty required cells carry a **red outline**; typing a value and committing clears that cell's outline; clearing it back to empty re-outlines it.
- Opening a table as a user **without UPDATE**: asterisks still show on required columns, but **no** cell outlines appear anywhere (readOnly precedence).
- A generated NOT-NULL primary key (`id`): no asterisk, no outline, cell greyed read-only.
- Save-time validation still fires: add a row, leave a required field empty, click **Save** → status bar reads `Required field(s) missing: <name>`; no sync occurs.

---

## Verification

- `cd /home/jika/typescript/typescript-ui && npm run build:lib` — prerequisite; then the grep in step 1 confirms the API landed in `dist/lib`.
- `cd /home/jika/typescript/sqladmin/frontend && npm run typecheck` — clean.
- `cd /home/jika/typescript/sqladmin/frontend && npm run test` — vitest run, green, including the new `isRequiredColumn` block.
- Grep invariants from step 7.
- **Manual smoke** — log in (per the project's usual login: Host `sqladmin-db`, not `localhost`), open a table with a NOT-NULL no-default column in the **table editor** (`TableWorkPanel`, the row-CRUD data grid — the dock tab you get from opening a table in the object tree). Walk the _Expected Behaviour → Manual-verify_ list. The other two grids are read-only and out of scope (see _Non-Goals_).

---

## Potential Challenges

- **Stale `dist/lib` is the most likely failure.** SQLAdmin resolves the library through a symlink to the sibling checkout's *built* output; source edits there are invisible until `build:lib` runs. Mitigation: step 1's grep gate before any app edit.
- **The two `buildColumnSpec` tests fail the moment step 4 lands**, because they assert exact objects. Mitigation: step 5 is a required part of the same change, not a follow-up.
- **Empty string in a NOT NULL column outlines on a clean row.** Accepted by design (see _Architecture Decisions_); do not "fix" it with a `requiredPredicate` — that silently drops the header asterisk.

---

## Critical Files

- `frontend/src/dock/tableWriteRules.ts` — the only source file changed; `buildColumnSpec` (L29) and `missingRequiredFields` (L37) are both call sites of the extracted predicate. Its header comment explains why the module is DOM-free.
- `frontend/tests/dock/tableWriteRules.test.ts` — the `column()` fixture (L5) and the existing exact-object assertions to update.
- `frontend/src/contract.ts` — `ColumnMeta` (L40); note `hasDefault`'s comment at L46: "has a column default; not user-required on insert".
- `frontend/src/dock/TableWorkPanel.ts` — L70 (spec → `Table`) and L176 (`save_`); read to confirm neither needs touching.
- `/home/jika/typescript/typescript-ui/src/typescript/lib/component/table/ColumnConfig.ts` — `required` (L214) and `requiredPredicate` (L236) doc blocks: the settled semantics.
- `/home/jika/typescript/typescript-ui/src/typescript/lib/component/table/cell/Cell.ts` — L336, the readOnly-over-requiredEmpty precedence, and the `--ts-ui-table-cell-required-outline` inset box-shadow.
- `/home/jika/typescript/typescript-ui/plans/implemented/table-required-cell-affordance.md` — the library plan. **Caveat: it describes a background *tint*; the shipped implementation is an *outline*.** Trust the source over that plan.

---

## Non-Goals

- **`RoleGrantsPanel` and `QueryResultView`.** Both construct `Table(store, { columns: [], rowReadOnly: () => true })` ([`RoleGrantsPanel.ts:50`](frontend/src/dock/RoleGrantsPanel.ts#L50), [`QueryResultView.ts:62`](frontend/src/dock/QueryResultView.ts#L62)) — fully read-only grids with an empty column spec and no `ColumnMeta` to derive requiredness from. `readOnly` would suppress the outline anyway. No other grid in the app builds a per-column spec. Nothing to adopt.
- **A theme token, CSS file, or theme override in SQLAdmin.** The stock `ModernTheme` the library auto-applies already defines `--ts-ui-table-cell-required-outline`.
- **Removing or weakening the Save-time `missingRequiredFields` check.** It is the backstop for off-screen pending rows; the affordance does not block `sync()`.
- **Using `requiredPredicate`.** Would forfeit the header asterisk for no gain — SQLAdmin's requiredness has no per-record component.
- **Blocking edits or `sync()` on required-empty cells.** The library affordance is visual only; gating stays at Save.
- **Changing the `!canUpdate` → all-columns-read-only rule** in `buildColumnSpec` (which means an insert-but-no-update user cannot type into a new row). Pre-existing behaviour, orthogonal to this feature.
