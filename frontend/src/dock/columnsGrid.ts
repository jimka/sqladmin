// The shared read-only Columns grid — a Table over a MemoryStore of a
// relation's introspected columns (name/type/nullable/PK/generated/wire
// type), used by both StructurePanel's Columns section (tables) and
// DefinitionPanel's Columns section (views/matviews) so the column set and
// formatting stay identical everywhere a relation's columns are shown.
//
// Passing `onOpenSequence` adds a seventh, linked `Sequence` column showing
// the sequence backing each column. It is opt-in because only a table can have
// one: a view/matview never does, so DefinitionPanel omits the callback and
// gets exactly the six-column grid it had before. Row data is mapped by
// columnSequence.ts (pure/DOM-free, unit-tested).
//
// Returns the store alongside the grid so a caller that needs to reseed the
// grid later (DefinitionPanel, after a definition Save) can call
// `store.loadData(...)` directly, without rebuilding the Table.

import { Table, LinkCellRenderer } from "@jimka/typescript-ui/component/table";
import type { CellClickEvent }     from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model }      from "@jimka/typescript-ui/data";
import type { FieldOptions }       from "@jimka/typescript-ui/data";
import type { ColumnMeta }         from "../contract";
import { toColumnRows }            from "./columnSequence";

/** A built Columns grid plus the store backing it. */
export interface ColumnsGrid {
    grid: Table;
    store: MemoryStore;
}

/** Opens a column's backing sequence, given its schema and name. */
export type OpenSequenceHandler = (schema: string, name: string) => void;

/** The display fields every Columns grid shows, linked or not. */
const DISPLAY_FIELDS: FieldOptions[] = [
    { name: "name", type: "string", description: "Column", order: 1 },
    { name: "dataType", type: "string", description: "Type", order: 2 },
    { name: "nullable", type: "boolean", description: "Nullable", order: 3 },
    { name: "isPrimaryKey", type: "boolean", description: "PK", order: 4 },
    { name: "isGenerated", type: "boolean", description: "Generated", order: 5 },
    { name: "wireType", type: "string", description: "Wire type", order: 6 },
];

/**
 * The linked grid's extra fields: the `sequence` display label, plus the
 * schema/name pair the click handler reads. That pair is deliberately not
 * rendered (see `linkedColumnsTable`'s `appendUnlisted: false`) — it exists so
 * the handler never has to re-split the label, which would be ambiguous when a
 * schema or sequence name itself contains a dot.
 */
const SEQUENCE_FIELDS: FieldOptions[] = [
    { name: "sequence", type: "string", description: "Sequence", order: 7 },
    { name: "sequenceSchema", type: "string", description: "Sequence schema", order: 8 },
    { name: "sequenceName", type: "string", description: "Sequence name", order: 9 },
];

/**
 * Build a read-only grid over a store. Structure/definition edits are
 * toolbar- or Save-button-launched flows, never inline cell edits, so every
 * column stays locked regardless of caller.
 *
 * @param store - The grid's backing store.
 * @returns A read-only Table over the store.
 */
export function readOnlyTable(store: MemoryStore): Table {
    return Table(store, { columns: [], rowReadOnly: () => true });
}

/**
 * Build the Columns grid — name/type/nullable/PK/generated/wire-type — over
 * a fresh in-memory store.
 *
 * @param columns - The relation's introspected columns.
 * @param onOpenSequence - Invoked with a sequence's schema and name when its
 *   link is clicked. Omit for a relation that can have no sequence
 *   (views/matviews): the grid then has no Sequence column at all.
 */
export function buildColumnsGrid(columns: ColumnMeta[], onOpenSequence?: OpenSequenceHandler): ColumnsGrid {
    const fields = onOpenSequence ? [...DISPLAY_FIELDS, ...SEQUENCE_FIELDS] : DISPLAY_FIELDS;
    const model  = new Model({ fields });
    const store  = new MemoryStore({ model, data: toColumnRows(columns), autoLoad: true });
    const grid   = onOpenSequence ? linkedColumnsTable(store, onOpenSequence) : readOnlyTable(store);

    return { grid, store };
}

/**
 * The Columns grid with its Sequence cell rendered as a link — mirrors
 * StructurePanel's foreign-keys grid: columns listed explicitly to keep display
 * order while giving one field a link renderer, `appendUnlisted: false` so the
 * two lookup fields stay hidden, and every cell read-only.
 *
 * @param store - The grid's backing store, holding `toColumnRows` output.
 * @param onOpenSequence - Invoked with the clicked sequence's schema and name.
 *
 * @returns The wired grid.
 */
function linkedColumnsTable(store: MemoryStore, onOpenSequence: OpenSequenceHandler): Table {
    const grid = Table(store, {
        columns: [
            { field: "name" },
            { field: "dataType" },
            { field: "nullable" },
            { field: "isPrimaryKey" },
            { field: "isGenerated" },
            { field: "wireType" },
            { field: "sequence", renderer: () => new LinkCellRenderer() },
        ],
        appendUnlisted: false,
        rowReadOnly:    () => true,
    });

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
