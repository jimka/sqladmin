// The table structure inspector, opened as its own Dock tab from the
// navigator's right-click "Open structure" menu. Presents a table's structure
// as a vertical stack of four labelled read-only grids — Columns, Indexes,
// Constraints, and Foreign Keys — in one scrollable panel, so a reader can
// cross-reference every facet at once (e.g. "is customer_id indexed, and what
// does its FK reference?"). Clicking the referenced-table link in the Foreign
// Keys grid opens that table via `onOpenReferenced`. Every grid is the existing
// read-only Table over a MemoryStore; array fields are pre-joined to
// comma-separated display strings because the library Table has no array cell
// renderer.

import { Component, Container, Panel }    from "@jimka/typescript-ui/core";
import { Border, VBox }        from "@jimka/typescript-ui/layout";
import { Placement }           from "@jimka/typescript-ui/primitive";
import { Text }                from "@jimka/typescript-ui/component/input";
import { Table, LinkCellRenderer } from "@jimka/typescript-ui/component/table";
import type { CellClickEvent } from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model }  from "@jimka/typescript-ui/data";
import type {
    ColumnMeta,
    ConstraintMeta,
    ForeignKeyMeta,
    IndexMeta,
    TableStructure,
} from "../contract";

// Fixed height each labelled section occupies in the scrolling stack. Pinned so
// every section is co-visible at a consistent size and the whole structure
// scrolls when the four overflow the tab (the "show everything, scroll if
// needed" inspector model). Each grid scrolls internally past this height, so a
// long facet is never truncated — only the section's viewport is bounded.
const SECTION_HEIGHT = 200;

/**
 * Build the structure inspector panel for one table.
 *
 * @param columns - The table's introspected columns (the Columns grid).
 * @param structure - The table's indexes, constraints, and foreign keys.
 * @param onOpenReferenced - Invoked with a foreign key's referenced schema and
 *   table when its row is selected, so the controller can open that table.
 *
 * @returns A scrolling Panel stacking the four labelled read-only grids.
 */
export function StructurePanel(
    columns: ColumnMeta[],
    structure: TableStructure,
    onOpenReferenced: (refSchema: string, refTable: string) => void,
): Panel {
    return Container({
        layoutManager: new VBox({ stretching: true }),
        autoScroll   : "auto",
        components   : [
            section("Columns", buildColumnsGrid(columns)),
            section("Indexes", buildIndexesGrid(structure.indexes)),
            section("Constraints", buildConstraintsGrid(structure.constraints)),
            section("Foreign Keys", buildForeignKeysGrid(structure.foreignKeys, onOpenReferenced)),
        ],
    });
}

/**
 * Wrap one facet's grid under a caption in a fixed-height section, so an empty
 * facet still shows its labelled (empty) grid rather than vanishing — the
 * structure's shape stays legible at a glance.
 *
 * @param caption - The section heading, e.g. "Foreign Keys".
 * @param grid - The facet's read-only grid.
 *
 * @returns A bordered panel with the caption pinned north above the grid.
 */
function section(caption: string, grid: Component): Panel {
    return Panel({
        layoutManager: new Border(),
        preferredSize: { width: 0, height: SECTION_HEIGHT },
        minSize      : { width: 0, height: SECTION_HEIGHT },
        components   : [
            { component: new Text(caption), constraints: { placement: Placement.NORTH } },
            { component: grid,              constraints: { placement: Placement.CENTER } },
        ],
    });
}

/** The read-only Columns grid — the original StructurePanel content. */
function buildColumnsGrid(columns: ColumnMeta[]): Component {
    const model = new Model({
        fields: [
            { name: "name", type: "string", description: "Column", order: 1 },
            { name: "dataType", type: "string", description: "Type", order: 2 },
            { name: "nullable", type: "boolean", description: "Nullable", order: 3 },
            { name: "isPrimaryKey", type: "boolean", description: "PK", order: 4 },
            { name: "isGenerated", type: "boolean", description: "Generated", order: 5 },
            { name: "wireType", type: "string", description: "Wire type", order: 6 },
        ],
    });

    const store = new MemoryStore({ model, data: columns, autoLoad: true });

    return readOnlyTable(store);
}

