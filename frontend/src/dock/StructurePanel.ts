// The table structure inspector, opened as its own Dock tab from the
// navigator's right-click "Show ▸ Structure" menu. Presents a table's
// structure as a four-section accordion — Columns, Indexes, Constraints, and
// Foreign Keys — each with a leading glyph in its header. Only Columns opens by
// default (the facet reached for first); the other three start collapsed and
// expand on demand. Clicking the referenced-table link in the Foreign Keys grid
// opens that table via `onOpenReferenced`; clicking a column's Sequence link in
// the Columns grid opens that sequence via `onOpenSequence`. Every grid is the
// existing read-only Table over a MemoryStore; array fields are pre-joined to
// comma-separated display strings because the library Table has no array cell
// renderer.
//
// Each section header carries its own glyph-only Refresh tool, always present
// (independent of `actions` — a read-only structure tab still wants each
// section refreshable). Clicking one re-fetches and reseeds only that
// section's own grid; see `reloadColumns`/`reloadIndexes`/`reloadConstraints`/
// `reloadForeignKeys` and the `StructureRefresh` callbacks the controller
// wires in. `reload` reseeds all four at once and backs the tab-wide Alt+R /
// View → Refresh path instead (see SqlAdminController.refreshActive) — the
// per-section tools are click-only, additional granularity on top of that.
//
// The scroll host follows the library's Accordion demo: the accordion is
// hosted in an `autoScroll` VBox with `weight: 1`, runs in `fillHeight` mode,
// and each grid declares a per-section height (SECTION_HEIGHT). So a
// lone/last open section grows to fill a tall tab, but when the open sections
// together exceed the tab the whole stack SCROLLS rather than clipping — the
// Accordion never scrolls itself vertically (it shrink-to-fits by design), so
// the surrounding scroll pane is what keeps every section reachable.
//
// When `actions` (table-ddl phase) is passed, each editable section also
// carries its add/alter/drop launchers as glyph-only header tools, ahead of
// the always-present Refresh tool: Add is always enabled, Alter/Drop enable
// only once the section's grid has a selected row. The grids themselves stay
// read-only cells (rowReadOnly) either way — structure edits are
// tool-launched dialogs, never inline cell edits (the library Table has no
// per-row context-menu event to hang inline editing off; see the table-ddl
// plan's "Read-only cells stay read-only" decision). Omitting `actions` gives
// every section header just its Refresh tool.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): the panel `extends Panel`
// (the scroll host) and holds the AccordionPanel as its sole weighted child.

// Each section's natural content height, declared on its grid — the accordion
// demo sizes section contents this way. It gives the accordion a definite
// preferred height (so the host VBox's autoScroll knows when the open sections
// overflow the tab and must scroll), while `fillHeight` lets the last open
// section grow past it to fill a tall tab.
const SECTION_HEIGHT = 200;

import { Panel, callable } from "@jimka/typescript-ui/core";
import { VBox, LayoutConstraints } from "@jimka/typescript-ui/layout";
import { AccordionPanel }      from "@jimka/typescript-ui/component/container";
import { Button }              from "@jimka/typescript-ui/component/button";
import { Glyph }               from "@jimka/typescript-ui/component/display";
import { Table, LinkCellRenderer } from "@jimka/typescript-ui/component/table";
import type { CellClickEvent } from "@jimka/typescript-ui/component/table";
import { MemoryStore, Model }  from "@jimka/typescript-ui/data";
import { table_columns }       from "@jimka/typescript-ui/glyphs/solid/table_columns";
import { list }                from "@jimka/typescript-ui/glyphs/solid/list";
import { shield_halved }       from "@jimka/typescript-ui/glyphs/solid/shield_halved";
import { link }                from "@jimka/typescript-ui/glyphs/solid/link";
import { plus }                from "@jimka/typescript-ui/glyphs/solid/plus";
import { pencil }              from "@jimka/typescript-ui/glyphs/solid/pencil";
import { trash }               from "@jimka/typescript-ui/glyphs/solid/trash";
import { refresh }             from "@jimka/typescript-ui/glyphs/solid/refresh";
import type {
    AlterColumnAction,
    ColumnMeta,
    ConstraintKind,
    ConstraintMeta,
    ForeignKeyMeta,
    IndexMeta,
    TableStructure,
} from "../contract";
import { buildColumnsGrid, readOnlyTable } from "./columnsGrid";
import type { OpenSequenceHandler } from "./columnsGrid";
import { toColumnRows } from "./columnSequence";
import { constraintRows, foreignKeyRows } from "./structureRows";
import { glyphButton, glyphMenuButton } from "./glyphButton";
import { buildAlterColumnItems, buildAddConstraintItems } from "./menuItems";
import { CONSTRUCTIVE_COLOR, DESTRUCTIVE_COLOR, PRIMARY_COLOR } from "../theme";
import type { AccordionLayoutBinding } from "../data/layoutStore";

