// The shared Columns grid — a Table over a MemoryStore of a relation's
// introspected columns (name/type/nullable/default/PK/generated/wire type),
// used by both StructurePanel's Columns section (tables) and DefinitionPanel's
// Columns section (views/matviews) so the column set and formatting stay
// identical everywhere a relation's columns are shown.
//
// Passing `onOpenSequence` adds a linked `Sequence` column showing the
// sequence backing each column, plus the Default/originalName/filler fields
// only a table's Structure tab needs (see STRUCTURE_FIELDS). It is opt-in
// because only a table can have a backing sequence: a view/matview never
// does, so DefinitionPanel omits the callback and gets the plain six-field
// grid. Row data is mapped by columnSequence.ts (pure/DOM-free, unit-tested).
//
// Passing `editable` (honoured only alongside `onOpenSequence`, i.e. only for
// a table's Structure tab — see StructurePanel's constructor) makes the grid's
// Name/Type/Nullable/Default cells inline-editable, locked per-cell on a
// generated column exactly as TableWorkPanel's data grid locks one (see
// tableWriteRules.ts's `readOnly: !canUpdate || c.isGenerated`). Every other
// cell (PK, Generated, Wire type, Sequence, the filler) stays read-only
// regardless of `editable` — see the plan's "A generated column's Type,
// Nullable and Default cells are locked; its Name is not" Architecture
// Decision, and its table for the full per-column-kind matrix.
//
// Returns the store alongside the grid so a caller that needs to reseed the
// grid later (DefinitionPanel after a definition Save; StructurePanel after a
// Refresh or a Save) can call `store.loadData(...)` directly, without
// rebuilding the Table.

import { Table, LinkCellRenderer } from "@jimka/typescript-ui/component/table";
import type { CellClickEvent, ColumnSpec } from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model }      from "@jimka/typescript-ui/data";
import type { AbstractStore, FieldOptions, ModelRecord } from "@jimka/typescript-ui/data";
import type { ColumnMeta }         from "../contract";
import { toColumnRows }            from "./columnSequence";

/** A built Columns grid plus the store backing it. */
export interface ColumnsGrid {
    grid: Table;
    store: MemoryStore;
}

/** Opens a column's backing sequence, given its schema and name. */
export type OpenSequenceHandler = (schema: string, name: string) => void;

// `Column.resolve()` (the library's spec/model merge) sorts every column by
// `Field.getOrder()` before applying `linkedColumnsTable`'s per-field
// `columns:` overrides — that array's own listing order is a lookup key, not
// a display order — so these `order` values are what actually place
// STRUCTURE_FIELDS' `defaultExpr` between `nullable` and `isPrimaryKey`
// below: order 4 is deliberately reserved here for it, ahead of `isPrimaryKey`
// through `wireType`.

/** The display fields every Columns grid shows, linked or not. */
const DISPLAY_FIELDS: FieldOptions[] = [
    { name: "name", type: "string", description: "Column", order: 1 },
    { name: "fullType", type: "string", description: "Type", order: 2 },
    { name: "nullable", type: "boolean", description: "Nullable", order: 3 },
    // order 4 is STRUCTURE_FIELDS' `defaultExpr`, rendered only on a table's
    // Structure tab — see its comment below.
    { name: "isPrimaryKey", type: "boolean", description: "PK", order: 5 },
    { name: "isGenerated", type: "boolean", description: "Generated", order: 6 },
    { name: "wireType", type: "string", description: "Wire type", order: 7 },
];

/**
 * The linked grid's extra fields, shown only on a table's Structure tab
 * (`onOpenSequence` given): the Default cell, the Save diff's identity
 * anchor (`originalName`), the `sequence` display label plus the
 * schema/name pair the click handler reads, and the blank filler column
 * that absorbs leftover width (see the plan's "A blank filler column
 * absorbs leftover width" Architecture Decision). The sequence schema/name
 * pair and `originalName` are deliberately not rendered (see
 * `linkedColumnsTable`'s `appendUnlisted: false`) — the pair exists so the
 * click handler never has to re-split the sequence label, which would be
 * ambiguous when a schema or sequence name itself contains a dot; `filler`
 * has no `ColumnRow` counterpart at all, so its cells bind `undefined` and
 * render blank.
 */
