---
touches-shared:
  - frontend/src/contract.ts
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/navigator/objectMenu.ts
  - frontend/src/properties/PropertiesPanel.ts
  - frontend/src/shell/appRouter.ts
  - frontend/src/SqlAdminController.ts
  - backend/app/main.py
  - backend/app/operations/type_definition.py
---

# Type Info Tab — Implementation Plan

## Overview

Give the navigator's Types category the read-only info tab every other listed
object kind already has. Double-clicking a type leaf (or its new context-menu
"Show info" item) opens a Dock tab showing that type's category, owner, and
either its ordered enum labels or its ordered composite attributes.

Types are already a fully registered navigator kind — `{ kind: "type", glyph:
"cube", categoryLabel: "Types", isRelation: false }` at
[frontend/src/navigator/objectKinds.ts:48](frontend/src/navigator/objectKinds.ts#L48)
— with create/edit/drop DDL and a `ListTypesQuery` list endpoint. What is
missing is the read path: `NavigatorTree`'s `dblclick` chain has branches for
sequence, function, and index but none for type
([NavigatorTree.ts:151-185](frontend/src/navigator/NavigatorTree.ts#L151)), and
`typeMenuItems` offers only Edit and Drop
([objectMenu.ts:93-98](frontend/src/navigator/objectMenu.ts#L93)). So
double-clicking a type does nothing today.

The slice is thin because the backend already has a per-type detail query:
`TypeDefinitionQuery`
([backend/app/operations/type_definition.py:26](backend/app/operations/type_definition.py#L26))
returns one type's category plus its enum labels or composite attributes, and
is already exposed through `POST …/ddl/type-definition`
([main.py:1336](backend/app/main.py#L1336)) and `getTypeDefinition`
([api.ts:464](frontend/src/data/api.ts#L464)). This plan reuses that chain
whole, adds one `owner` column to it, and builds a new `TypeInfoPanel` plus a
`controller.openType` on the same seams `openIndex` uses.

---

## Architecture Decisions

### Reuse `TypeDefinitionQuery`, its route, and its client — do not add a per-type detail query

The info tab fetches through the existing `getTypeDefinition` /
`POST …/ddl/type-definition` / `TypeDefinitionQuery` chain, unchanged in shape.
No new `Query` class, no new route, no new API client function.[^reuse-type-definition]

### Add exactly one field to that chain: `owner`

`TypeDefinitionQuery._TYPE_SQL` gains `pg_get_userbyid(t.typowner) AS owner`,
`get_result()` returns it, and `TypeDefinition` (`contract.ts`) gains
`owner: string`. The existing consumer, `editType`
([SqlAdminController.ts:1579](frontend/src/SqlAdminController.ts#L1579)),
ignores the new field.[^owner-field]

### A type row that exists, not a non-empty child list, decides `NotFound`

`get_result()` currently raises `NotFound` when its child-row list `_raw` is
empty, which reports a real but empty enum or composite as a missing type.
The check moves onto the captured owner, which is set if and only if the
`pg_type` row was found.[^empty-type-notfound]

| `apply()` outcome | `_owner` | `_raw` | `get_result()` |
|---|---|---|---|
| no `pg_type` row | `None` | `[]` | raises `NotFound` |
| enum, 4 labels | `"sqladmin"` | 4 rows | `{category: "enum", labels: <the 4 labels>, attributes: [], owner: "sqladmin"}` |
| enum, 0 labels | `"sqladmin"` | `[]` | `{category: "enum", labels: [], attributes: [], owner: "sqladmin"}` |
| composite, 4 attributes | `"sqladmin"` | 4 rows | `{category: "composite", labels: [], attributes: <the 4 attributes>, owner: "sqladmin"}` |

### The panel copies `IndexInfoPanel`'s frame, with a grid where its editor sits

`TypeInfoPanel extends Container` with a `Border` layout: NORTH a `ToolBar`
holding a right-aligned Refresh button, CENTER a nested `Border` whose NORTH is
a `LabeledFieldSet` (Category, Owner) and whose CENTER is a read-only grid.
That frame is [IndexInfoPanel.ts:99-121](frontend/src/dock/IndexInfoPanel.ts#L99)
exactly, with `readOnlyTable` from
[columnsGrid.ts:67](frontend/src/dock/columnsGrid.ts#L67) replacing the
`CodeEditor`.[^panel-frame]

### Two grid shapes, chosen once at construction

The CENTER grid's columns depend on the type's category. An enum gets
`Order | Label`; a composite gets `Attribute | Type`. Both grids are built by
`readOnlyTable` over a `MemoryStore`, differing only in their `Model` fields
and row data.[^two-shapes]

| `detail.category` | Fieldset "Category" row | Grid columns | Rows for the seed type |
|---|---|---|---|
| `"enum"` | `Enum` | `Order`, `Label` | `public.priority_level` → `1 low`, `2 medium`, `3 high`, `4 urgent` |
| `"composite"` | `Composite` | `Attribute`, `Type` | `sales.mailing_address` → `street text`, `city text`, `postal_code text`, `country text` |

A category cannot change in place in PostgreSQL, so `reload` (the Refresh
path) never has to swap one grid for the other: it throws when the re-fetched
category differs from the one the tab was built with, and `refreshPanel`
([SqlAdminController.ts:654](frontend/src/SqlAdminController.ts#L654)) turns
that throw into the standard "failed to refresh: …" notification.[^category-flip]

### The menu item reads "Show info", placed above Edit and Drop

`typeMenuItems` becomes `Show info` / `Edit` / `Drop`, flat, no separator —
the shape `sequenceMenuItems` already uses
([objectMenu.ts:72-77](frontend/src/navigator/objectMenu.ts#L72)).[^show-info-naming]

### The Properties sidebar stays identity-only

`typeRows` ([PropertiesPanel.ts:97](frontend/src/properties/PropertiesPanel.ts#L97))
keeps its four Name/Schema/Database/Type rows. The category is not added.[^sidebar-identity-only]
The one edit to `PropertiesPanel.ts` is elsewhere in the file: `relationTypeLabel`
gains a `"type"` branch so the new tab's hover tooltip reads `Type: Type`
instead of falling through to `Type: Table`, exactly as the sequence and index
tabs each added a branch when they landed.

### The tab gets a deep link, like every other info tab

`appRouter.ts` gains `/schema/:schema/type/:name`, mirroring the `sequence` and
`index` registrations at
[appRouter.ts:160-186](frontend/src/shell/appRouter.ts#L160).[^deep-link]

---

## Public API

### Backend — `TypeDefinitionQuery` (`backend/app/operations/type_definition.py`, modified)

```python
# _TYPE_SQL gains one selected column: pg_catalog.pg_get_userbyid(t.typowner) AS owner
# __init__ gains one instance field:    self._owner: str | None = None
class TypeDefinitionQuery(Query):
    def __init__(self, conn: asyncpg.Connection, schema: str, name: str) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> dict:
        # {"category": "enum"|"composite",
        #  "labels": [str, ...],
        #  "attributes": [{"name": str, "type": str}, ...],
        #  "owner": str}
        # RuntimeError before apply(); NotFound when self._owner is None.
```

### Contract — `frontend/src/contract.ts`

```ts
export interface TypeDefinition {
    category: "enum" | "composite";
    labels: string[];                             // enum only (ordered); empty for a composite
    attributes: { name: string; type: string }[]; // composite only (attnum order); empty for an enum
    /** The role that owns the type (pg_get_userbyid(typowner)). */
    owner: string;
}
```

### Pure row mapping — `frontend/src/dock/typeInfoRows.ts` (new, DOM-free)

```ts
/** One row of the enum body grid: a label's 1-based catalog order and its text. */
export interface EnumLabelRow {
    position: number;
    label: string;
}

/** Number an enum's ordered labels 1..n for the info tab's grid. */
export function enumLabelRows(labels: string[]): EnumLabelRow[];

/** The Category row's display text: "enum" -> "Enum", "composite" -> "Composite". */
export function categoryLabel(category: TypeDefinition["category"]): string;
```

### Panel — `frontend/src/dock/TypeInfoPanel.ts` (new)

```ts
export interface TypeInfoPanelDeps {
    schema: string;
    name: string;

    /** Re-fetch this type's definition and reseed the tab in place. */
    onRefresh: () => void;
}

export class TypeInfoPanel extends Container {
    constructor(detail: TypeDefinition, deps: TypeInfoPanelDeps);

    /**
     * Reseed the Category/Owner rows and the body grid.
     * @throws Error when `detail.category` differs from the category the panel
     *   was constructed for — the grid's columns are fixed at construction.
     */
    reload(detail: TypeDefinition): void;
}
```

Exported through `callable()` per
[COMPONENT_CONVENTIONS.md](frontend/COMPONENT_CONVENTIONS.md) (d), exactly as
`IndexInfoPanel` is.

### Controller — `frontend/src/SqlAdminController.ts`

```ts
async openType(ref: DbObjectRef, node?: TreeNode): Promise<void>;
private typeInfoPanelId(ref: DbObjectRef): string; // `${this.panelId(ref)}::type`
```

---

## Internal Structure

### `TypeDefinitionQuery` changes

`_TYPE_SQL`'s select list gains one column:

```sql
SELECT t.oid, t.typtype::text AS typtype, t.typrelid,
       pg_catalog.pg_get_userbyid(t.typowner) AS owner
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = $1 AND t.typname = $2
```

`apply()` sets `self._owner = None` alongside `self._category = None` on the
missing-row path, and `self._owner = type_row["owner"]` on both the enum and
the composite path. `get_result()` keeps its `RuntimeError` guard on
`self._raw is None`, replaces `if not self._raw: raise NotFound` with
`if self._owner is None: raise NotFound`, and adds `"owner": self._owner` to
both returned dicts.

### `TypeInfoPanel` layout and body grid

Root `Border({spacing: 0})`: NORTH a `ToolBar({components: [Spacer.flex(),
glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", () =>
deps.onRefresh())]})`; CENTER a nested `Container` with
`Border({spacing: 0})` holding the `LabeledFieldSet` in NORTH and the body
grid in CENTER.

The fieldset's legend is `` `${deps.schema}.${deps.name}` `` (it must be
non-empty, or the fieldset's top border shows a gap where the legend notch
sits — see `IndexInfoPanel`'s identical note). Its two rows are `Category` and
`Owner`, each a `Text`.

Two module-level field lists, mirroring `columnsGrid.ts`'s `DISPLAY_FIELDS`:

```ts
const ENUM_FIELDS: FieldOptions[] = [
    { name: "position", type: "number", description: "Order", order: 1 },
    { name: "label",    type: "string", description: "Label", order: 2 },
];

const ATTRIBUTE_FIELDS: FieldOptions[] = [
    { name: "name", type: "string", description: "Attribute", order: 1 },
    { name: "type", type: "string", description: "Type",      order: 2 },
];
```

Two module-level helpers pick and fill them:

```ts
function bodyRows(detail: TypeDefinition): object[] {
    return detail.category === "enum" ? enumLabelRows(detail.labels) : detail.attributes;
}

function buildBodyGrid(detail: TypeDefinition): { grid: Table; store: MemoryStore } {
    const fields = detail.category === "enum" ? ENUM_FIELDS : ATTRIBUTE_FIELDS;
    const store  = new MemoryStore({ model: new Model({ fields }), data: bodyRows(detail), autoLoad: true });

    return { grid: readOnlyTable(store), store };
}
```

`detail.attributes` passes into the store unmapped — its `{name, type}` items
already match `ATTRIBUTE_FIELDS`, the same way `buildIndexesGrid` passes
`IndexMeta[]` straight through
([StructurePanel.ts:471-485](frontend/src/dock/StructurePanel.ts#L471)).

Panel fields: `_schema`, `_name` (both `readonly string`, for `reload`'s error
message), `_categoryText`, `_ownerText`, `_store`, and `_category` holding the
category the grid was built for. All six are `readonly` — `reload` only pushes
new values into the widgets and the store, and the category-mismatch guard
below means `_category` can never need reassigning. There is no `_detail`
field: nothing but the category is read back after construction.

```ts
reload(detail: TypeDefinition): void {
    if (detail.category !== this._category) {
        throw new Error(
            `${this._schema}.${this._name} is now a ${detail.category} type, `
            + `not ${this._category}; close and reopen the tab`,
        );
    }

    this._categoryText.setText(categoryLabel(detail.category));
    this._ownerText.setText(detail.owner);
    this._store.loadData(bodyRows(detail));
}
```

No `dispose`: the panel `extends`-es a library base, so the toolbar, the
fieldset's `Text` rows, and the grid are all registered descendants the Dock's
teardown reaches — the same reasoning `IndexInfoPanel`'s header comment states.

### `openType` (`frontend/src/SqlAdminController.ts`)

```ts
async openType(ref: DbObjectRef, node?: TreeNode): Promise<void> {
    const id = this.typeInfoPanelId(ref);

    if (this.dock.focusPanel(id)) {
        return;
    }

    this.openAsyncPanel({
        id,
        title  : ref.name ?? id,
        glyph  : "cube",
        tooltip: this.panelTooltip(ref),
        ref,
    }, async () => {
        const detail = await getTypeDefinition(ref);

        // Read by `refresh` only after a click, which always happens after
        // this variable is assigned just below — the forward reference is
        // safe (mirrors openIndex's `panel`).
        let panel: TypeInfoPanel;

        const refresh = (): void => void this.refreshPanel(ref, async () => {
            panel.reload(await getTypeDefinition(ref));
        });

        this._openPanels.set(id, { ref, node: node ?? null, detail: "info", refresh });
        this.syncToPanel(id);

        panel = new TypeInfoPanel(detail, { schema: ref.schema!, name: ref.name!, onRefresh: refresh });

        return panel;
    });
}
```

`node` is a plain `TreeNode | undefined`, not the `TreeNode |
Promise<TreeNode | undefined>` union `openSequence`/`openIndex` accept: those
two are reachable from `openReferencedSequence`/`openReferencedStructure`,
which hand over a still-pending reveal. Nothing opens a type by reference, so
the plain form (matching `openFunctionDefinition`
([SqlAdminController.ts:1407](frontend/src/SqlAdminController.ts#L1407))) is
enough.

---

## Ordered Implementation Steps

1. **`backend/app/operations/type_definition.py`** — add
   `pg_catalog.pg_get_userbyid(t.typowner) AS owner` to `_TYPE_SQL`'s select
   list. Add `self._owner: str | None = None` to `__init__`. In `apply()`, set
   `self._owner = None` on the missing-row path and
   `self._owner = type_row["owner"]` on the found path (once, before the
   enum/composite branch). In `get_result()`, replace
   `if not self._raw: raise NotFound(...)` with
   `if self._owner is None: raise NotFound(...)` (same message), and add
   `"owner": self._owner` to both returned dicts. Update the class and
   `get_result` docstrings to mention `owner` and the new not-found rule.

2. **`backend/tests/test_type_definition.py`** — set `op._owner = "sqladmin"`
   in `test_get_result_enum` and `test_get_result_composite`, and add
   `"owner": "sqladmin"` to both expected dicts. Set `op._owner = None` in
   `test_get_result_raises_not_found_when_absent`. Add
   `test_get_result_enum_with_no_labels`: `_owner = "sqladmin"`,
   `_category = "enum"`, `_raw = []` →
   `{"category": "enum", "labels": [], "attributes": [], "owner": "sqladmin"}`.
   Leave `test_get_result_before_apply_raises` untouched.

3. **`backend/app/main.py`** — update the `type_definition` route's docstring
   Returns line ([main.py:1348](backend/app/main.py#L1348)) to
   ``{"category", "labels", "attributes", "owner"}``. No code change.

4. **Checkpoint** — `cd backend && poetry run python -m pytest` (in a
   worktree use `python -m pytest`, not bare `pytest`). Green.

5. **`frontend/src/contract.ts`** — add `owner: string;` to `TypeDefinition`
   ([contract.ts:358](frontend/src/contract.ts#L358)), with the doc comment
   from _Public API_.

6. **`frontend/src/dock/typeInfoRows.ts`** — new DOM-free module with
   `EnumLabelRow`, `enumLabelRows`, and `categoryLabel` per _Public API_.
   Follow [structureRows.ts](frontend/src/dock/structureRows.ts)'s header-comment
   and JSDoc style; import `TypeDefinition` as `import type`.

7. **`frontend/tests/dock/typeInfoRows.test.ts`** — new. Cover the
   `enumLabelRows` and `categoryLabel` cases in _Expected Behaviour_.

8. **`frontend/src/dock/TypeInfoPanel.ts`** — new file, per _Internal
   Structure_. Class-first `extends Container`, `Glyph.register(refresh)` at
   module scope, exported through `callable()`. Import `readOnlyTable` from
   `./columnsGrid`, `glyphButton` from `./glyphButton`, `PRIMARY_COLOR` from
   `../theme`, and `enumLabelRows`/`categoryLabel` from `./typeInfoRows`. Copy
   [IndexInfoPanel.ts](frontend/src/dock/IndexInfoPanel.ts)'s import block and
   constructor ordering (locals built before `super()`, fields assigned after).

9. **`frontend/src/SqlAdminController.ts`** —
   - Add `import { TypeInfoPanel } from "./dock/TypeInfoPanel";` after the
     `IndexInfoPanel` import ([line 69](frontend/src/SqlAdminController.ts#L69)).
     `getTypeDefinition` and the `TypeDefinition` type are already imported
     (lines 28-29) — do not re-import them.
   - Add `openType` (see _Internal Structure_) right after `openIndex`
     ([line 802](frontend/src/SqlAdminController.ts#L802)), before
     `openStructure`. Give it a JSDoc block modelled on `openIndex`'s.
   - Add `typeInfoPanelId` right after `indexInfoPanelId`
     ([line 3178](frontend/src/SqlAdminController.ts#L3178)):
     `` private typeInfoPanelId(ref: DbObjectRef): string { return `${this.panelId(ref)}::type`; } ``
   - Update the three comments that count the storeless detail tabs from five
     to six, adding "type" to each list:
     [line 184-186](frontend/src/SqlAdminController.ts#L184) (`OpenPanel.refresh`),
     [line 644](frontend/src/SqlAdminController.ts#L644) (`refreshPanel`),
     [line 3090-3092](frontend/src/SqlAdminController.ts#L3090) (`refreshActive`).

10. **`frontend/src/navigator/objectMenu.ts`** —
    - Append `| "openType"` to the `ObjectMenuActions` Pick as a new final line
      ([objectMenu.ts:41](frontend/src/navigator/objectMenu.ts#L41)).
    - Give `typeMenuItems` a `node?: TreeNode` parameter and prepend the info
      item:
      ```ts
      function typeMenuItems(ref: DbObjectRef, actions: ObjectMenuActions, node?: TreeNode): MenuItemConfig[] {
          return [
              { text: "Show info", glyph: "cube", action: () => void actions.openType(ref, node) },
              { text: "Edit", glyph: "pencil", action: () => void actions.editType(ref) },
              { text: "Drop", glyph: "trash", action: () => actions.dropType(ref) },
          ];
      }
      ```
    - Update the `"type"` dispatch branch
      ([objectMenu.ts:224-226](frontend/src/navigator/objectMenu.ts#L224)) to
      `return typeMenuItems(ref, actions, node);`.
    - Update `typeMenuItems`' doc comment to mention showing its info.

11. **`frontend/tests/navigator/objectMenu.test.ts`** — add `openType: vi.fn(),`
    to `stubActions()`. Change the type-menu expectation to
    `["Show info", "Edit", "Drop"]`. Add a dispatch test: "Show info"'s action
    calls `actions.openType(ref, undefined)`.

12. **`frontend/src/navigator/NavigatorTree.ts`** — add a `"type"` branch to
    the `dblclick` handler, after the `"index"` branch and before the
    `isRelation` check ([NavigatorTree.ts:174-184](frontend/src/navigator/NavigatorTree.ts#L174)):
    ```ts
    // A type has no rows either — double-click opens its read-only info
    // tab, mirroring the sequence and index branches above.
    if (ref && ref.kind === "type") {
        void this.controller.openType(ref, node);

        return;
    }
    ```

13. **`frontend/src/properties/PropertiesPanel.ts`** — add a `"type"` branch to
    `relationTypeLabel`, after the `"index"` branch
    ([PropertiesPanel.ts:142-144](frontend/src/properties/PropertiesPanel.ts#L142)):
    `if (kind === "type") { return "Type"; }`, with a comment matching the two
    above it. Leave `typeRows` unchanged.

14. **`frontend/src/shell/appRouter.ts`** — register the type route after the
    `index` route ([appRouter.ts:186](frontend/src/shell/appRouter.ts#L186)),
    copying that block's shape:
    ```ts
    router.register("/schema/:schema/type/:name", params => dispatch(controller, () => {
        const ref: DbObjectRef = {
            connectionId: controller.connectionId,
            database    : controller.database,
            schema      : params.schema,
            name        : params.name,
            kind        : "type",
        };

        controller.selectObject(ref);

        return controller.openType(ref);
    }));
    ```

15. **Checkpoints:**
    - `cd frontend && npm run typecheck` — clean.
    - `cd frontend && npm test` — green, including the new
      `typeInfoRows.test.ts` and the updated `objectMenu.test.ts`.
    - `grep -rln "openType" frontend/src/` — exactly four files:
      `navigator/objectMenu.ts`, `navigator/NavigatorTree.ts`,
      `SqlAdminController.ts`, `shell/appRouter.ts`.
    - `grep -rn "::type" frontend/src/SqlAdminController.ts` — one hit, in
      `typeInfoPanelId`.
    - `grep -rn "not self._raw" backend/app/operations/type_definition.py` —
      zero matches.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `backend/app/operations/type_definition.py` (`owner` column + field, `NotFound` rule) |
| Modify | `backend/app/main.py` (`type_definition` route docstring) |
| Modify | `backend/tests/test_type_definition.py` (`owner` in expectations, empty-enum case) |
| Modify | `frontend/src/contract.ts` (`TypeDefinition.owner`) |
| Create | `frontend/src/dock/typeInfoRows.ts` |
| Create | `frontend/tests/dock/typeInfoRows.test.ts` |
| Create | `frontend/src/dock/TypeInfoPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` (`openType`, `typeInfoPanelId`, import, tab-count comments) |
| Modify | `frontend/src/navigator/objectMenu.ts` (`openType` in the Pick, `typeMenuItems`, dispatch) |
| Modify | `frontend/tests/navigator/objectMenu.test.ts` (type-menu items + dispatch) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (`dblclick` type branch) |
| Modify | `frontend/src/properties/PropertiesPanel.ts` (`relationTypeLabel` type branch) |
| Modify | `frontend/src/shell/appRouter.ts` (`/schema/:schema/type/:name`) |

`frontend/src/navigator/objectKinds.ts`, `objectGlyphs.ts`, `frontend/src/data/api.ts`,
`backend/app/operations/list_types.py`, and `backend/app/operations/__init__.py`
need **no** change: the `type` kind, its `cube` glyph, and `getTypeDefinition`
already exist.

---

## Expected Behaviour

**Backend, unit-testable (`backend/tests/test_type_definition.py`, hand-set
`_owner`/`_category`/`_raw` in the file's existing style):**

- `_owner = "sqladmin"`, `_category = "enum"`,
  `_raw = [{"enumlabel": "sad"}, {"enumlabel": "ok"}]` → `{"category": "enum",
  "labels": ["sad", "ok"], "attributes": [], "owner": "sqladmin"}`.
- `_owner = "sqladmin"`, `_category = "composite"`,
  `_raw = [{"name": "street", "type": "text"}]` → `{"category": "composite",
  "labels": [], "attributes": [{"name": "street", "type": "text"}],
  "owner": "sqladmin"}`.
- `_owner = "sqladmin"`, `_category = "enum"`, `_raw = []` →
  `{"category": "enum", "labels": [], "attributes": [], "owner": "sqladmin"}`
  (an empty enum is a real type, not a 404).
- `_owner = None`, `_raw = []` → raises `NotFound`.
- `get_result()` before `apply()` (`_raw is None`) → raises `RuntimeError`.

**Frontend pure logic, unit-testable (`frontend/tests/dock/typeInfoRows.test.ts`,
vitest, in [structureRows.test.ts](frontend/tests/dock/structureRows.test.ts)'s
style):**

- `enumLabelRows(["low", "medium", "high", "urgent"])` →
  `[{position: 1, label: "low"}, {position: 2, label: "medium"},
  {position: 3, label: "high"}, {position: 4, label: "urgent"}]` — input order
  preserved, positions 1-based.
- `enumLabelRows([])` → `[]`.
- `categoryLabel("enum")` → `"Enum"`; `categoryLabel("composite")` → `"Composite"`.

**Frontend menu structure, unit-testable
(`frontend/tests/navigator/objectMenu.test.ts`):**

- `buildObjectMenuItems(typeRef(), stubActions())` → item texts
  `["Show info", "Edit", "Drop"]`.
- Invoking "Show info"'s action calls `actions.openType(ref, undefined)`.
- Every other kind's menu is unchanged.

**Manual-verify (live navigator/Dock; the harness cannot drive tree events or
grid rendering — smoke via `npm run dev` against the seed database, whose
three standalone types are `public.priority_level`, `sales.mailing_address`,
and `hr.employment_status`, all owned by `sqladmin`):**

- Double-clicking `public.priority_level` opens a tab titled `priority_level`
  with the `cube` glyph. The fieldset legend reads `public.priority_level`,
  Category reads `Enum`, Owner reads `sqladmin`, and the grid shows
  `Order | Label` rows `1 low`, `2 medium`, `3 high`, `4 urgent` in that order.
- Double-clicking `sales.mailing_address` opens a tab whose Category reads
  `Composite` and whose grid shows `Attribute | Type` rows `street text`,
  `city text`, `postal_code text`, `country text` in that order.
- Double-clicking `hr.employment_status` opens an enum tab with three rows —
  the Types category and its tab work outside `public`.
- Right-clicking any type leaf shows exactly `Show info`, `Edit`, `Drop`.
  "Show info" opens the same tab a double-click does.
- Re-opening an already-open type tab (double-click again, or "Show info"
  again) focuses the existing tab rather than opening a duplicate.
- With the `priority_level` tab open, right-click the leaf → Edit → add value
  `critical`, execute, then press Alt+R (or the tab's Refresh button) on the
  tab: a fifth row `5 critical` appears and the status bar reads
  `… · priority_level: refreshed`.
- Hovering the tab shows `Type: Type`, `Schema: public`, `Database: sqladmin`
  — not `Type: Table`.
- Single-clicking a type leaf still shows the four Name/Schema/Database/Type
  rows in the Properties sidebar (unchanged).
- Visiting `/schema/sales/type/mailing_address` opens the composite tab and
  selects that leaf in the navigator.
- Dropping a type while its info tab is open leaves the tab open showing the
  now-stale detail; pressing Refresh on it reports `failed to refresh: …`
  (deliberate — see Non-Goals).
- Regression: double-clicking a table, view, sequence, function, or index
  behaves exactly as before, and their context menus are unchanged.

---

## Verification

- `cd backend && poetry run python -m pytest` — the updated
  `test_type_definition.py` green, full suite green.
- `cd frontend && npm run typecheck` — clean (the new panel, controller method,
  contract field, and router route all resolve).
- `cd frontend && npm test` — new `typeInfoRows.test.ts` and updated
  `objectMenu.test.ts` green.
- Grep invariants per step 15.
- Manual smoke per _Expected Behaviour_. Entry point: the navigator tree in the
  WEST sidebar, Types category, against the seed database (`docker compose up
  -d db`, then `npm run dev`).

---

## Potential Challenges

- **The detail fetch is a POST, not a GET.** `getTypeDefinition` posts to
  `…/ddl/type-definition` behind `require_csrf`, so opening the tab needs a
  valid CSRF token. That token is already set for the whole session, and
  `editType` has used this route since the function-type-ddl phase — so no new
  failure mode, but do not "fix" the tab by adding a GET route (see
  Architecture Decisions).
- **`{ name: "type", type: "string" }` looks like a typo.** In
  `ATTRIBUTE_FIELDS` the field is *named* `type` and its declared type is
  `string`; that is deliberate, so `TypeDefinition.attributes` items load into
  the store unmapped.
- **Two open type tabs must not share a `Model`.** `buildBodyGrid` constructs
  its `Model` per call, like `buildIndexesGrid`; do not hoist it to a module
  constant (only the `FieldOptions[]` arrays are shared).
- **`relationTypeLabel("type")` returning `"Type"` reads oddly in the tooltip
  ("Type: Type").** It matches what `typeRows` already shows in the Properties
  sidebar; renaming either label is out of scope.

---

## Critical Files

- [frontend/src/dock/IndexInfoPanel.ts](frontend/src/dock/IndexInfoPanel.ts) —
  the panel frame (toolbar NORTH, nested Border, `LabeledFieldSet` + body,
  `reload`, no `dispose`) this plan copies.
- [frontend/src/SqlAdminController.ts:760](frontend/src/SqlAdminController.ts#L760) —
  `openIndex`, the `openAsyncPanel` + dedupe + `refreshPanel` idiom `openType`
  mirrors; and `refreshPanel` at [line 654](frontend/src/SqlAdminController.ts#L654).
- [frontend/src/dock/columnsGrid.ts:67](frontend/src/dock/columnsGrid.ts#L67) —
  `readOnlyTable`, the shared read-only grid both body shapes use.
- [frontend/src/dock/StructurePanel.ts:471](frontend/src/dock/StructurePanel.ts#L471) —
  `buildIndexesGrid`/`buildConstraintsGrid`, the `Model` + `MemoryStore` +
  `readOnlyTable` composition `buildBodyGrid` follows.
- [frontend/src/dock/structureRows.ts](frontend/src/dock/structureRows.ts) —
  the DOM-free pure row-mapping module `typeInfoRows.ts` mirrors.
- [backend/app/operations/type_definition.py](backend/app/operations/type_definition.py) —
  the query being extended; read its `typtype::text` cast comment before
  touching `_TYPE_SQL`.
- [backend/app/operations/sequence_detail.py:41](backend/app/operations/sequence_detail.py#L41) —
  the `owner` column precedent on a detail query.
- [frontend/src/navigator/objectMenu.ts:72](frontend/src/navigator/objectMenu.ts#L72) —
  `sequenceMenuItems`, the flat "Show info" + mutating-actions menu shape.
- [frontend/COMPONENT_CONVENTIONS.md](frontend/COMPONENT_CONVENTIONS.md) —
  class-first components, the super-cascade trap, and the `callable()` export.
- [plans/implemented/navigator-indexes-category.md](plans/implemented/navigator-indexes-category.md),
  [plans/implemented/sequence-info-tab.md](plans/implemented/sequence-info-tab.md),
  and [plans/implemented/function-type-ddl.md](plans/implemented/function-type-ddl.md) —
  the three prior info-tab / new-kind phases this plan follows.

---

## Non-Goals

- **No in-place composite-type restructuring** (`ALTER TYPE … ADD/DROP/ALTER
  ATTRIBUTE`) — a stated Non-Goal of the function-type-ddl phase and unchanged
  here. The tab is read-only.
- **No domain or range types** — `ListTypesQuery` lists only `typtype IN ('e',
  'c')`, so no domain or range ever reaches this tab. Do not widen that filter.
- **No change to the create/edit/drop type DDL flows** — `createType`,
  `editType`, and `dropType` keep their current code, including `dropType`'s
  not closing an open info tab (which matches `dropSequence`; only
  `dropFunction` closes its tab, and aligning the three is separate work). The
  one behaviour that does shift is `editType`'s on an empty enum or composite,
  because it shares the query whose not-found rule changes — see that decision.
- **No editing from the info tab** — enum labels are appended through the
  existing Edit dialog; the tab has no Save.
- **No live refresh or polling** — a point-in-time read on open, matching every
  other info tab. Refresh is an explicit button and Alt+R.
- **No new detail query, route, or API client** — the existing
  `TypeDefinitionQuery` chain is reused whole.
- **No category in the Properties sidebar and no widening of `DbObjectRef`,
  `ListTypesQuery`, or `getTypes`** — see the sidebar decision.
- **No synthesized `CREATE TYPE` text in the tab** — PostgreSQL has no
  `pg_get_typedef`, so any such text would be a client-driven reconstruction
  through the DDL preview endpoints, not catalog truth.

---

## Notes

[^reuse-type-definition]: `TypeDefinitionQuery` is already a per-object detail
    query scoped to one type by schema + name, already fetched fresh per call,
    and already returns the category and the label/attribute list the tab
    renders. That removes the
    problem `navigator-indexes-category` solved with a dedicated
    `IndexDetailQuery`: there, the only existing source was the schema-wide
    `/indexes` list, so reusing it would have meant fetching every index in the
    schema to show one. Here nothing is over-fetched. Two alternatives were
    considered and rejected. (a) A new `GET
    /api/{c}/{db}/{schema}/{name}/type` route onto the same query, for symmetry
    with `/sequence` and `/index`: it would give one query two routes and one
    fact two clients, which is the near-duplication
    `navigator-indexes-category`'s own "reuse `SchemaIndexesQuery`" note argues
    against. (b) Carrying the category and labels on `DbObjectRef` from
    the navigator's `/types` list, skipping the fetch entirely: rejected for
    the same reason that plan rejected it for indexes — it breaks the
    fetch-fresh-on-open shape every info tab shares, and grows the ref with
    data carried for a node's whole lifetime.

[^owner-field]: `SequenceDetailQuery` already selects an `owner` column
    (`pg_sequences.sequenceowner`,
    [sequence_detail.py:41](backend/app/operations/sequence_detail.py#L41)) and
    `SequenceInfoPanel` shows it, so "owning role" is an established field on an
    info tab for a non-relation kind. Adding it costs nothing at runtime: the
    `pg_type` row is already fetched by `_TYPE_SQL`, so `pg_get_userbyid` rides
    along on an existing round trip. Without it the identity fieldset would
    carry a single row (Category), which is thin next to the sequence tab's ten
    and the index tab's three. `pg_get_userbyid` never returns SQL NULL — it
    renders a dropped role as `unknown (OID=N)` — which is what lets the
    captured owner double as the "the type exists" flag in the `NotFound` rule.

[^empty-type-notfound]: `CREATE TYPE t AS ENUM ()` and `CREATE TYPE t AS ()`
    are both valid PostgreSQL, and `ListTypesQuery` lists the resulting types,
    so the navigator can show a leaf whose detail fetch 404s. Before this
    change the only "did the type exist" evidence surviving `apply()` was the
    child-row list, which is empty in exactly those two cases. Capturing the
    owner supplies unambiguous evidence, so the fix falls out of the `owner`
    column rather than being separate work. The knock-on is that `editType`
    also stops erroring on an empty enum and opens its Add-value form instead —
    an improvement, and no `editType` code changes.

[^panel-frame]: The three prior info tabs disagree on frame, so the choice is
    explicit. `FunctionDefinitionPanel` is a single editable `CodeEditor` —
    wrong here, because a type has no catalog-authoritative definition text to
    show (there is no `pg_get_typedef`) and the tab is read-only.
    `SequenceInfoPanel` is a `LabeledFieldSet` of one typed input per attribute
    — wrong here, because a type's payload is a variable-length ordered list,
    not a fixed set of named scalars, so it has no fixed row count to lay out.
    `IndexInfoPanel` is the fit: a small fixed fieldset of identity facts above
    one large payload region, with a Refresh button and nothing else. Only the
    payload region's content differs — a grid instead of a SQL editor.

[^two-shapes]: `readOnlyTable` already backs four grids (relation Columns,
    Indexes, Constraints, Foreign Keys), so no new grid abstraction is needed;
    the two shapes differ only in `Model` fields and rows. Both grids get two
    columns, but for different reasons. The composite grid mirrors
    `columnsGrid.ts`'s leading `Column`/`Type` pair, which is how this codebase
    already renders an ordered attribute list — and, following that precedent,
    it carries no ordinal column even though a composite's attribute order
    matters. The enum grid deliberately deviates and adds a leading `Order`
    column: an enum's label order is semantic (it drives `<` and `ORDER BY` on
    the type, unlike a composite's positional-only attribute order), and a
    sortable single-column grid would lose that order the moment a user clicks
    the header. `AddEnumValueForm`'s comma-joined `Text` line
    ([AddEnumValueForm.ts:38](frontend/src/dock/AddEnumValueForm.ts#L38)) was
    considered and rejected for the enum body: it is a reference hint inside a
    dialog, and as a tab's primary content it neither scrolls nor numbers nor
    allows per-row selection, and wraps badly for a long enum.

[^category-flip]: PostgreSQL has no statement that converts an enum to a
    composite or back, so the only way a tab's category changes under it is a
    DROP plus a CREATE from elsewhere while the tab stays open — rare enough
    that rebuilding the tab's grid in place is not worth the machinery, but
    common enough that silently loading composite rows into an enum-shaped
    store (which renders blank cells) is not acceptable. Throwing from `reload`
    costs one `if` and reuses the error path `refreshPanel` already wraps every
    Refresh in, so the user sees "failed to refresh: public.x is now a
    composite type, not enum; close and reopen the tab" through the same
    notification every other failed refresh uses.

[^show-info-naming]: The codebase splits the two names by what the tab holds:
    "Show definition" fronts a tab showing catalog-authoritative SQL text
    (`openDefinition` for a view's `pg_get_viewdef`, `openFunctionDefinition`
    for `pg_get_functiondef`), while "Show info" fronts a tab of structured
    facts (`openSequence`, `openIndex` — the latter despite also showing
    `indexdef`, because its identity rows lead). A type tab has no
    catalog-authoritative text at all, so "Show info" is the only fitting name.
    The item leads the menu because it is the read action, matching
    `sequenceMenuItems` and `indexMenuItems`; no separator is added, because
    `sequenceMenuItems` puts "Show info" directly above its "Drop" too.

[^sidebar-identity-only]: Two reasons. First, precedent: `sequenceRows` is
    identity-only while `SequenceInfoPanel` carries ten fields, and the
    function-type-ddl phase's own `typeRows` comment already states the rule —
    "the Properties inspector never round-trips per selection for a
    non-relation kind". Second, cost: the category is genuinely not cheap to
    get there. `ListTypesQuery` selects `typname` only
    ([list_types.py:29-38](backend/app/operations/list_types.py#L29)) and
    `getTypes` returns `{name: string}[]`, so surfacing the category in the
    sidebar would mean widening the query, the route's wire shape, `getTypes`,
    `NavigatorTree`'s `DbObject`, `objectLeaf`, and `DbObjectRef` — the whole
    registry seam — to populate one sidebar row. The fields `DbObjectRef`
    already carries beyond identity (`signature`, `isProcedure`, `table`) each
    earned their place by serving a tree label or an action's correctness; a
    type's category serves neither.

[^deep-link]: Every other info tab is addressable —
    `/schema/:schema/sequence/:name`, `/schema/:schema/index/:name`, and
    `/schema/:schema/function/:name` all exist, and the 0.6.0 changelog lists
    deep links for "table, view, schema, database, role, sequence, index,
    function, or notes". Leaving types out would make this the only info tab in
    the app without one, which contradicts the feature's goal of matching every
    other listed kind. The registration is twelve lines copied from the `index`
    route with the kind swapped, needs no `routeTargets.ts` change (a type is
    not a relation kind and has no view segments), and needs no test change
    (`appRouter.ts` is DOM-coupled and untested; `routeTargets.test.ts` covers
    only the pure vocabulary). `matchesObject`
    ([revealMatch.ts:49](frontend/src/navigator/revealMatch.ts#L49)) already
    compares kind generically, so `controller.selectObject` reveals a type leaf
    with no change.

---

## Implementation Notes

**`openType` initially omitted the deep-link route wiring the plan's own
"gets a deep link, like every other info tab" Architecture Decision
promises, and the audit caught it.** The plan's "Internal Structure" code
sample for `openType` never computed `objectPath(ref)` or passed a `route`
into `openAsyncPanel` (unlike `openIndex`'s identical-shaped sample, which
does), and `routeTargets.ts`'s `objectPath()` still explicitly returned
`null` for `ref.kind === "type"` with a comment claiming "type (no route)
has no per-object path" — stale the moment `appRouter.ts` registered a real
`/schema/:schema/type/:name` route. The implementer followed the plan's
sample verbatim, so the omission originated in the plan, but the resulting
behavior was a real regression from the stated goal: visiting the deep link
opened the tab but the address bar snapped back to `/` immediately after
(the dock's "focus" handler falls back to `{path: "/"}` when
`_panelRoutes` has no entry for the panel), and double-clicking/"Show
info"-ing any type leaf did the same instead of advancing the address bar
to the type's URL. Fixed by adding the `route`/`objectPath` computation to
`openType` (mirroring `openIndex`) and adding a `"type"` case to
`objectPath()` alongside its existing `"sequence"`/`"index"` case
(`frontend/src/shell/routeTargets.ts`), with `routeTargets.test.ts`'s
stale "returns null for a type ref" case replaced by a positive
"builds a type path" case. Confirmed live afterward (see below) — both
directions of the deep link now work.

**Manual-verify was completed live for every item except one.** A live
chrome-devtools session against the seed database confirmed: opening
`public.priority_level` renders the exact fieldset/grid content specified
(Category `Enum`, Owner `sqladmin`, rows `1 low`/`2 medium`/`3 high`/`4
urgent`); opening `sales.mailing_address` renders Category `Composite` with
rows `street text`/`city text`/`postal_code text`/`country text`;
right-clicking a type leaf shows exactly `Show info` / `Edit` / `Drop` and
"Show info" opens the tab; the open tab's tooltip reads `priority_level\n\n
Type: Type\nSchema: public\nDatabase: sqladmin` (confirming
`relationTypeLabel`'s new `"type"` branch); single-clicking a type leaf
still shows only the four identity rows in the Properties sidebar; and,
after the fix above, visiting `/schema/sales/type/mailing_address` directly
opens the composite tab with the `sales` schema and `Types` category
expanded and `mailing_address` selected, the address bar staying at that
path — and double-clicking a type leaf from a fresh navigation likewise
advances the address bar to the type's URL (confirmed via both a direct
`location.pathname` read and the navigation tool's own "Page navigated to
…" report). Not covered live: `hr.employment_status` (a second schema) and
the Edit-then-Refresh cycle (a 5th enum value appearing after `reload()`)
— the session ran long and these two were judged lowest-risk to leave as
code-level review rather than extend it further: the schema is passed
through generically everywhere (no hardcoded `"public"` anywhere in the
query, `openType`, or the route), and `reload()` delegates to the same
already-tested `typeInfoRows` helpers the initial render uses, wired through
the same `refreshPanel` helper `openIndex`/`openSequence` already ship with.
An explicit live regression pass on table/sequence/index double-click was
also not re-run after the initial interruption, but the diff to
`NavigatorTree.ts`/`objectMenu.ts` touches no existing kind's branch (purely
additive — see the code commit), and the full frontend suite (813 tests,
including every other kind's menu/dispatch case) stays green throughout.
Also incidental: the grid headers render the raw field names
(`position`/`label`, `name`/`type`) rather than the `description` strings
("Order"/"Label", "Attribute"/"Type") — confirmed against `Header.ts` in
`typescript-ui` that `description` only feeds the header cell's hover
tooltip, matching every other `readOnlyTable` grid in the app (e.g.
`StructurePanel`'s Indexes/Constraints grids), so this is existing platform
behavior, not a defect.

One environment note, not a code change: the shared local `sqladmin-db`
container's data predates this seed file's `public.priority_level` and
`hr.employment_status` types (only `sales.mailing_address` existed), so the
enum-tab checks above ran against a temporary `CREATE TYPE
public.priority_level` issued directly through `psql`, dropped again once
each check was done. Separately, the live sessions twice hit an unrelated
environment snag worth flagging for future manual-verify runs in this
repo: an already-running frontend dev server (from the main tree, on the
default port 5173) silently absorbs port 5173 before a worktree's own `npm
run dev` binds it, pushing the worktree's server onto 5173+1 — always
confirm the actually-served origin (e.g. `curl .../src/shell/appRouter.ts`
for a route just added) rather than assuming the default port is the
worktree under test.