// Section-header glyphs (Columns / Indexes / Constraints / Foreign Keys), the
// header tools' add/alter/drop glyphs (plus / pencil / trash), and each
// section's own Refresh glyph.
Glyph.register(table_columns, list, shield_halved, link, plus, pencil, trash, refresh);

/**
 * The edit-action callbacks a table-ddl-aware caller wires into the panel's
 * section toolbars. Optional on the constructor — omitting it keeps every
 * section header carrying only its Refresh tool.
 */
export interface StructureActions {
    onAddColumn(): void;
    onAlterColumn(column: ColumnMeta, action: AlterColumnAction): void;
    onDropColumn(column: ColumnMeta): void;
    onAddConstraint(kind: ConstraintKind): void;
    onDropConstraint(constraintName: string): void;
    onCreateIndex(): void;
    onDropIndex(indexName: string): void;
}

/**
 * The per-section refresh callbacks the controller wires in — always
 * present, unlike `StructureActions`, since a read-only structure tab still
 * wants each section's own Refresh. Each callback fires only its section's
 * header tool; the controller decides what to fetch and calls back into the
 * matching `reload*` method (see SqlAdminController.openStructure).
 */
export interface StructureRefresh {
    onRefreshColumns(): void;
    onRefreshIndexes(): void;
    onRefreshConstraints(): void;
    onRefreshForeignKeys(): void;
}

/** A structure grid plus the store backing it, so `reload` can reseed without rebuilding the Table. */
interface StructureGrid {
    grid: Table;
    store: MemoryStore;
}

/** Drop the section's selection, then replace its rows. */
function reseed(section: StructureGrid, rows: object[]): void {
    section.grid.selectRecord(null);
    section.store.loadData(rows);
}

/**
 * The structure inspector panel for one table: a four-section accordion, one
 * facet per section, each section's header carrying its own Refresh tool
 * (plus, when `actions` is passed, that section's add/alter/drop launchers).
 */
class StructurePanel extends Panel {
    // Mutable: reassigned by `reloadColumns`, so the Columns section's tools
    // (built once at construction) resolve a selected row against the
    // current column list via a getter rather than a stale captured array —
    // see buildColumnsTools.
    private _columns: ColumnMeta[];

    private readonly _columnsSection:     StructureGrid;
    private readonly _indexesSection:     StructureGrid;
    private readonly _constraintsSection: StructureGrid;
    private readonly _foreignKeysSection: StructureGrid;