const STRUCTURE_FIELDS: FieldOptions[] = [
    // order 4: between DISPLAY_FIELDS' `nullable` (3) and `isPrimaryKey` (5) —
    // see that array's comment.
    { name: "defaultExpr", type: "string", description: "Default", order: 4 },
    { name: "sequence", type: "string", description: "Sequence", order: 8 },
    { name: "sequenceSchema", type: "string", description: "Sequence schema", order: 9 },
    { name: "sequenceName", type: "string", description: "Sequence name", order: 10 },
    { name: "originalName", type: "string", description: "Original name", order: 11 },
    { name: "filler", type: "string", description: "", order: 12 },
];

// The library's own auto-width cap (Table.clampColumnWidth clamps a derived
// width to at most this many px when a column declares no maxWidth of its
// own — see AUTO_WIDTH_CAP_PX in the library's Table.ts). Declaring this as a
// column's own `maxWidth` therefore changes nothing about that column's
// content sizing (it already gets clamped here by default); it only takes the
// column out of `absorbSlackIntoGreedy`'s leftover-width split, which skips
// any column that declares a `maxWidth`. So declaring it on every column but
// `filler` is what makes `filler` the one column that absorbs the grid's
// leftover width — see the plan's "A blank filler column absorbs leftover
// width" Architecture Decision.
const CONTENT_WIDTH_CAP = 400;

// The Sequence column's declared starting width. It carries a
// LinkCellRenderer, and the library never samples a column with a renderer
// under `autoSizeColumns`, so it has no content width of its own to derive
// from — the same reason PropertyValuePanel declares a width for its Property
// column. 220px comfortably fits a schema-qualified sequence name (e.g.
// "public.customers_id_seq") without being so wide it starves the filler
// column on a narrow window.
const SEQUENCE_COLUMN_WIDTH = 220;

/**
 * Build a read-only grid over a store. Structure/definition edits are
 * toolbar- or Save-button-launched flows, never inline cell edits, so every
 * column stays locked regardless of caller. Shared by relation Columns
 * (views/matviews), Indexes and Constraints, the query-result grid, and the
 * role-grants grid; `autoSizeColumns` applies to all of them, since each
 * holds short identifiers plus one long definition-style column that content
 * sizing handles well.
 *
 * @param store - The grid's backing store, typed as the `AbstractStore` base
 *   so a `Store`-backed grid (role grants) fits alongside the
 *   `MemoryStore`-backed ones.
 * @returns A read-only Table over the store.
 */
export function readOnlyTable(store: AbstractStore): Table {
    return Table(store, { columns: [], autoSizeColumns: true, rowReadOnly: () => true });
}

/**
 * Build the Columns grid over a fresh in-memory store: name/type/nullable/
 * PK/generated/wire-type always, plus default/sequence/filler when
 * `onOpenSequence` is given.
 *
 * @param columns - The relation's introspected columns.
 * @param onOpenSequence - Invoked with a sequence's schema and name when its
 *   link is clicked. Omit for a relation that can have no sequence
 *   (views/matviews): the grid then has no Default/Sequence/filler column at
 *   all, and stays read-only.
 * @param editable - Whether the grid's Name/Type/Nullable/Default cells are
 *   inline-editable. Defaults to `false`, and is honoured only alongside
 *   `onOpenSequence` — a relation with no `onOpenSequence` (a view/matview's
 *   DefinitionPanel) always renders the plain read-only grid regardless of
 *   this flag.
 */
