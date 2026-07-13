---
touches-shared:
  - frontend/src/navigator/NavigatorTree.ts
  - frontend/src/SqlAdminController.ts
  - frontend/src/data/api.ts
  - frontend/src/contract.ts
  - backend/app/main.py
  - backend/app/operations/__init__.py
---

# Sequence Info Tab — Implementation Plan

## Overview

Double-clicking a sequence node in the navigator (or its context-menu "Show info") opens a read-only Dock tab showing that sequence's current state and parameters: current value (`last_value`), start value, increment, min/max value, cache size, cycle flag, data type, and owner. Today the sequence leaf is `isRelation: false` ([objectKinds.ts:43](frontend/src/navigator/objectKinds.ts#L43)), so double-click does nothing ([NavigatorTree.ts:117](frontend/src/navigator/NavigatorTree.ts#L117)) and the only sequence actions are "Alter sequence…" / "Drop sequence…" ([NavigatorTree.ts:172](frontend/src/navigator/NavigatorTree.ts#L172)) — which collect new values blind because the user cannot see the current ones.

The slice is a thin read: a new `SequenceDetailQuery` op reads `pg_sequences` in one round trip; a `/sequence` route exposes it; a `getSequenceDetail` client fetches it; and a new `SequenceInfoPanel` (a read-only Property/Value grid) renders it in a deduped Dock tab, opened via a new `controller.openSequence(ref, node)`. It mirrors the `openDefinition`/`DefinitionPanel` tab idiom ([SqlAdminController.ts:365](frontend/src/SqlAdminController.ts#L365), [DefinitionPanel.ts](frontend/src/dock/DefinitionPanel.ts)) exactly.

This lands on `feature/schema-sequence-ddl`. Six files below are also touched by phase 5 (`feature/function-type-ddl`), which the parent will rebase onto this branch afterward — keep every shared-file edit **additive** (append a route/export/case; never rewrite an existing line) so the rebase stays trivial.

---

## Architecture Decisions

### Read `pg_sequences` directly — it already carries owner and data type

A single-table read of `pg_catalog.pg_sequences` (Postgres 10+) supplies **every** required field. Verified against the seed DB (PG 16.14) — its columns are `schemaname, sequencename, sequenceowner, data_type (regtype), start_value, min_value, max_value, increment_by, cycle, cache_size, last_value`. This **supersedes the parent brief's assumption** that data type and owner are absent from `pg_sequences` and must be joined via `pg_type`/`pg_get_userbyid` — they are not; no join is needed. Exact SQL:

```sql
SELECT sequenceowner AS owner,
       data_type::text AS data_type,
       start_value, min_value, max_value,
       increment_by, cache_size, cycle, last_value
FROM pg_catalog.pg_sequences
WHERE schemaname = $1 AND sequencename = $2
```

Both identifiers are bound (`$1`/`$2`), never interpolated — mirrors `ViewDefinitionQuery` ([view_definition.py:28](backend/app/operations/view_definition.py#L28)). Zero rows → `NotFound` (404), same as the view route.

### Serialize numeric values as strings — bigint exceeds JS safe-integer range

`start_value`/`min_value`/`max_value`/`increment_by`/`cache_size`/`last_value` are `bigint`. A bigint sequence's default `max_value` is `9223372036854775807`, far past `Number.MAX_SAFE_INTEGER` (`9007199254740991`), so a JSON number would silently lose precision. `get_result()` converts each present int to `str`; the panel displays the string verbatim. `cycle` stays a JSON boolean.

### `last_value` is nullable — render "—"

`pg_sequences.last_value` is `NULL` when the sequence has never been read **or** when the current role lacks `USAGE`/`SELECT` on it. `get_result()` maps `None → null`; the pure row-builder renders `null` as `"—"`. All other columns are always non-null for an existing sequence.

### Not a relation — keep `isRelation: false`; special-case the sequence branch

A sequence has no rows, so it is not a data grid. `objectKinds.ts` stays untouched (`isRelation: false`). Instead, `NavigatorTree`'s `dblclick` handler gets an explicit `ref.kind === "sequence"` branch calling `openSequence` (mirroring how the schema branch is special-cased ahead of the `isRelation` guard in `contextmenu`), and the existing sequence context menu gains a "Show info" item calling the same method.

### Read-only Property/Value grid, extracted pure row-builder

The panel is a read-only Property/Value table filling the tab — the same store/Table shape as `PropertyValuePanel` ([PropertyValuePanel.ts](frontend/src/properties/PropertyValuePanel.ts)) but tab-sized (a `Fit` layout, no fixed 220px height). Per the "tsui DOM module side effects" convention, the `SequenceDetail → rows` mapping (including `null last_value → "—"` and `cycle → "Yes"/"No"`) lives in a **DOM-free** module `frontend/src/data/sequenceInfoRows.ts`, unit-testable under the node vitest harness (matching `buildPlanSteps.ts`/`groupBySchema.ts` there). The `SequenceInfoPanel` class only wires those rows into a `MemoryStore`-backed `Table`.

### Fix the tab tooltip's Type label for sequences

`panelTooltip` ([SqlAdminController.ts:2208](frontend/src/SqlAdminController.ts#L2208)) builds its Type via `relationTypeLabel(ref.kind)` ([PropertiesPanel.ts:69](frontend/src/properties/PropertiesPanel.ts#L69)), which falls through to `"Table"` for any non-view/matview kind — so a sequence tab would read "Type: Table". Add a `kind === "sequence" → "Sequence"` branch to `relationTypeLabel` (additive; its other callers only pass relation kinds, so unaffected).

### No disposer needed

`SequenceInfoPanel` holds only a `MemoryStore`-backed `Table` (no `CodeEditor`/theme subscription), so — like `PropertyValuePanel` — it needs no `dispose`. `openSequence` registers the panel in `_openPanels` only, not `_panelDisposers`; the Dock "close" handler ([SqlAdminController.ts:231](frontend/src/SqlAdminController.ts#L231)) already prunes `_openPanels` via `disposePanel`.

---

## Public API

### Backend — `SequenceDetailQuery` (`backend/app/operations/sequence_detail.py`)

```python
class SequenceDetailQuery(Query):
    """Fetch a sequence's state and parameters from pg_sequences."""

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None: ...
    async def apply(self) -> None: ...          # self._raw = await conn.fetch(_SQL, table.schema, table.name)
    def get_result(self) -> dict: ...           # NotFound if empty; else the wire dict below
```

`get_result()` returns (raises `RuntimeError` before `apply()`, `NotFound` on empty):

```python
{
    "lastValue": str | None,   # None -> null when last_value is NULL
    "startValue": str,
    "minValue": str,
    "maxValue": str,
    "increment": str,          # from increment_by
    "cacheSize": str,          # from cache_size
    "cycle": bool,
    "dataType": str,           # e.g. "bigint"
    "owner": str,
}
```

### Backend — route (`backend/app/main.py`)

```python
@app.get("/api/{connection_id}/{database}/{schema}/{table}/sequence")
async def sequence_detail(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> dict: ...
```

Read route, `Depends(require_session)`, `session_pool_for(...).acquire()` → `SequenceDetailQuery(c, TableRef(database, schema, table))` → `apply()` → `get_result()`. Modelled on `view_definition` ([main.py:354](backend/app/main.py#L354)). The `{table}` path segment carries the sequence name (the per-object route namespace is generic).

### Contract — `SequenceDetail` (`frontend/src/contract.ts`)

```ts
/** A sequence's current state and parameters (pg_sequences). */
export interface SequenceDetail {
    lastValue: string | null; // last_value; null when never read or no USAGE/SELECT
    startValue: string;
    minValue: string;
    maxValue: string;
    increment: string;
    cacheSize: string;
    cycle: boolean;
    dataType: string;
    owner: string;
}
```

### API client — `getSequenceDetail` (`frontend/src/data/api.ts`)

```ts
export function getSequenceDetail(ref: DbObjectRef): Promise<SequenceDetail>;
// GET /api/${connectionId}/${database}/${schema}/${name}/sequence
```

Mirrors `getViewDefinition` ([api.ts:206](frontend/src/data/api.ts#L206)).

### Pure row-builder — `sequenceInfoRows` (`frontend/src/data/sequenceInfoRows.ts`)

```ts
export interface SequenceInfoRow { property: string; value: string; }
export function sequenceInfoRows(detail: SequenceDetail): SequenceInfoRow[];
```

DOM-free. Row order: Current value, Start value, Increment, Min value, Max value, Cache size, Cycle, Data type, Owner. `lastValue === null → "—"`; `cycle ? "Yes" : "No"`.

### Panel — `SequenceInfoPanel` (`frontend/src/dock/SequenceInfoPanel.ts`)

```ts
export class SequenceInfoPanel extends Panel {
    constructor(detail: SequenceDetail);
}
```

`Fit` layout over a read-only `Table` (`rowReadOnly: () => true`) bound to a `MemoryStore` whose `property`/`value` `Model` matches `PropertyValuePanel`'s, loaded with `sequenceInfoRows(detail)`.

### Controller — `openSequence` (`frontend/src/SqlAdminController.ts`)

```ts
async openSequence(ref: DbObjectRef, node: TreeNode): Promise<void>;
private sequenceInfoPanelId(ref: DbObjectRef): string; // `${this.panelId(ref)}::sequence`
```

Mirrors `openDefinition`: dedupe via `focusPanel(id)`; `getSequenceDetail(ref)` (on failure `notifyError` and return); register `{ ref, node, detail: "info" }` in `_openPanels`; `addPanel({ id, title: \`${ref.name} (info)\`, glyph: "arrow-up-1-9", tooltip: this.panelTooltip(ref), content: new SequenceInfoPanel(detail) })`; `syncToPanel(id)`.

---

## Ordered Implementation Steps

1. **`backend/app/operations/sequence_detail.py`** — new module. `SequenceDetailQuery(Query)` with the `_SQL` from Architecture Decisions. `__init__(self, conn, table)` stores `_conn`, `_table`, `_raw = None`. `apply()` → `self._raw = await self._conn.fetch(self._SQL, self._table.schema, self._table.name)`. `get_result()` → raise `RuntimeError` if `_raw is None`; raise `NotFound(f"Sequence '{schema}.{name}' not found")` if empty; else build the wire dict, `str(...)`-ing each numeric (and `None`-guarding `last_value`). Follow `view_definition.py`'s docstring/structure conventions.

2. **`backend/app/operations/__init__.py`** — append `from .sequence_detail import SequenceDetailQuery` and add `"SequenceDetailQuery"` to `__all__` (additive; do not reorder existing entries).

3. **`backend/app/main.py`** — append `SequenceDetailQuery` to the `from .operations import (...)` block, and add the `sequence_detail` route (Public API above) after the `structure` route. Additive only.

4. **`frontend/src/contract.ts`** — add the `SequenceDetail` interface (place near `ViewDefinition`, [contract.ts:52](frontend/src/contract.ts#L52)).

5. **`frontend/src/data/api.ts`** — add `SequenceDetail` to the contract import list and append the `getSequenceDetail` function after `getViewDefinition` ([api.ts:206](frontend/src/data/api.ts#L206)).

6. **`frontend/src/data/sequenceInfoRows.ts`** — new DOM-free module: `SequenceInfoRow` interface + `sequenceInfoRows(detail)` (row order and null/bool formatting per Public API).

7. **`frontend/src/dock/SequenceInfoPanel.ts`** — new panel class `extends Panel`. Build a `Model` with `property`/`value` string fields (copy from [PropertyValuePanel.ts:35](frontend/src/properties/PropertyValuePanel.ts#L35)), a `MemoryStore({ model, data: sequenceInfoRows(detail), autoLoad: true })`, and `super({ layoutManager: new Fit(), components: [Table(store, { columns: [], rowReadOnly: () => true })] })`. Class-first, no `dispose`.

8. **`frontend/src/properties/PropertiesPanel.ts`** — add a `case "sequence": return "Sequence";` (or equivalent branch) to `relationTypeLabel` ([PropertiesPanel.ts:69](frontend/src/properties/PropertiesPanel.ts#L69)) so `panelTooltip` labels a sequence tab correctly. Additive.

9. **`frontend/src/SqlAdminController.ts`** — add the `openSequence` method (near `openDefinition`, [line 365](frontend/src/SqlAdminController.ts#L365)) and the `sequenceInfoPanelId` helper (near the other `*PanelId` helpers, [line 2140](frontend/src/SqlAdminController.ts#L2140)). Import `SequenceInfoPanel` and `getSequenceDetail`. Follow `openDefinition` exactly, minus the disposer (see decision).

10. **`frontend/src/navigator/NavigatorTree.ts`** — (a) in the `dblclick` handler ([line 117](frontend/src/navigator/NavigatorTree.ts#L117)), add `if (ref && ref.kind === "sequence") { void this.controller.openSequence(ref, node); return; }` before the `isRelation` check. (b) In the `ref.kind === "sequence"` context-menu branch ([line 172](frontend/src/navigator/NavigatorTree.ts#L172)), prepend `{ text: "Show info", glyph: "arrow-up-1-9", action: () => void this.controller.openSequence(ref, node) }` as the first item.

11. **Checkpoints** — `cd backend && poetry run python -m pytest` (worktree: use `python -m pytest`, not bare `pytest`); `cd frontend && npm run typecheck && npm test`.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Create | `backend/app/operations/sequence_detail.py` |
| Create | `backend/tests/test_sequence_detail.py` |
| Create | `frontend/src/data/sequenceInfoRows.ts` |
| Create | `frontend/tests/data/sequenceInfoRows.test.ts` |
| Create | `frontend/src/dock/SequenceInfoPanel.ts` |
| Modify | `backend/app/operations/__init__.py` (export op) |
| Modify | `backend/app/main.py` (import + `/sequence` route) |
| Modify | `frontend/src/contract.ts` (`SequenceDetail`) |
| Modify | `frontend/src/data/api.ts` (`getSequenceDetail`) |
| Modify | `frontend/src/properties/PropertiesPanel.ts` (`relationTypeLabel` sequence case) |
| Modify | `frontend/src/SqlAdminController.ts` (`openSequence`, `sequenceInfoPanelId`) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (dblclick branch + "Show info" item) |

---

## Expected Behaviour

**Backend `get_result()` (unit-testable — `backend/tests/test_sequence_detail.py`, set `op._raw` by hand like [test_view_definition.py](backend/tests/test_view_definition.py)):**

- A full row `{owner: "sqladmin", data_type: "bigint", start_value: 1, min_value: 1, max_value: 9223372036854775807, increment_by: 1, cache_size: 1, cycle: False, last_value: 6}` → `{"owner": "sqladmin", "dataType": "bigint", "startValue": "1", "minValue": "1", "maxValue": "9223372036854775807", "increment": "1", "cacheSize": "1", "cycle": False, "lastValue": "6"}` (numerics are strings; `maxValue` round-trips full precision).
- `last_value = None` → `"lastValue": None`.
- `cycle = True` → `"cycle": True` (unchanged boolean).
- `_raw = []` → raises `NotFound`.
- `get_result()` before `apply()` (`_raw is None`) → raises `RuntimeError`.

**Pure row-builder `sequenceInfoRows` (unit-testable — `frontend/tests/data/sequenceInfoRows.test.ts`, vitest, like [groupBySchema.test.ts](frontend/tests/data/groupBySchema.test.ts)):**

- A full `SequenceDetail` → nine rows in order Current value, Start value, Increment, Min value, Max value, Cache size, Cycle, Data type, Owner, each `value` equal to the corresponding detail string.
- `lastValue: null` → the Current value row's `value` is `"—"`.
- `cycle: true` → Cycle row `value` is `"Yes"`; `cycle: false` → `"No"`.

**Manual-verify (live Dock/tree events the harness can't exercise; smoke via `npm run dev`, log in against `sqladmin`/`localhost:5432`):**

- Double-click a sequence leaf (e.g. `sales.products_id_seq`) → an info tab opens titled `products_id_seq (info)` showing the nine rows; `last_value` = 6.
- Right-click the sequence → "Show info" opens the same tab; a second double-click/"Show info" **focuses** the existing tab (dedup), not a duplicate.
- Hover the tab → tooltip reads "Type: Sequence" (not "Table").
- Double-clicking a table/view still opens its data tab (regression); the sequence context menu still offers Alter/Drop.

---

## Verification

- `cd backend && poetry run python -m pytest` — new `test_sequence_detail.py` green; existing suite unaffected.
- `cd frontend && npm run typecheck` — no errors (new contract type, client, panel, controller method resolve).
- `cd frontend && npm test` — new `sequenceInfoRows.test.ts` green.
- `grep -rn "isRelation" frontend/src/navigator/objectKinds.ts` — the `sequence` entry still reads `isRelation: false` (unchanged).
- Manual smoke per Expected Behaviour, entry point: the navigator tree (WEST sidebar) → a Sequences category leaf.

---

## Critical Files

- [backend/app/operations/view_definition.py](backend/app/operations/view_definition.py) — the single-relation `Query` op the new op mirrors (SQL param binding, `NotFound`-on-empty, `RuntimeError`-before-`apply`).
- [backend/app/main.py:354](backend/app/main.py#L354) — the `view_definition` route to copy for `/sequence`.
- [frontend/src/SqlAdminController.ts:365](frontend/src/SqlAdminController.ts#L365) — `openDefinition`, the tab open/dedupe idiom (`focusPanel`, `_openPanels`, `addPanel`, `syncToPanel`).
- [frontend/src/properties/PropertyValuePanel.ts](frontend/src/properties/PropertyValuePanel.ts) — the read-only Property/Value `Model`+`MemoryStore`+`Table` shape the panel reuses.
- [frontend/src/dock/DefinitionPanel.ts](frontend/src/dock/DefinitionPanel.ts) — the class-first Dock panel pattern.
- [frontend/src/navigator/NavigatorTree.ts:172](frontend/src/navigator/NavigatorTree.ts#L172) — the existing sequence context-menu branch and the `dblclick` handler to extend.

---

## Non-Goals

- **No editing from the info tab** — it is strictly read-only; parameter changes stay in the existing "Alter sequence…" dialog. (Prefilling that dialog from this detail is a separate follow-on.)
- **No live refresh** — `last_value` is a point-in-time read at tab-open; the tab does not poll. Re-opening (after close) re-reads.
- **No `pg_sequences` join fallback** — the single-table read is sufficient on PG 10+; no `pg_class`/`pg_type` derivation is added.
- **No change to the Properties sidebar inspector** — `sequenceRows` stays identity-only ([PropertiesPanel.ts:59](frontend/src/properties/PropertiesPanel.ts#L59)); the full detail lives only in the new tab.