    /**
     * @param columns - The table's introspected columns (the Columns grid).
     * @param structure - The table's indexes, constraints, and foreign keys.
     * @param onOpenReferenced - Invoked with a foreign key's referenced schema
     *   and table when its row is selected, so the controller can open that
     *   table.
     * @param onOpenSequence - Invoked with a column's backing sequence's schema
     *   and name when its Sequence link is clicked, so the controller can open
     *   that sequence.
     * @param refresh - The per-section Refresh callbacks, one per header tool.
     * @param layout - The tab's saved section open flags plus the toggle save
     *   hook (`controller.layout.bindAccordion("structure")`). This accordion
     *   is not resizable, so only open state persists.
     * @param actions - The edit-action callbacks for each section's header
     *   tools (table-ddl phase). Omitted leaves every section header with
     *   just its Refresh tool.
     */
    constructor(
        columns: ColumnMeta[],
        structure: TableStructure,
        onOpenReferenced: (refSchema: string, refTable: string) => void,
        onOpenSequence: OpenSequenceHandler,
        refresh: StructureRefresh,
        layout: AccordionLayoutBinding,
        actions?: StructureActions,
    ) {
        // The scroll host: an autoScroll VBox holding the accordion at weight 1,
        // so the accordion fills the tab when the sections fit and the whole
        // stack scrolls when they overflow — the Accordion never scrolls itself
        // (it shrink-to-fits by design; see the class doc). Toggling a section
        // now re-lays-out this host on its own: the Accordion signals its
        // intrinsic-size change up to the scroll host (typescript-ui
        // Component.notifyIntrinsicSizeChanged), so no onSectionToggle relay is
        // needed here.
        super({ layoutManager: new VBox({ stretching: true }), autoScroll: "auto" });

        this._columns = columns;

        const columnsSection     = buildColumnsGrid(columns, onOpenSequence);
        const indexesSection     = buildIndexesGrid(structure.indexes);
        const constraintsSection = buildConstraintsGrid(structure.constraints);
        const foreignKeysSection = buildForeignKeysGrid(structure.foreignKeys, onOpenReferenced);

        this._columnsSection     = columnsSection;
        this._indexesSection     = indexesSection;
        this._constraintsSection = constraintsSection;
        this._foreignKeysSection = foreignKeysSection;

        // Declare each section's natural height (see SECTION_HEIGHT) so the
        // accordion has a definite preferred size for the scroll host — the
        // accordion demo sizes section contents this way.
        for (const section of [columnsSection, indexesSection, constraintsSection, foreignKeysSection]) {
            section.grid.setPreferredSize({ width: 0, height: SECTION_HEIGHT });
        }

        // Only Columns opens by default — the facet a reader reaches for first;
        // the other three start collapsed to their header row and expand on
        // demand. The defaults live in ACCORDION_DEFAULT_OPEN (data/layoutStore.ts);
        // `open` reads them (or a saved override) pre-super, since AccordionPanel
        // has no post-construction initiallyOpen setter.
        const open = layout.loadOpen();

        const accordion: AccordionPanel = new AccordionPanel({
            sections: [
                { label: "Columns",      component: columnsSection.grid,     glyph: "table-columns", initiallyOpen: open[0], tools: buildColumnsTools(() => this._columns, columnsSection.grid, refresh.onRefreshColumns, actions) },
                { label: "Indexes",      component: indexesSection.grid,     glyph: "list",          initiallyOpen: open[1], tools: buildIndexesTools(indexesSection.grid, refresh.onRefreshIndexes, actions) },
                { label: "Constraints",  component: constraintsSection.grid, glyph: "shield-halved", initiallyOpen: open[2], tools: buildConstraintsTools(constraintsSection.grid, refresh.onRefreshConstraints, actions) },
                { label: "Foreign Keys", component: foreignKeysSection.grid, glyph: "link",          initiallyOpen: open[3], tools: buildForeignKeysTools(foreignKeysSection.grid, refresh.onRefreshForeignKeys, actions) },
            ],
            onSectionToggle: layout.onToggle,
        });

        // fillHeight: the last open section grows to fill leftover height when
        // the sections underflow the tab (IDE/dock-panel style). Tools always
        // visible so the glyph launchers show without hovering the header.
        accordion.getAccordion().setFillHeight(true).setCompact(true).setToolsVisibility("always");

        const constraints = new LayoutConstraints();
        constraints.weight = 1;
        this.addComponent(accordion, constraints);
    }

