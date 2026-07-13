// An editable, selectable view of a function/procedure's full definition
// (pg_get_functiondef) shown in its own dock tab, opened from the navigator
// (double-click or "Show definition"). The function counterpart to
// DefinitionPanel — but a routine has no columns facet, and its
// pg_get_functiondef text is already a complete, executable
// `CREATE OR REPLACE FUNCTION|PROCEDURE …` statement, so this panel is just
// the editor filling the tab under a NORTH Save toolbar, with no grid and no
// SQL wrapping around the saved text (see SqlAdminController.openFunctionDefinition).
//
// A NORTH toolbar carries a single dirty-gated Save button: it hands the
// editor's current text straight to `onSave`, which the controller executes
// as-is. `reload` reseeds the editor after a successful Save, keeping the tab
// open in place rather than rebuilding it. The editor + Save toolbar are the
// shared DefinitionEditor (also behind DefinitionPanel).

import { Container }         from "@jimka/typescript-ui/core";
import { Border }            from "@jimka/typescript-ui/layout";
import { Placement }         from "@jimka/typescript-ui/primitive";
import { DefinitionEditor }  from "./definitionEditor";

/**
 * A panel showing a function/procedure's editable, SQL-highlighted
 * definition. A class-first composition wrapper: the instance owns `content`
 * (the mountable subtree) and `dispose` (releasing the editor's view and
 * theme subscription) rather than `extends`-ing a library base.
 */
export class FunctionDefinitionPanel {
    readonly content: Container;
    readonly dispose: () => void;

    private readonly _editor: DefinitionEditor;

    /**
     * @param definition - the routine's full `pg_get_functiondef` text — a
     *   complete `CREATE OR REPLACE FUNCTION|PROCEDURE …` statement.
     * @param onSave - writes the editor's current text back to the database;
     *   the controller executes it verbatim (see
     *   SqlAdminController.openFunctionDefinition).
     */
    constructor(definition: string, onSave: (newDefinition: string) => void | Promise<void>) {
        const editor = new DefinitionEditor(definition, onSave);

        this.content = Container({ layoutManager: new Border({ spacing: 0 }) });
        this.content.addComponent(editor.toolbar, { placement: Placement.NORTH });
        this.content.addComponent(editor.editor, { placement: Placement.CENTER });

        this._editor = editor;

        this.dispose = () => editor.dispose();
    }

    /**
     * Reseed the editor text after a successful Save — called by the
     * controller instead of rebuilding the tab, so the panel simply reflects
     * the routine's new definition in place (see
     * SqlAdminController.openFunctionDefinition).
     *
     * @param definition - the freshly re-fetched definition.
     */
    reload(definition: string): void {
        this._editor.reload(definition);
    }
}
