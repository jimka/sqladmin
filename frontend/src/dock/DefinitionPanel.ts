// An editable, selectable view of a (materialized) view's SQL definition
// (pg_get_viewdef) plus a read-only grid of its columns, shown in its own
// dock tab opened from the navigator's right-click menu — the definition
// counterpart to StructurePanel (which stays table-only: a view/matview's
// only meaningful structure facet is its columns, folded in here instead of
// a separate "Show structure" tab; see NavigatorTree's table-only guard on
// that item). The definition and columns are fetched by the controller
// (openDefinition) and passed in already-resolved.
//
// A NORTH toolbar carries a single Save button: it reads the editor's
// current text and hands it to `onSave`, which the controller wires to
// build and execute a CREATE OR REPLACE VIEW (or, for a materialized view,
// the atomic DROP+CREATE replace pair) with no intermediate dialog — see
// SqlAdminController.openDefinition. Below the toolbar, a vertical Split
// holds the Columns grid at a compact fixed height on top and the
// definition editor filling the rest. `reload` reseeds both after a
// successful Save, keeping the tab open in place rather than rebuilding it.
//
// The editor + dirty-gated Save toolbar are the shared DefinitionEditor
// (also behind FunctionDefinitionPanel); this panel only adds the columns
// grid around it.

import { Container }          from "@jimka/typescript-ui/core";
import { Border, Split }      from "@jimka/typescript-ui/layout";
import { Placement }          from "@jimka/typescript-ui/primitive";
import { Text }               from "@jimka/typescript-ui/component/input";
import { MemoryStore }        from "@jimka/typescript-ui/data";
import type { ColumnMeta }    from "../contract";
import { buildColumnsGrid }   from "./columnsGrid";
import { DefinitionEditor }   from "./definitionEditor";

// The Columns pane's fixed height in the vertical Split below the toolbar —
// compact enough that the definition editor, the tab's main content, gets
// the bulk of the space. Mirrors StructurePanel's own fixed section height
// for the same grid, trimmed down since this tab has only one facet, not four.
const COLUMNS_PANE_HEIGHT = 180;

/**
 * A panel showing a view/matview's Columns grid above its editable,
 * SQL-highlighted definition. A class-first composition wrapper: the
 * instance owns `content` (the mountable subtree) and `dispose` (releasing
 * the editor's view and theme subscription) rather than `extends`-ing a
 * library base.
 */
export class DefinitionPanel {
    readonly content: Container;
    readonly dispose: () => void;

    private readonly _editor: DefinitionEditor;
    private readonly _columnsStore: MemoryStore;

    /**
     * @param definition - the view/matview's SQL definition (pg_get_viewdef) —
     *   the SELECT body only, with no CREATE/DROP wrapper.
     * @param columns - the view/matview's introspected columns.
     * @param onSave - writes the editor's current text back to the database;
     *   the controller builds the CREATE OR REPLACE VIEW / matview
     *   DROP+CREATE from it (see SqlAdminController.openDefinition).
     */
    constructor(definition: string, columns: ColumnMeta[], onSave: (newDefinition: string) => void | Promise<void>) {
        const editor = new DefinitionEditor(definition, onSave);
        const { grid: columnsGrid, store: columnsStore } = buildColumnsGrid(columns);

        const columnsSection = Container({
            layoutManager: new Border(),
            preferredSize: { width: 0, height: COLUMNS_PANE_HEIGHT },
            minSize:       { width: 0, height: COLUMNS_PANE_HEIGHT },
        });
        columnsSection.addComponent(new Text("Columns"), { placement: Placement.NORTH });
        columnsSection.addComponent(columnsGrid, { placement: Placement.CENTER });

        // A vertical Split: the Columns section pinned at its fixed height
        // (weight 0), the definition editor absorbing the rest of the tab
        // (weight 1) — mirrors QueryPanel's editor-over-result Split.
        const body = Container({ layoutManager: new Split({ orientation: "vertical" }) });
        body.addComponent(columnsSection, { weight: 0 });
        body.addComponent(editor.editor, { weight: 1 });

        this.content = Container({ layoutManager: new Border({ spacing: 0 }) });
        this.content.addComponent(editor.toolbar, { placement: Placement.NORTH });
        this.content.addComponent(body, { placement: Placement.CENTER });

        this._editor = editor;
        this._columnsStore = columnsStore;

        this.dispose = () => editor.dispose();
    }

    /**
     * Reseed the editor text and Columns grid after a successful Save —
     * called by the controller instead of rebuilding the tab, so the panel
     * simply reflects the object's new state in place (see
     * SqlAdminController.openDefinition).
     *
     * @param definition - the freshly re-fetched definition.
     * @param columns - the freshly re-fetched columns.
     */
    reload(definition: string, columns: ColumnMeta[]): void {
        this._editor.reload(definition);
        this._columnsStore.loadData(columns);
    }
}