    /**
     * Reseed the Columns section after a successful Columns Refresh (or a
     * whole-tab `reload`) — called by the controller instead of rebuilding
     * the tab. `this._columns` is what `buildColumnsTools`'s Alter/Drop
     * launchers resolve a selected row against, so it must track the same
     * data the grid now shows.
     *
     * @param columns - the freshly re-fetched columns.
     */
    reloadColumns(columns: ColumnMeta[]): void {
        this._columns = columns;

        reseed(this._columnsSection, toColumnRows(columns));
    }

    /** Reseed the Indexes section after a successful Indexes Refresh (or a whole-tab `reload`). */
    reloadIndexes(indexes: IndexMeta[]): void {
        reseed(this._indexesSection, indexes);
    }

    /** Reseed the Constraints section after a successful Constraints Refresh (or a whole-tab `reload`). */
    reloadConstraints(constraints: ConstraintMeta[]): void {
        reseed(this._constraintsSection, constraintRows(constraints));
    }

    /** Reseed the Foreign Keys section after a successful Foreign Keys Refresh (or a whole-tab `reload`). */
    reloadForeignKeys(foreignKeys: ForeignKeyMeta[]): void {
        reseed(this._foreignKeysSection, foreignKeyRows(foreignKeys));
    }

    /**
     * Reseed all four sections at once — the tab-wide counterpart to the
     * four per-section `reload*` methods, backing Alt+R / View → Refresh
     * (see SqlAdminController.refreshActive) rather than any header tool.
     *
     * @param columns - the freshly re-fetched columns.
     * @param structure - the freshly re-fetched indexes, constraints, and foreign keys.
     */
    reload(columns: ColumnMeta[], structure: TableStructure): void {
        this.reloadColumns(columns);
        this.reloadIndexes(structure.indexes);
        this.reloadConstraints(structure.constraints);
        this.reloadForeignKeys(structure.foreignKeys);
    }
}

/**
 * Enable `buttons` only while `grid` has a selected row, and set their
 * initial (disabled) state immediately — every section opens with no
 * selection.
 *
 * @param grid - The section's grid to watch.
 * @param buttons - The toolbar buttons to gate (Alter/Drop; Add and Refresh
 *   stay always-enabled and are never passed here).
 */
function gateOnSelection(grid: Table, buttons: Button[]): void {
    const sync = (): void => {
        const hasSelection = grid.getSelectedRecord() !== null;

        for (const button of buttons) {
            button.setEnabled(hasSelection);
        }
    };

    grid.on("selection", sync);
    sync();
}

/**
 * Look up a column's full metadata by name — the grid's selection only
 * carries the row's display fields, so the toolbar re-resolves the selected
 * name against the table's own introspected columns to hand the launcher a
 * complete `ColumnMeta`.
 *
 * @param columns - The table's introspected columns.
 * @param name - The selected row's column name.
 *
 * @returns The matching column, or undefined if it somehow isn't found.
 */
function findColumn(columns: ColumnMeta[], name: string): ColumnMeta | undefined {
    return columns.find(c => c.name === name);
}

/**
 * Build the Columns section's header tools: Add (always enabled), Alter (a
 * submenu built by {@link buildAlterColumnItems}), and Drop (both gated on a
 * selected row) when `actions` is passed, then Refresh last — always
 * present, independent of `actions`.
 *
 * @param currentColumns - Reads the table's current introspected columns, to
 *   resolve the selected row back to a full `ColumnMeta`. A getter rather
 *   than a plain array, since `reloadColumns` replaces the panel's column
 *   list after construction — a captured array would leave Alter/Drop
 *   resolving a selected row against the pre-refresh column list.
 * @param grid - The Columns grid to read the selection from.
 * @param onRefresh - Invoked when this section's Refresh tool is clicked.
 * @param actions - The launcher callbacks to invoke, if this tab is table-ddl-aware.
 *
 * @returns The wired header tool buttons, in display order.
 */
