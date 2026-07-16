# Column ↔ Sequence Links — Implementation Plan

## Overview

Surface the missing link between a column and the sequence that backs it, in both directions:

1. **Column → sequence.** The Structure tab's Columns grid gains a `Sequence` column rendering the backing sequence as a link; clicking it opens that sequence's info tab.
2. **Sequence → column ("Owned by").** [`SequenceInfoPanel`](frontend/src/dock/SequenceInfoPanel.ts) gains a read-only "Owned by column" row linking back to the owning table's Structure tab. Nullable — a standalone sequence has no owner.

Backend detection is pg_depend-based (not `pg_get_serial_sequence`), covering the union of OWNED BY (`serial`/identity) and DEFAULT-expression (`nextval('shared_seq')`) sequences. Touches [`list_columns.py:26`](backend/app/operations/list_columns.py#L26), [`sequence_detail.py:29`](backend/app/operations/sequence_detail.py#L29), both contracts, [`columnsGrid.ts:39`](frontend/src/dock/columnsGrid.ts#L39), [`StructurePanel.ts:101`](frontend/src/dock/StructurePanel.ts#L101), [`SequenceInfoPanel.ts:116`](frontend/src/dock/SequenceInfoPanel.ts#L116), and [`SqlAdminController.ts:522`](frontend/src/SqlAdminController.ts#L522).

**Every catalog query below was verified against the live PostgreSQL 16 (`sqladmin-db`)** using throwaway fixtures covering serial, identity, shared-sequence DEFAULT, standalone, multi-owned, multi-nextval-default, and generated-STORED columns. The verified findings are encoded as decisions — do not re-derive them.

---

## Architecture Decisions

### The two pg_depend arms have OPPOSITE join orientations

This is the single most important fact in this plan, and the easiest thing to get wrong. The two arms are **not** symmetric:

- **Arm (a) — OWNED BY** (`serial`, `GENERATED … AS IDENTITY`): the *sequence* is the dependent object. `classid = 'pg_class'`, `objid` = the sequence's oid, `refobjid`/`refobjsubid` = the owning table + attnum, `deptype IN ('a','i')`.
- **Arm (b) — DEFAULT expression** (`DEFAULT nextval('shared_seq')`): the *attrdef* is the dependent object and the **sequence is the REFERENCED side**. `classid = 'pg_attrdef'`, `objid` = the `pg_attrdef` oid, `refobjid` = the sequence's oid, `deptype = 'n'`.

Writing arm (b) with arm (a)'s orientation (joining the sequence on `d.objid`) silently returns **zero rows** — verified. The arms are unioned into a common `(attrelid, attnum, seqid, arm)` shape before joining out to names.

### `relkind = 'S'` on the sequence join is load-bearing, not cosmetic

Arm (b) filters `refclassid = 'pg_class'`, which **also matches ordinary table/column dependencies**. Verified: a `GENERATED ALWAYS AS (w*h) STORED` column's attrdef produces three `refclassid = 'pg_class'`, `deptype IN ('n','i')` rows pointing at *its own table* (`relkind='r'`) for the columns it references. Without `JOIN pg_class s ON s.oid = … AND s.relkind = 'S'`, arm (b) would report the **table** as the column's "sequence". Both arms funnel through that one `relkind='S'` join, which is what makes them safe.

### Multi-match: DEFAULT wins over OWNED BY; ties break on (schema, name)

All four multiplicity shapes are real and were reproduced live:

| Case | Arms | Resolution |
|---|---|---|
| `serial` | both arms → **same** sequence | dedup to one |
| column DEFAULTs from `shared_seq` but OWNS `owned_elsewhere` | two **different** sequences | arm (b) wins → `shared_seq` |
| one column OWNS two sequences (`ALTER SEQUENCE … OWNED BY` twice) | two rows, arm (a) | `(schema, name)` tie-break |
| `DEFAULT nextval('a') + nextval('b')` | two rows, arm (b) | `(schema, name)` tie-break |

**Precedence: arm (b) (DEFAULT) beats arm (a) (OWNED BY)** — the DEFAULT expression is what actually supplies the value at INSERT, so it is the sequence that genuinely "backs" the column. Identity columns have no attrdef at all, so arm (a) is their only source and the rule never strands them. Implemented as `DISTINCT ON (l.attnum) … ORDER BY l.attnum, l.arm DESC, sn.nspname, s.relname` — `arm DESC` puts arm 2 first; the trailing name sort makes ties deterministic rather than a nondeterministic pick. Verified: exactly one row per column in every case above.

### The two directions are NOT inverse functions — this is deliberate

"Owned by" uses **arm (a) only**. Verified: `shared_seq` is defaulted-from by two columns yet is OWNED BY nobody, and reports no owner. So `column → sequence → owner column` need not round-trip back to the starting column. That is correct: "Owned by" is the literal Postgres `ALTER SEQUENCE … OWNED BY` relation (what `psql \d` reports), not "who uses this". A sequence can have at most one OWNED BY column (a second `OWNED BY` replaces the first), so the reverse lookup yields 0 or 1 rows.

### `is_generated` stays — it is not redundant with `sequence`

Keep the existing boolean at [`list_columns.py:31-36`](backend/app/operations/list_columns.py#L31) exactly as-is. Verified: a `GENERATED ALWAYS AS (w*h) STORED` column has `is_generated = true` and **no** sequence. The two fields answer different questions ("is this omitted from INSERT?" vs "which sequence backs it?"), and `is_generated` drives insert-body construction. Adding `sequence` is purely additive.

### Both new contract fields are optional, to avoid fixture churn

`ColumnMeta.sequence` and `SequenceDetail.ownedBy` are **optional** on the TS side (`?:`) and **defaulted to `None`** on the Python side. Existing tests construct `ColumnMeta`/`SequenceDetail` object literals ([`schemaCardModel.test.ts:16`](frontend/tests/data/schemaCardModel.test.ts#L16), [`tableWriteRules.test.ts:8`](frontend/tests/dock/tableWriteRules.test.ts#L8), [`sequenceFormState.test.ts:16`](frontend/tests/dock/sequenceFormState.test.ts#L16), [`ddlSpecs.test.ts:353`](frontend/tests/dock/ddlSpecs.test.ts#L353)) and `conftest.col()` builds `ColumnMeta` kwargs; a required field would break all of them for no benefit. On the Python dataclass the defaulted field **must come last** (after `wire_type`) — every other field is non-defaulted. `to_contract()` still always emits the key (null when absent) so the wire shape stays stable.

### Nested `{schema, name}`, not two correlated flat fields

`sequence` is a nested object, unlike the FK grid's flat `refSchema`/`refTable`. One optional link is one null check; two correlated nullable fields can disagree. The **grid row** still flattens it (see below) because `MemoryStore` fields are flat.

### The sequence link is opt-in, keyed on the callback

`buildColumnsGrid(columns, onOpenSequence?)`. Without the callback the model, grid, and behaviour are **byte-for-byte today's** — [`DefinitionPanel.ts:62`](frontend/src/dock/DefinitionPanel.ts#L62) (views/matviews) passes nothing and is unaffected. Views and matviews have no sequences, so an always-empty `Sequence` column there would be pure noise. Only the linked path adds the model field and the explicit column config.

### The click handler reads hidden fields, never parses the display string

`appendUnlisted: false` renders **only** listed columns while the record still carries every model field (verified in `ColumnConfig.ts`'s docs). So the row carries `sequenceSchema` + `sequenceName` as unlisted model fields and a `sequence` display field; the `"cellclick"` handler reads the two hidden fields off `e.record`. Never re-split the `"schema.name"` label — a schema or sequence name may itself contain a dot.

### Display label is always schema-qualified

The `Sequence` cell shows `schema.name` unconditionally. Qualifying needs no extra parameter (the table's own schema isn't passed to `buildColumnsGrid`), it is unambiguous cross-schema (the `shared_seq` case is exactly where the link matters most), and it mirrors how Postgres itself reports the identity in `column_default`.

### "Owned by column" is a chromeless Button, not a Text

The library has **no** standalone link component — `LinkCellRenderer` is table-cell-only, and `Text` exposes no click listener. `Button` is the sanctioned clickable. Use `chromeless: true` with `foregroundColor: "var(--ts-ui-link-color, rgb(21, 101, 192))"` — the *same* CSS variable `LinkCellRenderer` defaults to, so a theme retints both link affordances at once. Do not hand-roll a new link primitive.

### "Owned by" links to the owning table's Structure tab, not its data tab

The owner is a *column*, and a column is what the Structure tab shows. This makes the round trip coherent: Structure → (Sequence link) → sequence info → (Owned by link) → Structure. A data tab would drop the user somewhere the column isn't even displayed.

### "Owned by" sits in the fieldset but outside the edit flow

It becomes a row in the existing `LabeledFieldSet` ([`SequenceInfoPanel.ts:142`](frontend/src/dock/SequenceInfoPanel.ts#L142)), directly after `Owner`. Ownership is a property of the sequence, so the property sheet is where it belongs. It is **read-only**: it must not be added to `EditedSequenceValues`, must not be read by `readEdited()`, and must not be touched by `isSequenceFormDirty`/`diffSequenceSpecs` — the Save flow stays exactly as it is.

Label it **"Owned by column"**, not "Owned by", because it sits next to **"Owner"** and the two are different Postgres concepts (`OWNER TO <role>` vs `OWNED BY <table.column>`). The explicit label is what keeps the adjacency readable.

---

## Public API

```python
# backend/app/contract.py
@dataclass(frozen=True)
class SequenceRef:
    """Identifies the sequence backing a column."""
    schema: str
    name: str

    def to_contract(self) -> dict:  # {"schema": ..., "name": ...}


@dataclass(frozen=True)
class ColumnOwnerRef:
    """Identifies the table column that owns a sequence (ALTER SEQUENCE ... OWNED BY)."""
    schema: str
    table: str
    column: str

    def to_contract(self) -> dict:  # {"schema": ..., "table": ..., "column": ...}


@dataclass(frozen=True)
class ColumnMeta:
    # ...existing fields, unchanged, in order...
    wire_type: WireType
    sequence: SequenceRef | None = None   # MUST be last: the only defaulted field
```

```ts
// frontend/src/contract.ts
/** The sequence backing a column (pg_depend: OWNED BY, or a DEFAULT nextval reference). */
export interface SequenceRef {
    schema: string;
    name: string;
}

/** The table column that owns a sequence (ALTER SEQUENCE ... OWNED BY). */
export interface ColumnOwnerRef {
    schema: string;
    table: string;
    column: string;
}

export interface ColumnMeta {
    // ...existing fields...
    /** The sequence backing this column, or null/absent when none does. */
    sequence?: SequenceRef | null;
}

export interface SequenceDetail {
    // ...existing fields...
    /** The column that owns this sequence, or null/absent for a standalone sequence. */
    ownedBy?: ColumnOwnerRef | null;
}
```

```ts
// frontend/src/dock/columnSequence.ts  (NEW — pure, DOM-free)
export interface ColumnRow {
    name: string;
    dataType: string;
    nullable: boolean;
    isPrimaryKey: boolean;
    isGenerated: boolean;
    wireType: string;
    sequence: string;        // "schema.name", or "" when none
    sequenceSchema: string;  // "" when none — unlisted, read by the click handler
    sequenceName: string;    // "" when none — unlisted, read by the click handler
}

export function sequenceLabel(sequence: SequenceRef | null | undefined): string;
export function toColumnRows(columns: ColumnMeta[]): ColumnRow[];
```

```ts
// frontend/src/dock/columnsGrid.ts
export function buildColumnsGrid(
    columns: ColumnMeta[],
    onOpenSequence?: (schema: string, name: string) => void,
): ColumnsGrid;
```

```ts
// frontend/src/dock/sequenceFormState.ts  (pure, DOM-free — existing module)
/** "schema.table.column", or "" when the sequence is standalone. */
export function ownedByLabel(ownedBy: ColumnOwnerRef | null | undefined): string;
```

```ts
// frontend/src/dock/StructurePanel.ts
constructor(
    columns: ColumnMeta[],
    structure: TableStructure,
    onOpenReferenced: (refSchema: string, refTable: string) => void,
    onOpenSequence: (seqSchema: string, seqName: string) => void,   // NEW — 4th param
    actions?: StructureActions,
)
```

```ts
// frontend/src/dock/SequenceInfoPanel.ts — SequenceInfoPanelDeps
/** Open the owning table's Structure tab. Absent → the row renders as plain text. */
onOpenOwner?: (schema: string, table: string) => void;
```

```ts
// frontend/src/SqlAdminController.ts
async openSequence(ref: DbObjectRef, node?: TreeNode): Promise<void>;    // widened
async openStructure(ref: DbObjectRef, node?: TreeNode): Promise<void>;   // widened
openReferencedSequence(ref: DbObjectRef): void;                          // NEW
openReferencedStructure(ref: DbObjectRef): void;                         // NEW
```

---

## Implementation

### The column → sequence subquery (verified live)

Drop this in as a `LEFT JOIN` subquery in `ListColumnsQuery._SQL`, joined on `seq.column_name = c.column_name`, aliased `seq`. It is parameterized by the same `$1` (schema) / `$2` (table) the outer query already binds.

```sql
LEFT JOIN (
    SELECT DISTINCT ON (l.attnum)
           a.attname  AS column_name,
           sn.nspname AS sequence_schema,
           s.relname  AS sequence_name
    FROM (
        -- Arm (a): sequence OWNED BY the column (serial + identity). The
        -- SEQUENCE is the dependent object, so it is d.objid.
        SELECT d.refobjid AS attrelid, d.refobjsubid AS attnum, d.objid AS seqid, 1 AS arm
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.refclassid = 'pg_class'::regclass
          AND d.deptype IN ('a', 'i')
          AND d.refobjsubid > 0
        UNION ALL
        -- Arm (b): sequence referenced from the column's DEFAULT. The ATTRDEF
        -- is the dependent object, so here the SEQUENCE is the REFERENCED side
        -- (d.refobjid) — the opposite orientation to arm (a).
        SELECT ad.adrelid, ad.adnum, d.refobjid, 2
        FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_attrdef ad ON ad.oid = d.objid
        WHERE d.classid = 'pg_attrdef'::regclass
          AND d.refclassid = 'pg_class'::regclass
          AND d.deptype = 'n'
    ) l
    -- relkind='S' is load-bearing: arm (b)'s refclassid='pg_class' also matches
    -- a generated-STORED column's references to its OWN table's columns.
    JOIN pg_catalog.pg_class s      ON s.oid = l.seqid AND s.relkind = 'S'
    JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
    JOIN pg_catalog.pg_class rc     ON rc.oid = l.attrelid
    JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
    JOIN pg_catalog.pg_attribute a  ON a.attrelid = l.attrelid AND a.attnum = l.attnum
    WHERE rn.nspname = $1 AND rc.relname = $2
    -- arm DESC: a DEFAULT (arm 2) beats an OWNED BY (arm 1) when they disagree;
    -- the name sort makes a same-arm tie deterministic.
    ORDER BY l.attnum, l.arm DESC, sn.nspname, s.relname
) seq ON seq.column_name = c.column_name
```

Add to the outer `SELECT` list:

```sql
    seq.sequence_schema AS sequence_schema,
    seq.sequence_name   AS sequence_name
```

`_MATVIEW_SQL` gets constant NULLs (a matview column never has a sequence), cast so asyncpg types them:

```sql
    NULL::text AS sequence_schema,
    NULL::text AS sequence_name
```

`get_columns_result()` maps them:

```python
sequence=(
    SequenceRef(schema=r["sequence_schema"], name=r["sequence_name"])
    if r["sequence_schema"] is not None
    else None
),
```

### The "Owned by" lookup (verified live)

Fold into `SequenceDetailQuery._SQL` as a `LEFT JOIN LATERAL`. **It must be a LEFT join**: a standalone sequence has to still return its row (with NULL `owned_by_*`), or `get_result()`'s `NotFound`-on-empty guard would misfire and 404 every ownerless sequence. Verified: standalone → 1 row with NULLs; nonexistent → 0 rows.

```sql
SELECT s.sequenceowner AS owner,
       s.data_type::text AS data_type,
       s.start_value, s.min_value, s.max_value,
       s.increment_by, s.cache_size, s.cycle, s.last_value,
       ow.table_schema AS owned_by_schema,
       ow.table_name   AS owned_by_table,
       ow.column_name  AS owned_by_column
FROM pg_catalog.pg_sequences s
LEFT JOIN LATERAL (
    SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name
    FROM pg_catalog.pg_class sq
    JOIN pg_catalog.pg_namespace sn ON sn.oid = sq.relnamespace
    JOIN pg_catalog.pg_depend d     ON d.objid = sq.oid
    JOIN pg_catalog.pg_class c      ON c.oid = d.refobjid
    JOIN pg_catalog.pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a  ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE sq.relkind = 'S'
      AND sn.nspname = s.schemaname AND sq.relname = s.sequencename
      AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
      AND d.deptype IN ('a', 'i') AND d.refobjsubid > 0
) ow ON true
WHERE s.schemaname = $1 AND s.sequencename = $2
```

`get_result()` adds:

```python
"ownedBy": (
    {"schema": row["owned_by_schema"], "table": row["owned_by_table"], "column": row["owned_by_column"]}
    if row["owned_by_schema"] is not None
    else None
),
```

### The linked Columns grid

```ts
export function buildColumnsGrid(
    columns: ColumnMeta[],
    onOpenSequence?: (schema: string, name: string) => void,
): ColumnsGrid {
    const fields = [
        { name: "name", type: "string", description: "Column", order: 1 },
        { name: "dataType", type: "string", description: "Type", order: 2 },
        { name: "nullable", type: "boolean", description: "Nullable", order: 3 },
        { name: "isPrimaryKey", type: "boolean", description: "PK", order: 4 },
        { name: "isGenerated", type: "boolean", description: "Generated", order: 5 },
        { name: "wireType", type: "string", description: "Wire type", order: 6 },
    ];

    if (onOpenSequence) {
        // Display field + the two unlisted fields the click handler reads.
        fields.push({ name: "sequence", type: "string", description: "Sequence", order: 7 });
        fields.push({ name: "sequenceSchema", type: "string", description: "Sequence schema", order: 8 });
        fields.push({ name: "sequenceName", type: "string", description: "Sequence name", order: 9 });
    }

    const model = new Model({ fields });
    const store = new MemoryStore({ model, data: toColumnRows(columns), autoLoad: true });

    if (!onOpenSequence) {
        return { grid: readOnlyTable(store), store };
    }

    return { grid: linkedColumnsTable(store, onOpenSequence), store };
}
```

`linkedColumnsTable` is a module-private helper mirroring [`buildForeignKeysGrid`](frontend/src/dock/StructurePanel.ts#L358) exactly — explicit `columns`, `appendUnlisted: false` (which is what hides `sequenceSchema`/`sequenceName`), `rowReadOnly: () => true`, `renderer: () => new LinkCellRenderer()` on `sequence` only, and a `"cellclick"` gated on the field:

```ts
grid.on("cellclick", (e: CellClickEvent) => {
    if (e.field !== "sequence") {
        return;
    }

    const schema = String(e.record.get("sequenceSchema") ?? "");
    const name   = String(e.record.get("sequenceName") ?? "");

    // A column with no backing sequence renders an empty cell — clicking it is a no-op.
    if (!schema || !name) {
        return;
    }

    onOpenSequence(schema, name);
});
```

### The controller's reveal-and-open siblings

Both mirror [`openReferencedTable:1814`](frontend/src/SqlAdminController.ts#L1814). The sequence predicate **must** also match `r.kind === "sequence"` — unlike the FK case, a sequence and a relation can collide on schema+name in the predicate, and the existing predicate only matches database/schema/name.

```ts
/**
 * Open a column's backing sequence's info tab and reveal it in the navigator.
 * Best-effort, exactly like openReferencedTable: if no node matches, the tab
 * still opens. The kind check is required — the schema+name predicate alone
 * could match a relation node.
 */
openReferencedSequence(ref: DbObjectRef): void {
    void (async () => {
        const node = (await this._navigator?.revealByPredicate((data: unknown) => {
            const r = data as DbObjectRef | undefined;

            return !!r && r.kind === "sequence" && r.database === ref.database
                && r.schema === ref.schema && r.name === ref.name;
        })) ?? undefined;

        await this.openSequence(ref, node);

        if (node) {
            this._navigator?.selectNode(node);
        }
    })();
}
```

`openReferencedStructure(ref)` is identical but predicates on `r.kind === "table"` and awaits `this.openStructure(ref, node)`.

Both `openSequence` and `openStructure` widen `node: TreeNode` → `node?: TreeNode`, and their `_openPanels.set(...)` calls become `{ ref, node: node ?? null, … }` — matching [`openTable:318`](frontend/src/SqlAdminController.ts#L318), since [`OpenPanel.node`](frontend/src/SqlAdminController.ts#L121) is already `TreeNode | null` and [`syncToPanel:2610`](frontend/src/SqlAdminController.ts#L2610) already guards `if (panel.node)`.

### The "Owned by column" row

In `SequenceInfoPanel`'s constructor, build the widget as a **local before `super()`** (the super-cascade trap, COMPONENT_CONVENTIONS.md (b)), append its row to the `LabeledFieldSet` rows after `Owner`, and keep it out of `readEdited()`:

```ts
const ownedBy = detail.ownedBy;
const ownedByWidget = ownedBy && deps.onOpenOwner
    ? linkButton(ownedByLabel(ownedBy), () => deps.onOpenOwner!(ownedBy.schema, ownedBy.table))
    : new Text(ownedBy ? ownedByLabel(ownedBy) : "—", { foregroundColor: MUTED_TEXT_COLOR });
```

The row is always present (a stable form layout, and "this sequence is standalone" is real information); only its widget differs. A standalone sequence renders a muted `—`. `linkButton` is a small module-private helper: `Button({ text, chromeless: true, compact: true, foregroundColor: "var(--ts-ui-link-color, rgb(21, 101, 192))" })` with an `"action"` listener.

`seedFields()` does **not** touch this row: ownership cannot change through this form's Save (an `ALTER SEQUENCE … OWNER TO` changes the owning *role*, not the owning column), so the row stays as constructed.

---

## Ordered Implementation Steps

1. **`backend/app/contract.py`** — add the `SequenceRef` and `ColumnOwnerRef` frozen dataclasses (each with `to_contract()`). Add `sequence: SequenceRef | None = None` to `ColumnMeta` **as its last field**, after `wire_type`. Extend `ColumnMeta.to_contract()` to always emit `"sequence": self.sequence.to_contract() if self.sequence else None`.
   *Check:* `cd backend && poetry run python -m pytest -q` — still green (the default keeps `conftest.col()` working).

2. **`backend/app/operations/list_columns.py`** — add the verified `LEFT JOIN` subquery and the two `SELECT` columns to `_SQL`; add `NULL::text AS sequence_schema` / `NULL::text AS sequence_name` to `_MATVIEW_SQL`; map `sequence=` in `get_columns_result()`. Leave `is_generated` untouched. Update the `_MATVIEW_SQL` comment (it claims flags are constant-false; note the sequence is constant-NULL for the same reason).

3. **`backend/tests/test_list_columns.py`** — add `sequence_schema`/`sequence_name` keys to `_RAW` and the matview row (the fixtures drive `get_columns_result()` directly and will `KeyError` otherwise). Add tests per *Expected Behaviour* 1-3.
   *Check:* `poetry run python -m pytest tests/test_list_columns.py -q`.

4. **`backend/app/operations/sequence_detail.py`** — replace `_SQL` with the verified `LEFT JOIN LATERAL` version; add `"ownedBy"` to `get_result()`. Update the module docstring (it currently says no join is needed).

5. **`backend/tests/test_sequence_detail.py`** — add the `owned_by_*` keys to every existing `op._raw` fixture, plus tests per *Expected Behaviour* 4-5.
   *Check:* `poetry run python -m pytest -q` — full backend suite green.

6. **`frontend/src/contract.ts`** — add `SequenceRef` and `ColumnOwnerRef`; add optional `sequence?` to `ColumnMeta` (~line 40) and optional `ownedBy?` to `SequenceDetail` (~line 68).

7. **`frontend/src/dock/columnSequence.ts`** (new) — pure `sequenceLabel` + `toColumnRows`. No library imports beyond `import type` (the module must stay DOM-free so the node vitest can load it).

8. **`frontend/tests/dock/columnSequence.test.ts`** (new) — tests per *Expected Behaviour* 6-7.
   *Check:* `cd frontend && npm test`.

9. **`frontend/src/dock/columnsGrid.ts`** — add the optional `onOpenSequence` param and the `linkedColumnsTable` private helper; route data through `toColumnRows`. Keep `readOnlyTable` exported and unchanged (`StructurePanel` still uses it for Indexes/Constraints).
   *Check:* `grep -n 'buildColumnsGrid' frontend/src/dock/DefinitionPanel.ts` — still a one-arg call, untouched.

10. **`frontend/src/dock/StructurePanel.ts`** — add the `onOpenSequence` 4th constructor param (**before** the optional `actions`), pass it to `buildColumnsGrid` at line 117, and document it in the class JSDoc + the module header comment (which currently describes only the FK link).

11. **`frontend/src/dock/sequenceFormState.ts`** — add the pure `ownedByLabel`. Do **not** touch `detailToEditedValues` or `isSequenceFormDirty`.
    *Check:* `grep -n 'ownedBy' frontend/src/dock/ddlSpecs.ts` — expect zero matches (the Save diff must not see it).

12. **`frontend/tests/dock/sequenceFormState.test.ts`** — add `ownedByLabel` tests (*Expected Behaviour* 8) and a test that `isSequenceFormDirty` ignores `ownedBy`.

13. **`frontend/src/dock/SequenceInfoPanel.ts`** — add optional `onOpenOwner` to `SequenceInfoPanelDeps`; add the `linkButton` helper and the "Owned by column" row after `Owner`. Widget built as a local pre-`super()`. Update the module header comment.

14. **`frontend/src/SqlAdminController.ts`** — widen `openSequence` (line 522) and `openStructure` (line 565) to `node?: TreeNode` with `node: node ?? null`; add `openReferencedSequence` + `openReferencedStructure` beside `openReferencedTable` (line 1814); pass the new `onOpenSequence` into `new StructurePanel(...)` (line 589) and `onOpenOwner` into `new SequenceInfoPanel(...)` (line 549), each building the `DbObjectRef` from the tab's own `ref.connectionId`/`ref.database`.
    *Check:* `cd frontend && npm run typecheck`.

15. **Full check:** `cd backend && poetry run python -m pytest -q` and `cd frontend && npm run typecheck && npm test`, then the manual smoke tests below.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/contract.py` |
| Modify | `backend/app/operations/list_columns.py` |
| Modify | `backend/app/operations/sequence_detail.py` |
| Modify | `backend/tests/test_list_columns.py` |
| Modify | `backend/tests/test_sequence_detail.py` |
| Modify | `frontend/src/contract.ts` |
| Create | `frontend/src/dock/columnSequence.ts` |
| Create | `frontend/tests/dock/columnSequence.test.ts` |
| Modify | `frontend/src/dock/columnsGrid.ts` |
| Modify | `frontend/src/dock/StructurePanel.ts` |
| Modify | `frontend/src/dock/sequenceFormState.ts` |
| Modify | `frontend/tests/dock/sequenceFormState.test.ts` |
| Modify | `frontend/src/dock/SequenceInfoPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |

`backend/tests/test_list_objects.py` is **not** touched — it covers `ListObjectsQuery`'s name+kind navigator listing and has nothing to do with column→sequence links (the exploration brief named it in error; `test_list_columns.py` is the correct file).

---

## Expected Behaviour

Backend tests are **pure-logic**: they seed `op._raw` directly and assert on `get_result()`/`get_columns_result()` (see `conftest.NO_CONN`). They therefore pin the **mapping**, never the SQL. **The SQL itself has no automated coverage and must be verified manually** (below) — this is the single biggest gap in this plan's automation.

Unit-testable (backend, `poetry run python -m pytest`):

1. `get_columns_result()` maps `sequence_schema`/`sequence_name` to a `SequenceRef`; a row with `sequence_schema: None` maps to `sequence=None`.
2. `to_contract()` emits `"sequence": {"schema": "sales", "name": "products_id_seq"}` for a linked column and `"sequence": None` for an unlinked one — the key is **always** present.
3. The matview fallback path yields `sequence=None` for every column.
4. `SequenceDetailQuery.get_result()` emits `"ownedBy": {"schema","table","column"}` when the `owned_by_*` columns are set, and `"ownedBy": None` when they are NULL.
5. The existing `NotFound`-on-empty-`_raw` behaviour is unchanged (a standalone sequence yields a row, so it must **not** 404).

Unit-testable (frontend, `npm test`):

6. `sequenceLabel({schema:"sales", name:"products_id_seq"})` → `"sales.products_id_seq"`; `sequenceLabel(null)` and `sequenceLabel(undefined)` → `""`.
7. `toColumnRows` sets `sequence`/`sequenceSchema`/`sequenceName` to `""` for a column with no sequence, and to the schema/name for one with a sequence; every existing display field is preserved.
8. `ownedByLabel({schema:"sales", table:"products", column:"id"})` → `"sales.products.id"`; `ownedByLabel(null)` → `""`. `isSequenceFormDirty` returns false for a baseline whose `ownedBy` differs but whose editable values match.

Manual verification (UI events + live SQL — the vitest harness is node-only and the backend tests never touch a database):

9. **`serial`** — open `sales.products` ▸ Structure. The `id` row's Sequence cell reads `sales.products_id_seq` as a link; every other row's cell is empty.
10. Clicking that link opens the `products_id_seq` info tab and selects the sequence in the navigator.
11. Clicking an **empty** Sequence cell does nothing (no tab, no error).
12. **Identity** — a `GENERATED ALWAYS AS IDENTITY` column shows its sequence (arm (a) only; it has no DEFAULT).
13. **Shared sequence** — a column with `DEFAULT nextval('other_schema.shared_seq')` shows the schema-qualified `other_schema.shared_seq`, and the link opens it.
14. **Generated STORED** — a `GENERATED ALWAYS AS (expr) STORED` column shows an **empty** Sequence cell (this is the `relkind='S'` regression; a bug here shows the *table name* in the cell).
15. **Owned by** — the `products_id_seq` info tab shows "Owned by column" = `sales.products.id` as a link; clicking it opens `sales.products`'s Structure tab.
16. **Standalone** — a `CREATE SEQUENCE` with no owner shows a muted `—`, not a link, and its Save flow still works.
17. **DefinitionPanel unaffected** — open a view ▸ Definition: the Columns grid shows the same six columns as before, with **no** Sequence column.
18. The sequence form's Save flow (dirty gating, preview, execute, reload) is unchanged by the new row.

---

## Verification

```bash
# Backend — note `python -m pytest`, NOT bare `pytest`, inside a worktree
# (bare pytest resolves `app` imports from the main tree).
cd backend && poetry run python -m pytest -q

# Frontend
cd frontend && npm run typecheck && npm test

# Invariants
grep -n 'ownedBy' frontend/src/dock/ddlSpecs.ts          # expect zero — Save diff must not see it
grep -n 'buildColumnsGrid' frontend/src/dock/DefinitionPanel.ts  # expect the one-arg call, unchanged
grep -rn "pg_get_serial_sequence" backend/                # expect zero — pg_depend only
```

**Manual SQL verification (required — no automated coverage).** Bring the stack up (`docker compose up -d db`, backend, `npm run dev`), then create the fixture set below, exercise behaviours 9-18 in the UI, and drop it. These fixtures reproduce every case this plan's query decisions were derived from:

```sql
CREATE SCHEMA seqcheck;
CREATE TABLE seqcheck.t_serial (id serial PRIMARY KEY, label text);
CREATE TABLE seqcheck.t_identity (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text);
CREATE SEQUENCE seqcheck.shared_seq;
CREATE TABLE seqcheck.t_shared (id integer PRIMARY KEY DEFAULT nextval('seqcheck.shared_seq'), label text);
CREATE SEQUENCE seqcheck.standalone_seq;                          -- behaviour 16: muted "—"
CREATE TABLE seqcheck.t_stored (id serial PRIMARY KEY, w numeric, h numeric,
                                area numeric GENERATED ALWAYS AS (w*h) STORED);  -- behaviour 14
-- Precedence: DEFAULTs from shared_seq but OWNS owned_elsewhere -> must show shared_seq.
CREATE SEQUENCE seqcheck.owned_elsewhere;
CREATE TABLE seqcheck.t_both (id integer PRIMARY KEY DEFAULT nextval('seqcheck.shared_seq'), label text);
ALTER SEQUENCE seqcheck.owned_elsewhere OWNED BY seqcheck.t_both.id;

-- ...verify in the UI, then:
DROP SCHEMA seqcheck CASCADE;
```

Log in per the app's usual flow and open **Structure** on each `seqcheck` table, and the **info tab** on `shared_seq` (expect no owner) and `owned_elsewhere` (expect `seqcheck.t_both.id`). Confirm `seqcheck.t_both.id`'s Sequence cell reads `seqcheck.shared_seq` — **not** `owned_elsewhere`; that is the precedence rule.

---

## Potential Challenges

- **Arm (b)'s inverted orientation.** Writing it like arm (a) yields zero rows and the feature silently only works for `serial`/identity — which looks like success on the demo seed. Behaviour 13 is the test that catches it.
- **Forgetting `relkind = 'S'`.** Arm (b) then reports the owning *table* as the "sequence" for generated-STORED columns. Behaviour 14 catches it.
- **`NotFound` regression on `sequence_detail`.** An INNER join instead of `LEFT JOIN LATERAL` 404s every ownerless sequence. Behaviour 5 + 16 catch it.
- **The Python dataclass default must come last.** `sequence: SequenceRef | None = None` before a non-defaulted field is a `TypeError` at import — the whole backend fails to start.
- **Test fixtures `KeyError` before the feature works.** `get_columns_result()` reads `r["sequence_schema"]` unconditionally, so step 3's fixture update must land with step 2.
- **Super-cascade in `SequenceInfoPanel`.** The "Owned by" widget must be a local built *before* `super()`; `this` is unavailable until it returns (COMPONENT_CONVENTIONS.md (b)).
- **Sequence-node predicate collisions.** Omitting `r.kind === "sequence"` can reveal a relation node with the same schema+name.

---

## Critical Files

- [`backend/app/operations/list_columns.py`](backend/app/operations/list_columns.py) — the two-query (information_schema + matview fallback) shape both arms must fit.
- [`backend/app/operations/sequence_detail.py`](backend/app/operations/sequence_detail.py) — `NotFound`-on-empty is the constraint on the join type.
- [`backend/tests/conftest.py`](backend/tests/conftest.py) — `NO_CONN` and `col()`; explains why `sequence` must default.
- [`frontend/src/dock/StructurePanel.ts#L358-L413`](frontend/src/dock/StructurePanel.ts#L358) — `buildForeignKeysGrid`, the link pattern to mirror **exactly**.
- [`frontend/src/dock/sequenceFormState.ts`](frontend/src/dock/sequenceFormState.ts) — the pure/DOM-free convention `columnSequence.ts` follows.
- [`frontend/src/SqlAdminController.ts#L1814`](frontend/src/SqlAdminController.ts#L1814) — `openReferencedTable`, the reveal-then-open pattern both new methods copy.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — (b) super-cascade, (c) arrow-function handler fields.

---

## Non-Goals

- **No new route or panel type.** Both directions reuse `openSequence`/`openStructure` and the existing `/columns` + `/sequence` endpoints.
- **No `pg_get_serial_sequence`.** Explicitly rejected: it misses `DEFAULT nextval('shared_seq')` where the sequence isn't owned by the column.
- **No sequence column in the data-tab grid or `PropertiesPanel`.** Structure is where column metadata lives.
- **No column-level highlight/scroll on the "Owned by" jump.** It opens the table's Structure tab; the Structure grid has no "select row by field value" affordance today, and adding one is a separate concern.
- **No new link primitive in the library.** A chromeless `Button` on the shared `--ts-ui-link-color` var is sufficient.
- **`is_generated` is not deprecated or collapsed into `sequence`.** They mean different things (see Architecture Decisions).
