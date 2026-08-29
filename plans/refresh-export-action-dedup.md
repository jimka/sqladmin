---
touches-shared:
  - frontend/src/dock/glyphButton.ts
  - frontend/src/dock/exportButton.ts
  - frontend/src/dock/menuItems.ts
  - frontend/src/dock/IndexInfoPanel.ts
  - frontend/src/dock/TableWorkPanel.ts
  - frontend/src/dock/definitionEditor.ts
  - frontend/src/dock/SequenceInfoPanel.ts
  - frontend/src/dock/TypeInfoPanel.ts
  - frontend/src/shell/createSchemaTool.ts
  - frontend/src/shell/showDatabaseDiagramTool.ts
  - frontend/src/shell/refreshTool.ts
  - frontend/src/shell/QueriesView.ts
  - frontend/src/shell/queryShortcuts.ts
  - frontend/src/shell/shortcutRegistry.ts
  - frontend/src/shell/SqlAdminShell.ts
  - frontend/src/navigator/objectMenu.ts
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/roles/RolesTree.ts
---

# Refresh and Export Action Deduplication — Implementation Plan

## Overview

Two UI actions are each assembled by hand at many call sites, and both have already drifted apart. **Refresh**: [`frontend/src/dock/glyphButton.ts:28`](frontend/src/dock/glyphButton.ts#L28) owns the glyph-only compact button face, but four shell modules re-type that options bag themselves — [`createSchemaTool.ts:13`](frontend/src/shell/createSchemaTool.ts#L13), [`showDatabaseDiagramTool.ts:15`](frontend/src/shell/showDatabaseDiagramTool.ts#L15), [`refreshTool.ts:18`](frontend/src/shell/refreshTool.ts#L18), and [`QueriesView.ts:360-378`](frontend/src/shell/QueriesView.ts#L360) — and all four have dropped `showDescription: false`. Six Refresh buttons hardcode the tooltip `"Refresh (Alt+R)"` instead of composing it from `REFRESH_SHORTCUT` ([`queryShortcuts.ts:25`](frontend/src/shell/queryShortcuts.ts#L25)), which exists so a tooltip cannot claim a key the app no longer binds. And two registered glyph names — `"refresh"` and `"arrows-rotate"` — are both in use for the same action.

**Export**: the CSV/JSON menu-item pair is built five times. [`menuItems.ts:39`](frontend/src/dock/menuItems.ts#L39) and [`:59`](frontend/src/dock/menuItems.ts#L59) own it for the toolbar buttons, while [`objectMenu.ts:189-192`](frontend/src/navigator/objectMenu.ts#L189), [`RolesTree.ts:96-99`](frontend/src/roles/RolesTree.ts#L96), and [`SqlAdminShell.ts:389-400`](frontend/src/shell/SqlAdminShell.ts#L389) each write their own. The wording has already split: two sites say `"Export CSV (.csv)"`, three say `"CSV (.csv)"`.

This plan routes the four shell modules' buttons through `glyphButton()`, every Refresh tooltip through `REFRESH_SHORTCUT`, every Refresh glyph through one registered name, and all five export pairs through one builder in `menuItems.ts`. It also adds unit tests for the nine chord matchers in [`queryShortcuts.ts`](frontend/src/shell/queryShortcuts.ts) that have none today — the module is kept free of DOM references at import scope so exactly that is possible. No behaviour changes except the export menus' item wording.

---

## Architecture Decisions

### The shell's glyph-only buttons are built by `glyphButton()`

The four shell modules that hand-roll the face call [`glyphButton()`](frontend/src/dock/glyphButton.ts#L42) instead. The DDL forms' row-remove buttons hand-roll it too and are left alone, for the reason in `## Non-Goals`. The precedent is the dock, where all 30-odd toolbar buttons already go through it, and [`plans/implemented/panel-refresh-buttons.md:31-33`](plans/implemented/panel-refresh-buttons.md#L31) settled `glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", handler)` as the shape a Refresh button takes.[^showdescription-noop]

### The Refresh tooltip is composed from `REFRESH_SHORTCUT`

The six sites that hardcode `"Refresh (Alt+R)"` use the template literal `` `Refresh (${REFRESH_SHORTCUT})` ``, importing the constant from `../shell/queryShortcuts`. This mirrors [`QueryPanel.ts:309-311`](frontend/src/dock/QueryPanel.ts#L309), which already writes `` `Run (${RUN_SHORTCUT})` ``, `` `Save query (${SAVE_SHORTCUT})` ``, and `` `Clear (${CLEAR_SHORTCUT})` ``.[^no-label-constant]

### `"refresh"` is the app's one Refresh glyph name

`"arrows-rotate"` is retired: the three call sites using it move to `"refresh"`, and the two `Glyph.register(arrows_rotate)` calls register `refresh` instead. The two names resolve to byte-identical artwork, so nothing on screen changes.[^glyph-artwork-identical] [^refresh-name-wins]

### `glyphButton.ts` stays in `frontend/src/dock/`

The shell modules import it as `../dock/glyphButton` rather than the file moving to a neutral directory. Imports already cross these directories in both directions — [`QueryPanel.ts:102`](frontend/src/dock/QueryPanel.ts#L102) imports `../shell/queryShortcuts`, and [`DatabaseExplorerView.ts:9`](frontend/src/shell/DatabaseExplorerView.ts#L9) imports `../navigator/NavigatorTree`.[^no-move]

### One builder owns the export format pair

A new `buildExportFormatItems(kind, onExport)` in [`menuItems.ts`](frontend/src/dock/menuItems.ts) returns the two items for a rows result or an EXPLAIN plan. `buildTableExportItems` and `buildQueryExportItems` keep their signatures and delegate to it, and the three bypassing sites call in. This follows [`exportButton.ts:31`](frontend/src/dock/exportButton.ts#L31), the existing example of a shared builder that composes `menuItems.ts` output rather than re-typing it.[^why-new-builder]

### Export items drop the `"Export "` prefix

Every export item reads `"CSV (.csv)"`, `"JSON (.json)"`, or `"Text (.txt)"`. The two sites that say `"Export CSV (.csv)"` today change.[^short-label]

### The chord matchers get their own test file

`frontend/tests/shell/queryShortcuts.test.ts` is new and covers all ten matchers. The four `isHelpChord` cases now in [`shortcutRegistry.test.ts:83-102`](frontend/tests/shell/shortcutRegistry.test.ts#L83) move into it.[^own-test-file]

---

## Public API

One new export from `frontend/src/dock/menuItems.ts`:

```ts
/**
 * @param kind - Whether the exportable result is tabular rows or an EXPLAIN plan.
 * @param onExport - Runs the export in the chosen format.
 */
export function buildExportFormatItems(
    kind: "rows" | "plan",
    onExport: (format: "csv" | "json") => void,
): MenuItemConfig[];
```

Unchanged, and still exported: `buildTableExportItems(onExport)`, `buildQueryExportItems(active, notify)`, `buildAddConstraintItems(actions)`, `buildExportButton(label, onExport)`, `glyphButton(glyph, color, label, handler)`.

---

## Internal Structure

`buildExportFormatItems` decides the first slot from `kind`; the second slot is JSON either way. The callback always receives `"csv"` for the first slot and `"json"` for the second, whichever kind is in play.[^csv-token]

| `kind` | First item text | First glyph | First callback argument | Second item text | Second glyph | Second callback argument |
|---|---|---|---|---|---|---|
| `"rows"` | `CSV (.csv)` | `file-csv` | `"csv"` | `JSON (.json)` | `file-code` | `"json"` |
| `"plan"` | `Text (.txt)` | `file-lines` | `"csv"` | `JSON (.json)` | `file-code` | `"json"` |

```ts
export function buildExportFormatItems(
    kind: "rows" | "plan",
    onExport: (format: "csv" | "json") => void,
): MenuItemConfig[] {
    const first = kind === "plan"
        ? { text: "Text (.txt)", glyph: "file-lines" }
        : { text: "CSV (.csv)",  glyph: "file-csv" };

    return [
        { ...first, action: () => onExport("csv") },
        { text: "JSON (.json)", glyph: "file-code", action: () => onExport("json") },
    ];
}
```

The five call sites after the change:

| Call site | Call | What the callback runs |
|---|---|---|
| [`exportButton.ts:31`](frontend/src/dock/exportButton.ts#L31) (unchanged) | `buildTableExportItems(onExport)` | the panel's own export |
| [`menuItems.ts:59`](frontend/src/dock/menuItems.ts#L59) rows arm | `buildExportFormatItems("rows", …)` | `exportQueryResult(active.result, format, notify)` |
| [`menuItems.ts:59`](frontend/src/dock/menuItems.ts#L59) plan arm | `buildExportFormatItems("plan", …)` | `exportExplainPlan(active.plan, format === "csv" ? "txt" : "json", notify)` |
| [`objectMenu.ts:189`](frontend/src/navigator/objectMenu.ts#L189) | `buildTableExportItems(…)` | `actions.exportTable(ref, format)` |
| [`RolesTree.ts:96`](frontend/src/roles/RolesTree.ts#L96) | `buildTableExportItems(…)` | `void this.controller.exportRole(name, format)` |
| [`SqlAdminShell.ts:389`](frontend/src/shell/SqlAdminShell.ts#L389) | `buildExportFormatItems(kind, …)` | `actions.onExportResults(format)` |

The Refresh conversions:

| Site | Today | After |
|---|---|---|
| [`refreshTool.ts:18`](frontend/src/shell/refreshTool.ts#L18) | hand-rolled bag, `"arrows-rotate"`, literal label | `glyphButton("refresh", PRIMARY_COLOR, \`Refresh (${REFRESH_SHORTCUT})\`, onRefresh)` |
| [`IndexInfoPanel.ts:100`](frontend/src/dock/IndexInfoPanel.ts#L100), [`TableWorkPanel.ts:218`](frontend/src/dock/TableWorkPanel.ts#L218), [`definitionEditor.ts:85`](frontend/src/dock/definitionEditor.ts#L85), [`SequenceInfoPanel.ts:209`](frontend/src/dock/SequenceInfoPanel.ts#L209), [`TypeInfoPanel.ts:163`](frontend/src/dock/TypeInfoPanel.ts#L163) | `glyphButton("refresh", …, "Refresh (Alt+R)", …)` | same call, label becomes the template literal |
| [`SqlAdminShell.ts:414`](frontend/src/shell/SqlAdminShell.ts#L414) (View → Refresh) | `glyph: "arrows-rotate"` | `glyph: "refresh"` |
| [`objectMenu.ts:182`](frontend/src/navigator/objectMenu.ts#L182) (matview Refresh) | `glyph: "arrows-rotate"` | `glyph: "refresh"` |
| [`createSchemaTool.ts:13`](frontend/src/shell/createSchemaTool.ts#L13), [`showDatabaseDiagramTool.ts:15`](frontend/src/shell/showDatabaseDiagramTool.ts#L15), [`QueriesView.ts:363`](frontend/src/shell/QueriesView.ts#L363) | hand-rolled bag | `glyphButton(…)`, glyph and label unchanged |

---

## Ordered Implementation Steps

**Export convergence**

1. **`frontend/src/dock/menuItems.ts`** — add `buildExportFormatItems` exactly as given in `## Internal Structure`, placed above `buildTableExportItems`, with a JSDoc block covering both parameters and the return. Give it a remark stating that the callback receives `"csv"` for the first slot even when that slot is the plan's text export, and that `SqlAdminController.exportActive` ([`:2599`](frontend/src/SqlAdminController.ts#L2599)) maps the same way.

2. **`frontend/src/dock/menuItems.ts`** — reduce `buildTableExportItems`'s body to `return buildExportFormatItems("rows", onExport);`. In `buildQueryExportItems`, keep the `if (!active) { return []; }` guard, then return `buildExportFormatItems("rows", format => exportQueryResult(active.result, format, notify))` from the rows arm and `buildExportFormatItems("plan", format => void exportExplainPlan(active.plan, format === "csv" ? "txt" : "json", notify))` from the plan arm. Both closures read `active` after its kind is narrowed, exactly as the current bodies do.

3. **`frontend/src/dock/menuItems.ts`** — update the module header comment: it currently describes "the CSV/JSON export chooser (table export and query-result export)"; it now also serves the navigator's object menu, the roles tree, and the menu bar's Tools → Export results submenu.

4. **`frontend/tests/dock/menuItems.test.ts`** — change the three expected text arrays: `["Export CSV (.csv)", "Export JSON (.json)"]` → `["CSV (.csv)", "JSON (.json)"]` at lines 39 and 60, and `["Export text (.txt)", "Export JSON (.json)"]` → `["Text (.txt)", "JSON (.json)"]` at line 76. Add a `describe("buildExportFormatItems")` block covering both rows of the `## Internal Structure` table, including which argument each item's action passes.

5. **`frontend/src/navigator/objectMenu.ts`** — add `import { buildTableExportItems } from "../dock/menuItems";` and replace the inline two-item array at lines 190-191 with `buildTableExportItems(format => actions.exportTable(ref, format))`. `exportTable` returns `void` ([`SqlAdminController.ts:2720`](frontend/src/SqlAdminController.ts#L2720)), so no `void` operator is needed. Extend the module header's note about staying free of DOM references at import scope to say that `../dock/menuItems` is safe to import for the same reason: it touches `document` only inside function bodies.

6. **`frontend/src/roles/RolesTree.ts`** — add `import { buildTableExportItems } from "../dock/menuItems";` and replace the inline two-item array at lines 97-98 with `buildTableExportItems(format => void this.controller.exportRole(name, format))`. `exportRole` is async, so the `void` operator stays.

7. **`frontend/src/shell/SqlAdminShell.ts`** — add `import { buildExportFormatItems } from "../dock/menuItems";`. Replace the Export-results item at lines 389-399, whose `items: () => { … }` provider builds the pair inline, with:

   ```ts
   { text: "Export results…", glyph: "file-export", enabled: actions.canExportActive(),
     submenu: { label: "Export results…", items: () => buildExportFormatItems(
         actions.activeExportKind() === "plan" ? "plan" : "rows",
         format => actions.onExportResults(format)) } },
   ```

   `activeExportKind()` returns `"plan" | "tabular"`, so the ternary maps `"tabular"` onto the builder's `"rows"`.[^kind-vocabulary] Trim the comment above the item (lines 382-388): keep the part explaining why both the list and the submenu are providers, and drop the closing clause that spells out which labels each kind shows, since the builder owns that now.

8. **Checkpoint** — `grep -rn '"file-csv"' frontend/src/` returns exactly one match, in `menuItems.ts`.

**Refresh convergence**

9. **`frontend/src/shell/refreshTool.ts`** — replace the hand-rolled `Button({...})` plus `button.on("action", …)` in `refreshTool` with a single `return glyphButton("refresh", PRIMARY_COLOR, \`Refresh (${REFRESH_SHORTCUT})\`, onRefresh);`. Add `glyphButton` to the imports from `../dock/glyphButton`, add `REFRESH_SHORTCUT` to the existing `./queryShortcuts` import, and change `import { Button }` to `import type { Button }` (it now appears only as the return type; `verbatimModuleSyntax` is on). Update the module header's second sentence — it describes the `showText:false` mechanics that `glyphButton` now owns — to point at `glyphButton` instead.

10. **`frontend/src/shell/createSchemaTool.ts`** — replace the body of `createSchemaTool` with `return glyphButton("plus", PRIMARY_COLOR, "Create schema", onCreate);`. Import `glyphButton` from `../dock/glyphButton` and change `import { Button }` to `import type { Button }`.

11. **`frontend/src/shell/showDatabaseDiagramTool.ts`** — the same change with `return glyphButton("circle-nodes", PRIMARY_COLOR, "Show database diagram", onShow);`.

12. **`frontend/src/shell/QueriesView.ts`** — replace `actionButton`'s body (lines 361-378) with:

    ```ts
    return glyphButton(action.glyph, action.color, action.label, () => {
        const row = selected();

        if (row) {
            action.run(row);
        }
    });
    ```

    Import `glyphButton` from `../dock/glyphButton`, change `import { Button }` at line 27 to `import type { Button }` (line 189's `tools: Button[]` and the return type are the only remaining uses), and delete the two-line `showText:false` comment inside the function, which now describes `glyphButton`'s job.

13. **The six Refresh tooltips** — in [`IndexInfoPanel.ts:100`](frontend/src/dock/IndexInfoPanel.ts#L100), [`TableWorkPanel.ts:218`](frontend/src/dock/TableWorkPanel.ts#L218), [`definitionEditor.ts:85`](frontend/src/dock/definitionEditor.ts#L85), [`SequenceInfoPanel.ts:209`](frontend/src/dock/SequenceInfoPanel.ts#L209), and [`TypeInfoPanel.ts:163`](frontend/src/dock/TypeInfoPanel.ts#L163), replace the literal `"Refresh (Alt+R)"` with `` `Refresh (${REFRESH_SHORTCUT})` `` and add `import { REFRESH_SHORTCUT } from "../shell/queryShortcuts";` to each of the five files. `refreshTool.ts` is the sixth and was done in step 9. Leave the four `"Refresh columns"` / `"Refresh indexes"` / `"Refresh constraints"` / `"Refresh foreign keys"` labels in [`StructurePanel.ts:427,495,528,563`](frontend/src/dock/StructurePanel.ts#L427) alone — those name a section, not the accelerator, by an earlier deliberate decision ([`plans/implemented/panel-refresh-buttons.md:49`](plans/implemented/panel-refresh-buttons.md#L49)).

14. **Checkpoint** — `grep -rn 'Refresh (Alt+R)' frontend/src/` returns zero matches.

15. **`frontend/src/shell/SqlAdminShell.ts`** — change the glyph import at line 27 from `arrows_rotate` to `refresh` (`@jimka/typescript-ui/glyphs/solid/refresh`), swap the name in the `Glyph.register(...)` call at line 67, and change the View → Refresh item at line 414 to `glyph: "refresh"`. The comment above line 67 says "a rotate icon for the section refresh tools" — keep the sentence, name the glyph `refresh`.

16. **`frontend/src/navigator/objectMenu.ts`** — change the materialized-view Refresh item at line 182 to `glyph: "refresh"`.

17. **`frontend/src/navigator/NavigatorTree.ts`** — change the glyph import at line 21 from `arrows_rotate` to `refresh` and swap the name in the `Glyph.register(...)` call at line 45. The comment at line 36 mentions "the view-matview-ddl phase's refresh glyph"; it stays accurate.

18. **Checkpoint** — `grep -rn 'arrows_rotate\|arrows-rotate' frontend/src/ frontend/tests/` returns zero matches. A missed registration would render a blank button face, so this check is not optional.

19. **`frontend/src/dock/glyphButton.ts`** — the module header says the face is "Shared by the dock work panels". Widen that sentence: it is now the app's single owner of the glyph-only compact face, used by the dock panels, the sidebar rails' section tools, and the Queries rail's row actions. No code changes in this file.

**Chord matcher tests**

20. **`frontend/tests/shell/queryShortcuts.test.ts`** (new) — cover all ten matchers per `## Expected Behaviour` cases 7-11. Build events with a stub that defaults every modifier, including `shiftKey`, to `false`:

    ```ts
    function keyEvent(partial: Partial<KeyboardEvent>): KeyboardEvent {
        return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "", target: null, ...partial } as KeyboardEvent;
    }
    ```

    Drive the seven Alt matchers from one table of `{ name, matcher, key }` rows so a new chord is one row, and assert the mutual-exclusion property (case 8) by running every matcher against every row's chord.

21. **`frontend/tests/shell/shortcutRegistry.test.ts`** — delete the `describe("isHelpChord …")` block at lines 83-102 and drop `isHelpChord` from the import at line 9. `HELP_SHORTCUT` stays imported; line 50 still uses it.

22. **Verify** — run the checks in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/dock/menuItems.ts` |
| Modify | `frontend/src/dock/glyphButton.ts` (comment only) |
| Modify | `frontend/src/dock/IndexInfoPanel.ts` |
| Modify | `frontend/src/dock/TableWorkPanel.ts` |
| Modify | `frontend/src/dock/definitionEditor.ts` |
| Modify | `frontend/src/dock/SequenceInfoPanel.ts` |
| Modify | `frontend/src/dock/TypeInfoPanel.ts` |
| Modify | `frontend/src/shell/refreshTool.ts` |
| Modify | `frontend/src/shell/createSchemaTool.ts` |
| Modify | `frontend/src/shell/showDatabaseDiagramTool.ts` |
| Modify | `frontend/src/shell/QueriesView.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |
| Modify | `frontend/src/navigator/objectMenu.ts` |
| Modify | `frontend/src/navigator/NavigatorTree.ts` |
| Modify | `frontend/src/roles/RolesTree.ts` |
| Modify | `frontend/tests/dock/menuItems.test.ts` |
| Modify | `frontend/tests/shell/shortcutRegistry.test.ts` |
| Create | `frontend/tests/shell/queryShortcuts.test.ts` |

`frontend/src/dock/exportButton.ts`, `frontend/src/shell/queryShortcuts.ts`, and `frontend/src/shell/shortcutRegistry.ts` are read but not edited: `buildTableExportItems` and `REFRESH_SHORTCUT` keep their current shapes, and only `shortcutRegistry.ts`'s test changes.

---

## Expected Behaviour

Cases 1-11 are unit-testable in the node vitest harness. Cases 12-17 need manual verification: they are button faces, tooltips, and menus, which the harness cannot render.

**Export item builders** (`frontend/tests/dock/menuItems.test.ts`)

1. `buildExportFormatItems("rows", cb)` returns two items with texts `["CSV (.csv)", "JSON (.json)"]` and glyphs `["file-csv", "file-code"]`. Invoking the first item's action calls `cb("csv")`; the second calls `cb("json")`.
2. `buildExportFormatItems("plan", cb)` returns texts `["Text (.txt)", "JSON (.json)"]` and glyphs `["file-lines", "file-code"]`. The first item's action still calls `cb("csv")`; the second calls `cb("json")`.
3. `buildTableExportItems(onExport)` returns the case-1 items and wires `onExport`.
4. `buildQueryExportItems(null, notify)` returns `[]`, so its menu does not open.
5. `buildQueryExportItems({ kind: "rows", result }, notify)` returns the case-1 items; their actions call `exportQueryResult(result, "csv", notify)` and `exportQueryResult(result, "json", notify)`.
6. `buildQueryExportItems({ kind: "plan", plan }, notify)` returns the case-2 items; their actions call `exportExplainPlan(plan, "txt", notify)` and `exportExplainPlan(plan, "json", notify)`.

**Chord matchers** (`frontend/tests/shell/queryShortcuts.test.ts`)

7. Each Alt matcher returns `true` for its own chord. A matcher accepts both the lowercase and the uppercase `key` value, so the table exercises both spellings:

   | Event | Matcher returning `true` |
   |---|---|
   | `{ altKey: true, key: "n" }` | `isNewQueryChord` |
   | `{ altKey: true, key: "s" }` | `isOpenSavedChord` |
   | `{ altKey: true, key: "h" }` | `isQueryHistoryChord` |
   | `{ altKey: true, key: "d" }` | `isDatabasesRailChord` |
   | `{ altKey: true, key: "O" }` | `isRolesRailChord` |
   | `{ altKey: true, key: "q" }` | `isQueriesRailChord` |
   | `{ altKey: true, key: "R" }` | `isRefreshChord` |

8. The matchers are mutually exclusive: for each event in case 7, every other matcher — the six other Alt matchers plus `isExplainChord`, `isExplainAnalyzeChord`, and `isHelpChord` — returns `false`.
9. Every Alt matcher returns `false` when a second modifier is held: `{ altKey: true, ctrlKey: true, key: "r" }`, `{ altKey: true, metaKey: true, key: "r" }`, and `{ altKey: true, shiftKey: true, key: "r" }` are all `false` for `isRefreshChord`. So is `{ key: "r" }` with no Alt at all.
10. `isExplainChord` is `true` for `{ ctrlKey: true, key: "e" }`, `{ metaKey: true, key: "e" }`, and `{ ctrlKey: true, key: "E" }`; `false` for `{ ctrlKey: true, shiftKey: true, key: "e" }`, `{ ctrlKey: true, altKey: true, key: "e" }`, `{ key: "e" }`, and `{ ctrlKey: true, key: "f" }`. `isExplainAnalyzeChord` inverts the shift cases: `true` for `{ ctrlKey: true, shiftKey: true, key: "e" }` and `{ metaKey: true, shiftKey: true, key: "E" }`, `false` for `{ ctrlKey: true, key: "e" }` and `{ ctrlKey: true, shiftKey: true, altKey: true, key: "e" }`.
11. `isHelpChord` is `true` for `{ key: "?" }` with a null target, and `false` for any other key or when ctrl, meta, or alt is held. (Its editable-target branch reads the DOM and stays manual-verify, as the current test already notes.)

**Rendering and wiring** (manual)

12. Every Refresh button — the five dock tabs, the table data grid, and the three sidebar rails' section headers — renders the same icon it renders today. The glyph name changes; the artwork does not.
13. Hovering any of those Refresh buttons shows `Refresh (Alt+R)`, and Alt+R still refreshes the focused view. Hovering a Structure section's tool still shows `Refresh columns` / `Refresh indexes` / `Refresh constraints` / `Refresh foreign keys`.
14. The Databases rail's section header still shows its Create-schema (`plus`), database-diagram (`circle-nodes`), and Refresh tools as glyph-only faces with their tooltips; the Queries rail's Open / Remove / Save row actions still enable only while a row is selected.
15. A table or view's Export toolbar button, a role grants tab's Export button, and a query result's Export button each open a dropdown reading `CSV (.csv)` / `JSON (.json)`. With an EXPLAIN plan shown, the query panel's dropdown reads `Text (.txt)` / `JSON (.json)`, and each entry downloads the same file it does today.
16. Right-clicking a table in the navigator, then Export, shows `CSV (.csv)` / `JSON (.json)`; right-clicking a role in the Roles rail, then Export grants, shows the same pair. Both still download.
17. Tools → Export results is greyed out with nothing exportable, shows `CSV (.csv)` / `JSON (.json)` for a data or query-result tab, and `Text (.txt)` / `JSON (.json)` for a tab showing an EXPLAIN plan. View → Refresh still refreshes the active tab.

---

## Verification

Run from `frontend/`:

- `npm run typecheck` — clean.
- `npm test` — all suites green, including the updated `tests/dock/menuItems.test.ts`, the new `tests/shell/queryShortcuts.test.ts`, the trimmed `tests/shell/shortcutRegistry.test.ts`, and `tests/navigator/objectMenu.test.ts`, which already expects `["CSV (.csv)", "JSON (.json)"]` and must pass unchanged.
- `npm run build` — clean.

Grep invariants (from the repo root):

- `grep -rn 'arrows_rotate\|arrows-rotate' frontend/src/ frontend/tests/` — zero matches.
- `grep -rn 'Refresh (Alt+R)' frontend/src/` — zero matches.
- `grep -rn '"file-csv"' frontend/src/` — one match, in `frontend/src/dock/menuItems.ts`.
- `grep -rn 'showText' frontend/src/shell/` — no matches in `createSchemaTool.ts`, `showDatabaseDiagramTool.ts`, `refreshTool.ts`, or `QueriesView.ts`; what remains is `SqlAdminShell.ts`'s three `showText: true` menu-bar buttons and `localStorageWindow.ts`'s two.

Manual smoke test — log in and exercise `## Expected Behaviour` cases 12-17: the Databases, Roles, and Queries rails' section headers; a table's Data, Structure, and Definition tabs; a Sequence, Index, and Type info tab; a query panel with rows and with an EXPLAIN plan shown; the navigator and Roles context menus; and the View and Tools menus.

---

## Documentation Impact

None. No public API moves, and no documentation names any of the changed strings — `grep -rn 'Export CSV\|CSV (.csv)\|Refresh (Alt' README.md CHANGELOG.md frontend/src/shell/changelogText.ts` returns nothing. The `CHANGELOG.md` entry rides with the user's own release step, as in [`plans/implemented/adopt-dock-owned-teardown.md:403`](plans/implemented/adopt-dock-owned-teardown.md#L403).

---

## Potential Challenges

- **A missed glyph registration renders a blank button.** `Glyph.register` is global, so a name is only usable once some loaded module registers it; step 18's grep is the guard.
- **`objectMenu.ts` and `menuItems.ts` must both stay importable by the node test harness.** Neither touches `document` at import scope — `exportQueryResult.ts` and `exportExplainResult.ts` reach the DOM only inside function bodies, via `download()` — so `tests/navigator/objectMenu.test.ts` needs no new mocks. If it ever does, copy the two `vi.mock` lines from [`menuItems.test.ts:5-6`](frontend/tests/dock/menuItems.test.ts#L5).
- **`menuItems.test.ts` and the source must change together.** Step 4's expectations are the only place the old `"Export CSV (.csv)"` wording is asserted; leaving it lands a red suite.
- **`import type` matters here.** `verbatimModuleSyntax` is on, so a value import kept for a type-only use pulls the module at runtime; steps 9-12 change four of them.

---

## Critical Files

- [`frontend/src/dock/glyphButton.ts`](frontend/src/dock/glyphButton.ts) — the shared face, its three variants, and the doc explaining why `showDescription: false` is part of it.
- [`frontend/src/dock/menuItems.ts`](frontend/src/dock/menuItems.ts) — the item builders being extended, and the module header explaining why the file stays free of DOM references at import scope.
- [`frontend/src/dock/exportButton.ts:31`](frontend/src/dock/exportButton.ts#L31) — the precedent for composing `menuItems.ts` output into a button instead of re-typing the items.
- [`frontend/src/dock/QueryPanel.ts:309-311`](frontend/src/dock/QueryPanel.ts#L309) — the precedent for composing a tooltip from a shortcut constant.
- [`frontend/src/shell/queryShortcuts.ts`](frontend/src/shell/queryShortcuts.ts) — the constants and the ten matchers under test.
- [`frontend/tests/shell/shortcutRegistry.test.ts:83-102`](frontend/tests/shell/shortcutRegistry.test.ts#L83) — the `keyEvent` stub technique the new test file extends.
- [`frontend/tests/navigator/objectMenu.test.ts:103,211`](frontend/tests/navigator/objectMenu.test.ts#L103) — already asserts the short item wording; it pins that step 5 changes nothing observable.
- [`plans/implemented/panel-refresh-buttons.md:31-49`](plans/implemented/panel-refresh-buttons.md#L31) — where `glyphButton("refresh", …)` and the deliberately different Structure section labels were decided.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — section (b) on building child widgets as pre-`super()` locals, which several of the touched panels rely on.

---

## Non-Goals

- **The four DDL forms' row-remove buttons** ([`CreateTableForm.ts:159`](frontend/src/dock/CreateTableForm.ts#L159), [`EnumTypeForm.ts:136`](frontend/src/dock/EnumTypeForm.ts#L136), [`CompositeTypeForm.ts:156`](frontend/src/dock/CompositeTypeForm.ts#L156), [`FunctionForm.ts:200`](frontend/src/dock/FunctionForm.ts#L200)) also hand-roll the glyph-only face, but they belong to the add/remove-row grid convergence (audit finding #1), which absorbs all four files wholesale.
- **The menu bar's Shortcuts / Changelog / About buttons** ([`SqlAdminShell.ts:426-432`](frontend/src/shell/SqlAdminShell.ts#L426)) keep their hand-rolled bags: they are `showText: true, flat: true` text buttons, a different face that `glyphButton` does not build.
- **No change to what Alt+R does, where it is bound, or which tabs it reaches.** Only the tooltip's text source changes.
- **`activeExportKind()` keeps returning `"tabular"`.** Renaming it to `"rows"` would align the two vocabularies but touches the controller for no behaviour gain.
- **No shared `REFRESH_LABEL` constant.** Each of the six sites composes its tooltip inline from `REFRESH_SHORTCUT`, as the tooltip decision above specifies.[^no-label-constant]

---

## Notes

[^showdescription-noop]: `glyphButton` adds `showDescription: false` to every face it builds. None of the four converted buttons sets a description today, so adding it changes nothing on screen — the value is that a description added later cannot leak onto the face at one call site while staying in the tooltip at the others, which is exactly the drift `glyphButton.ts:15-20` documents.

[^no-label-constant]: A shared `REFRESH_LABEL = "Refresh (Alt+R)"` constant would collapse the six template literals into one import. It is not adopted: `QueryPanel.ts` already composes five such labels inline from the shortcut constants, no `*_LABEL` constant exists anywhere in `frontend/src/`, and the drift the audit found is between the tooltip's *key* and the real accelerator — which importing `REFRESH_SHORTCUT` fixes on its own.

[^glyph-artwork-identical]: The audit reports that the two names "render two different icons". They do not. `@jimka/typescript-ui/glyphs/solid/refresh` and `.../arrows_rotate` carry byte-identical `viewBox` and `path` data — the library ships the FontAwesome 5 alias and the FontAwesome 6 canonical name as two modules of the same drawing. So the real cost of keeping both is two registered names and two bundled glyph modules for one picture, plus a reader who cannot tell they are the same. Converging is still worth doing; it just must not be sold as fixing a visible inconsistency.

[^refresh-name-wins]: `"refresh"` wins over `"arrows-rotate"` on diff size. Ten call sites already use `"refresh"` (six Alt+R buttons plus `StructurePanel`'s four section tools) against three using `"arrows-rotate"`, and the loser's name appears in only two `Glyph.register` calls. Because the artwork is identical either way, no other criterion distinguishes them. Retiring `arrows_rotate` also drops one glyph module from the bundle.

[^no-move]: Moving `glyphButton.ts` to a neutral directory would touch its twelve dock importers and buy nothing: `queryShortcuts.ts` is the established example of a shared helper that stays in the directory it was written for and is imported across the tree. The file's header comment is widened instead (step 19) so its scope is not misread as dock-only.

[^why-new-builder]: The shell's Tools → Export results submenu cannot call `buildQueryExportItems`: that builder takes an `ActiveExport` and calls the exporters itself, while the shell holds neither — it dispatches through `actions.onExportResults(format)` and lets the controller resolve which tab is focused. Rather than duplicate the branch, the item pair moves down into `buildExportFormatItems`, which both surfaces compose. `buildTableExportItems` and `buildQueryExportItems` keep their names and signatures so their existing callers and tests are untouched.

[^short-label]: `"CSV (.csv)"` beats `"Export CSV (.csv)"` because every surface that shows these items already says "Export" somewhere the user just read: the submenu parents are `Export`, `Export grants`, and `Export results…`, and the three toolbar buttons carry tooltips `Export table (CSV / JSON)`, `Export grants (CSV / JSON)`, and `Export results (CSV / JSON)`. The long form would read "Export → Export CSV (.csv)". The short form is also the majority today (three sites to two) and the form `tests/navigator/objectMenu.test.ts` already asserts.

[^csv-token]: The plan's text export sits in the same slot as CSV and its callback still receives `"csv"`, not `"txt"`. That is the convention the app already runs on: `SqlAdminController.exportActive` takes `"csv" | "json"` and maps `"csv"` to the plan's text export, with a comment saying so, and `SqlAdminShell`'s submenu already calls `onExportResults("csv")` under a `Text (.txt)` label. Having the builder hand back `"txt"` instead would fit `exportExplainPlan` but break the shell's callback, which is the more widely used of the two.

[^kind-vocabulary]: Two vocabularies for the same distinction exist: `ActiveExport["kind"]` is `"rows" | "plan"` and `SqlAdminController.activeExportKind()` returns `"plan" | "tabular"`. The builder takes the first, because `menuItems.ts` already works in `ActiveExport` terms, and the shell maps at the call site. Renaming `"tabular"` to `"rows"` would remove the mismatch but is a controller change with no behavioural payoff, so it stays out (see `## Non-Goals`).

[^own-test-file]: The repo's tests mirror their module's path and name — `tests/dock/menuItems.test.ts` for `src/dock/menuItems.ts`, and so on — so ten matchers belonging to `queryShortcuts.ts` get `tests/shell/queryShortcuts.test.ts` rather than growing `shortcutRegistry.test.ts`, which tests a different module. The four `isHelpChord` cases move with them so the module's coverage is not split across two files.