function buildColumnsTools(
    currentColumns: () => ColumnMeta[],
    grid: Table,
    onRefresh: () => void,
    actions?: StructureActions,
): Button[] {
    const refreshButton = glyphButton("refresh", PRIMARY_COLOR, "Refresh columns", onRefresh);

    if (!actions) {
        return [refreshButton];
    }

    const addButton = glyphButton("plus", CONSTRUCTIVE_COLOR, "Add column", () => actions.onAddColumn());
    const alterButton = glyphMenuButton("pencil", PRIMARY_COLOR, "Alter column",
                                        () => buildAlterColumnItems(selectedColumn(currentColumns(), grid), actions));
    const dropButton = glyphButton("trash", DESTRUCTIVE_COLOR, "Drop column", () => {
        const column = selectedColumn(currentColumns(), grid);

        if (column) {
            actions.onDropColumn(column);
        }
    });

    gateOnSelection(grid, [alterButton, dropButton]);

    return [addButton, alterButton, dropButton, refreshButton];
}

/**
 * Resolve the Columns grid's currently selected row to its full `ColumnMeta`.
 *
 * @param columns - The table's introspected columns.
 * @param grid - The Columns grid.
 *
 * @returns The selected column, or undefined when nothing is selected.
 */
function selectedColumn(columns: ColumnMeta[], grid: Table): ColumnMeta | undefined {
    const record = grid.getSelectedRecord();

    return record ? findColumn(columns, String(record.get("name"))) : undefined;
}

/**
 * Build the Indexes section's header tools: Create (always enabled) and Drop
 * (gated on a selected row) when `actions` is passed, then Refresh last —
 * always present, independent of `actions`.
 *
 * @param grid - The Indexes grid to read the selection from.
 * @param onRefresh - Invoked when this section's Refresh tool is clicked.
 * @param actions - The launcher callbacks to invoke, if this tab is table-ddl-aware.
 *
 * @returns The wired header tool buttons, in display order.
 */
function buildIndexesTools(grid: Table, onRefresh: () => void, actions?: StructureActions): Button[] {
    const refreshButton = glyphButton("refresh", PRIMARY_COLOR, "Refresh indexes", onRefresh);

    if (!actions) {
        return [refreshButton];
    }

    const createButton = glyphButton("plus", CONSTRUCTIVE_COLOR, "Create index", () => actions.onCreateIndex());
    const dropButton = glyphButton("trash", DESTRUCTIVE_COLOR, "Drop index", () => {
        const record = grid.getSelectedRecord();

        if (record) {
            actions.onDropIndex(String(record.get("name")));
        }
    });

    gateOnSelection(grid, [dropButton]);

    return [createButton, dropButton, refreshButton];
}

/**
 * Build the Constraints section's header tools: Add (a submenu built by
 * {@link buildAddConstraintItems}, always enabled) and Drop (gated on a
 * selected row) when `actions` is passed, then Refresh last — always
 * present, independent of `actions`.
 *
 * @param grid - The Constraints grid to read the selection from.
 * @param onRefresh - Invoked when this section's Refresh tool is clicked.
 * @param actions - The launcher callbacks to invoke, if this tab is table-ddl-aware.
 *
 * @returns The wired header tool buttons, in display order.
 */
function buildConstraintsTools(grid: Table, onRefresh: () => void, actions?: StructureActions): Button[] {
    const refreshButton = glyphButton("refresh", PRIMARY_COLOR, "Refresh constraints", onRefresh);

    if (!actions) {
        return [refreshButton];
    }

    const addButton = glyphMenuButton("plus", CONSTRUCTIVE_COLOR, "Add constraint", buildAddConstraintItems(actions));
    const dropButton = glyphButton("trash", DESTRUCTIVE_COLOR, "Drop constraint", () => {
        const record = grid.getSelectedRecord();

        if (record) {
            actions.onDropConstraint(String(record.get("name")));
        }
    });

    gateOnSelection(grid, [dropButton]);

    return [addButton, dropButton, refreshButton];
}