export function buildColumnsGrid(
    columns: ColumnMeta[],
    onOpenSequence?: OpenSequenceHandler,
    editable = false,
): ColumnsGrid {
    const fields = onOpenSequence ? [...DISPLAY_FIELDS, ...STRUCTURE_FIELDS] : DISPLAY_FIELDS;
    const model  = new Model({ fields });
    const store  = new MemoryStore({ model, data: toColumnRows(columns), autoLoad: true });
    const grid   = onOpenSequence ? linkedColumnsTable(store, onOpenSequence, editable) : readOnlyTable(store);

    return { grid, store };
}

/** True when `r`'s row is a generated column — the per-cell edit gate for Type/Nullable/Default. */
const generatedRow = (r: ModelRecord): boolean => r.get("isGenerated") === true;

/**
 * The Columns grid with its Sequence cell rendered as a link, and — when
 * `editable` — its Name/Type/Nullable/Default cells inline-editable (locked
 * on a generated row, per the plan's per-column-kind matrix). Mirrors
 * StructurePanel's foreign-keys grid: columns listed explicitly to give one
 * field a link renderer and per-field width/read-only overrides — display
 * order itself comes from each field's `order` in DISPLAY_FIELDS/
 * STRUCTURE_FIELDS above, not from this array's own listing sequence (`Column.resolve`
 * sorts by `Field.getOrder()` first and only then applies this array as a
 * lookup) — and `appendUnlisted: false` so the sequence lookup pair,
 * `originalName`, and `filler`'s absence of a `ColumnRow` counterpart never
 * surface a stray auto-generated column. `readOnly`, `rowReadOnly`, and
 * `cellReadOnly` are OR-ed by the library, so a non-editable grid's `rowReadOnly: () => true`
 * locks every cell regardless of the per-column entries below it. The
 * `sequence` column carries a renderer, so the library never samples it under
 * `autoSizeColumns`; every column but `filler` declares `maxWidth:
 * CONTENT_WIDTH_CAP`, which — combined with `filler` declaring none — is what
 * makes `filler` the one column absorbing the grid's leftover width (see
 * CONTENT_WIDTH_CAP's comment above).
 *
 * @param store - The grid's backing store, holding `toColumnRows` output.
 * @param onOpenSequence - Invoked with the clicked sequence's schema and name.
 * @param editable - Whether the grid's editable cells accept inline edits.
 *
 * @returns The wired grid.
 */
function linkedColumnsTable(store: MemoryStore, onOpenSequence: OpenSequenceHandler, editable: boolean): Table {
    const spec: ColumnSpec = {
        columns: [
            { field: "name", maxWidth: CONTENT_WIDTH_CAP },
            { field: "fullType", maxWidth: CONTENT_WIDTH_CAP, cellReadOnly: generatedRow },
            { field: "nullable", cellReadOnly: generatedRow },
            { field: "defaultExpr", maxWidth: CONTENT_WIDTH_CAP, cellReadOnly: generatedRow },
            { field: "isPrimaryKey", readOnly: true },
            { field: "isGenerated", readOnly: true },
            { field: "wireType", readOnly: true, maxWidth: CONTENT_WIDTH_CAP },
            { field: "sequence", renderer: () => new LinkCellRenderer(), width: SEQUENCE_COLUMN_WIDTH, maxWidth: CONTENT_WIDTH_CAP },
            { field: "filler", headerText: "", minWidth: 0, unhideable: true, readOnly: true },
        ],
        autoSizeColumns: true,
        appendUnlisted:  false,
        ...(editable ? {} : { rowReadOnly: () => true }),
    };

    const grid = Table(store, spec);

    // cellclick fires for any cell, so gate on the sequence column before acting.
    grid.on("cellclick", (e: CellClickEvent) => {
        if (e.field !== "sequence") {
            return;
        }

        const schema = String(e.record.get("sequenceSchema") ?? "");
        const name   = String(e.record.get("sequenceName") ?? "");

        // A column with no backing sequence renders an empty cell; clicking it
        // is a no-op rather than an attempt to open "".
        if (!schema || !name) {
            return;
        }

        onOpenSequence(schema, name);
    });

    return grid;
}
