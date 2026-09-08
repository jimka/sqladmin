// The shared, dirty-gated "editable SQL definition + Save/Refresh toolbar"
// core behind both DefinitionPanel (a view/matview's editable SELECT body
// over its columns grid) and FunctionDefinitionPanel (a routine's editable
// CREATE OR REPLACE statement). It owns the CodeEditor and the NORTH
// toolbar's Save and Refresh buttons; the dirty flag itself comes from
// CodeEditor.isDirty(). The two remaining fiddly parts this class still owns
// are `_saving`'s gating of Save during an in-flight save (a mid-save edit
// must not re-enable it) and reload()'s setValue()-then-markClean() order
// (so a successful reload — from either a Save or a Refresh — re-disables
// Save instead of leaving it stuck dirty).
// Each panel supplies its own body layout around `editor` and its own
// `onSave`/`onRefresh`; this class carries no view/function specifics.

import { ToolBar }    from "@jimka/typescript-ui/component/menubar";
import { Spacer }     from "@jimka/typescript-ui/component/container";
import { Button }     from "@jimka/typescript-ui/component/button";
import { CodeEditor } from "@jimka/typescript-ui/component/editor";
import { Glyph }      from "@jimka/typescript-ui/component/display";
import { save }       from "@jimka/typescript-ui/glyphs/solid/save";
import { refresh }    from "@jimka/typescript-ui/glyphs/solid/refresh";
import { glyphButton } from "./glyphButton";
import { REFRESH_SHORTCUT } from "../shell/queryShortcuts";
import { PRIMARY_COLOR } from "../theme";

Glyph.register(save, refresh);

/** Options for {@link DefinitionEditor}. */
export interface DefinitionEditorOptions {
    /**
     * Whether the editor shows live parser-error diagnostics. Default
     * `false`: FunctionDefinitionPanel's `pg_get_functiondef` text is
     * dollar-quoted, which the library's generic-SQL grammar reports as an
     * error, so only DefinitionPanel opts in (see
     * plans/implemented/sql-editor-live-linting.md's decision table).
     */
    lint?: boolean;
}

/**
 * An SQL CodeEditor paired with a NORTH toolbar carrying a dirty-gated Save
 * button and a Refresh button. A composition helper (not a component): the
 * owning panel reads {@link editor} and {@link toolbar} to build its own
 * layout and calls {@link reload} after a successful save or a Refresh.
 * {@link editor} is a registered descendant of the panel's `content`, so the
 * Dock's teardown on tab close reaches it without this class owning any
 * disposal of its own.
 */
export class DefinitionEditor {
    /** The SQL editor holding the definition text. */
    readonly editor: CodeEditor;

    /** A two-button toolbar (Save, Refresh) to mount NORTH of {@link editor}. */
    readonly toolbar: ToolBar;

    private readonly _saveButton: Button;

    /** True while an onSave is in flight, suppressing `syncDirty` so a mid-save edit can't re-enable Save. */
    private _saving = false;

    /**
     * @param definition - the initial definition text (the editor's seed
     *   text; Save begins disabled since a freshly constructed `CodeEditor`
     *   reports itself clean).
     * @param onSave - writes the editor's current text back to the database;
     *   Save is disabled for its duration and re-evaluated once it settles.
     * @param onRefresh - re-fetches the definition and reseeds the editor,
     *   discarding any unsaved edit with no confirmation prompt.
     * @param options - see {@link DefinitionEditorOptions}.
     */
    constructor(
        definition: string,
        onSave: (text: string) => void | Promise<void>,
        onRefresh: () => void,
        options: DefinitionEditorOptions = {},
    ) {
        this.editor = new CodeEditor(definition, { language: "sql", lint: options.lint ?? false });

        // Save is disabled for the duration of `onSave` and `_saving`
        // suppresses `syncDirty`, so neither a double-click nor a mid-save edit
        // can fire a second overlapping save. After the save settles,
        // `syncDirty` restores the right state: a successful save reloads the
        // panel (`reload` marks the editor clean → not dirty → disabled); a
        // failed one leaves the edits in place (still dirty → enabled).
        const handleSave = (): void => {
            this._saving = true;
            this._saveButton.setEnabled(false);

            void Promise.resolve(onSave(this.editor.getValue())).finally(() => {
                this._saving = false;
                this.syncDirty();
            });
        };

        this._saveButton = glyphButton("save", PRIMARY_COLOR, "Save", handleSave);
        // Flex spacer pushes Refresh to the far right, away from Save — the
        // same edit-actions-left/Refresh-far-right grouping TableWorkPanel's
        // data-grid toolbar uses.
        this.toolbar = new ToolBar({
            components: [this._saveButton, Spacer.flex(), glyphButton("refresh", PRIMARY_COLOR, `Refresh (${REFRESH_SHORTCUT})`, onRefresh)],
        });

        // Enable Save only once the definition is edited; seeding starts it disabled.
        this.editor.onDirtyChange(() => this.syncDirty());
        this.syncDirty();
    }

    /**
     * Reseed the editor text after a successful save, so the panel reflects
     * the object's new state in place and Save re-disables until the user
     * edits again.
     *
     * @param definition - the freshly re-fetched definition text.
     */
    reload(definition: string): void {
        this.editor.setValue(definition);
        this.editor.markClean();
        this.syncDirty();
    }

    /**
     * Enable Save only when {@link CodeEditor.isDirty} is true, and never
     * while a save is in flight (`_saving`). Wired to the editor's
     * `onDirtyChange` and called after the initial seed and each
     * {@link reload}.
     */
    private syncDirty(): void {
        this._saveButton.setEnabled(!this._saving && this.editor.isDirty());
    }
}