/**
 * Build the Foreign Keys section's header tools: Drop only (gated on a
 * selected row) when `actions` is passed — adding a foreign key is offered
 * from the Constraints section's Add submenu instead, so every constraint
 * kind has exactly one add affordance — then Refresh last, always present.
 *
 * @param grid - The Foreign Keys grid to read the selection from.
 * @param onRefresh - Invoked when this section's Refresh tool is clicked.
 * @param actions - The launcher callbacks to invoke (foreign keys drop
 *   through the same `onDropConstraint` as any other named constraint), if
 *   this tab is table-ddl-aware.
 *
 * @returns The wired header tool buttons, in display order.
 */
function buildForeignKeysTools(grid: Table, onRefresh: () => void, actions?: StructureActions): Button[] {
    const refreshButton = glyphButton("refresh", PRIMARY_COLOR, "Refresh foreign keys", onRefresh);

    if (!actions) {
        return [refreshButton];
    }

    const dropButton = glyphButton("trash", DESTRUCTIVE_COLOR, "Drop constraint", () => {
        const record = grid.getSelectedRecord();

        if (record) {
            actions.onDropConstraint(String(record.get("name")));
        }
    });

    gateOnSelection(grid, [dropButton]);

    return [dropButton, refreshButton];
}

/** The Indexes grid (name / definition / unique / primary). */
function buildIndexesGrid(indexes: IndexMeta[]): StructureGrid {
    const model = new Model({
        fields: [
            { name: "name", type: "string", description: "Name", order: 1 },
            { name: "definition", type: "string", description: "Definition", order: 2 },
            { name: "unique", type: "boolean", description: "Unique", order: 3 },
            { name: "primary", type: "boolean", description: "Primary", order: 4 },
        ],
    });

    const store = new MemoryStore({ model, data: indexes, autoLoad: true });
    const grid  = readOnlyTable(store);

    return { grid, store };
}

/** The Constraints grid; the constrained columns are comma-joined. */
function buildConstraintsGrid(constraints: ConstraintMeta[]): StructureGrid {
    const model = new Model({
        fields: [
            { name: "name", type: "string", description: "Name", order: 1 },
            { name: "type", type: "string", description: "Type", order: 2 },
            { name: "columns", type: "string", description: "Columns", order: 3 },
            { name: "definition", type: "string", description: "Definition", order: 4 },
        ],
    });

    const store = new MemoryStore({ model, data: constraintRows(constraints), autoLoad: true });
    const grid  = readOnlyTable(store);

    return { grid, store };
}

/**
 * The Foreign Keys grid, wired so clicking the referenced-table link opens
 * that table. The referenced-table cell renders as a link via
 * `ColumnConfig.renderer`; the grid's `"cellclick"` event carries the clicked
 * field and record, so the handler acts only on the `refTable` column and reads
 * the referenced schema/table straight off the clicked record.
 *
 * @param foreignKeys - The table's foreign keys.
 * @param onOpenReferenced - Invoked with the clicked FK's referenced schema and
 *   table.
 *
 * @returns The wired section.
 */
function buildForeignKeysGrid(
    foreignKeys: ForeignKeyMeta[],
    onOpenReferenced: (refSchema: string, refTable: string) => void,
): StructureGrid {
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

    const store = new MemoryStore({ model, data: foreignKeyRows(foreignKeys), autoLoad: true });
    // Columns listed explicitly to keep display order while giving refTable a
    // link renderer; the rest stay read-only text. rowReadOnly locks every cell
    // (structure edits are toolbar-launched dialogs, not inline cell edits).
    // refTable carries a renderer, so the library never samples it under
    // autoSizeColumns and it stays flexible, absorbing the leftover width.
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
        autoSizeColumns: true,
        appendUnlisted:  false,
        rowReadOnly:     () => true,
    });

    // Clicking a referenced-table link opens that table. cellclick fires for any
    // cell, so gate on the refTable column before acting.
    grid.on("cellclick", (e: CellClickEvent) => {
        if (e.field !== "refTable") {
            return;
        }

        onOpenReferenced(String(e.record.get("refSchema")), String(e.record.get("refTable")));
    });

    return { grid, store };
}

const StructurePanelCallable = callable(StructurePanel);
type StructurePanelCallable = StructurePanel;
export { StructurePanelCallable as StructurePanel };