/** The read-only Indexes grid (name / definition / unique / primary). */
function buildIndexesGrid(indexes: IndexMeta[]): Component {
    const model = new Model({
        fields: [
            { name: "name", type: "string", description: "Name", order: 1 },
            { name: "definition", type: "string", description: "Definition", order: 2 },
            { name: "unique", type: "boolean", description: "Unique", order: 3 },
            { name: "primary", type: "boolean", description: "Primary", order: 4 },
        ],
    });

    const store = new MemoryStore({ model, data: indexes, autoLoad: true });

    return readOnlyTable(store);
}

/** The read-only Constraints grid; the constrained columns are comma-joined. */
function buildConstraintsGrid(constraints: ConstraintMeta[]): Component {
    const model = new Model({
        fields: [
            { name: "name", type: "string", description: "Name", order: 1 },
            { name: "type", type: "string", description: "Type", order: 2 },
            { name: "columns", type: "string", description: "Columns", order: 3 },
            { name: "definition", type: "string", description: "Definition", order: 4 },
        ],
    });

    const rows = constraints.map(c => ({
        name: c.name,
        type: c.type,
        columns: c.columns.join(", "),
        definition: c.definition,
    }));

    const store = new MemoryStore({ model, data: rows, autoLoad: true });

    return readOnlyTable(store);
}

/**
 * The read-only Foreign Keys grid, wired so clicking the referenced-table link
 * opens that table. The referenced-table cell renders as a link via
 * `ColumnConfig.renderer`; the grid's `"cellclick"` event carries the clicked
 * field and record, so the handler acts only on the `refTable` column and reads
 * the referenced schema/table straight off the clicked record.
 *
 * @param foreignKeys - The table's foreign keys.
 * @param onOpenReferenced - Invoked with the clicked FK's referenced schema and
 *   table.
 *
 * @returns The wired read-only grid.
 */
function buildForeignKeysGrid(
    foreignKeys: ForeignKeyMeta[],
    onOpenReferenced: (refSchema: string, refTable: string) => void,
): Component {
    const model = new Model({
        fields: [
            { name: "name", type: "string", description: "Name", order: 1 },
            { name: "columns", type: "string", description: "Columns", order: 2 },
            { name: "refSchema", type: "string", description: "Ref schema", order: 3 },
            { name: "refTable", type: "string", description: "Ref table", order: 4 },
            { name: "refColumns", type: "string", description: "Ref columns", order: 5 },
            { name: "onUpdate", type: "string", description: "On update", order: 6 },
            { name: "onDelete", type: "string", description: "On delete", order: 7 },
        ],
    });

    const rows = foreignKeys.map(fk => ({
        name: fk.name,
        columns: fk.columns.join(", "),
        refSchema: fk.refSchema,
        refTable: fk.refTable,
        refColumns: fk.refColumns.join(", "),
        onUpdate: fk.onUpdate,
        onDelete: fk.onDelete,
    }));

    const store = new MemoryStore({ model, data: rows, autoLoad: true });
    // Columns listed explicitly to keep display order while giving refTable a
    // link renderer; the rest stay read-only text. rowReadOnly locks every cell
    // (structure edits need DDL the backend does not have yet).
    const grid  = Table(store, {
        columns: [
            { field: "name" },
            { field: "columns" },
            { field: "refSchema" },
            { field: "refTable", renderer: () => new LinkCellRenderer() },
            { field: "refColumns" },
            { field: "onUpdate" },
            { field: "onDelete" },
        ],
        appendUnlisted: false,
        rowReadOnly:    () => true,
    });

    // Clicking a referenced-table link opens that table. cellclick fires for any
    // cell, so gate on the refTable column before acting.
    grid.on("cellclick", (e: CellClickEvent) => {
        if (e.field !== "refTable") {
            return;
        }

        onOpenReferenced(String(e.record.get("refSchema")), String(e.record.get("refTable")));
    });

    return grid;
}

/**
 * Build a read-only grid over a store. Editing structure metadata would need
 * DDL the backend does not have yet, so every auto-appended column is locked.
 *
 * @param store - The facet's in-memory store.
 *
 * @returns A read-only Table over the store.
 */
function readOnlyTable(store: MemoryStore): Table {
    return Table(store, { columns: [], rowReadOnly: () => true });
}
