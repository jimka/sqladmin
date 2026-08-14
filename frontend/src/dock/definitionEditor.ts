// The shared, dirty-gated "editable SQL definition + Save/Refresh toolbar"
// core behind both DefinitionPanel (a view/matview's editable SELECT body
// over its columns grid) and FunctionDefinitionPanel (a routine's editable
// CREATE OR REPLACE statement). It owns the CodeEditor, the NORTH toolbar's
// Save and Refresh buttons, and the dirty-gating that keeps Save disabled
// until the text actually differs from the last-saved baseline — the part
// that is fiddly to get right (a mid-save edit must not re-enable Save; a
// successful reload — from either a Save or a Refresh — must re-disable it).
// Each panel supplies its own body layout around `editor` and its own
// `onSave`/`onRefresh`; this class carries no view/function specifics.

import { ToolBar }    from "@jimka/typescript-ui/component/menubar";
import { Button }     from "@jimka/typescript-ui/component/button";
import { CodeEditor } from "@jimka/typescript-ui/component/editor";
import { Glyph }      from "@jimka/typescript-ui/component/display";
import { save }       from "@jimka/typescript-ui/glyphs/solid/save";
import { refresh }    from "@jimka/typescript-ui/glyphs/solid/refresh";
import { glyphButton } from "./glyphButton";
import { PRIMARY_COLOR } from "../theme";

Glyph.register(save, refresh);

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

    /** The last-saved text; Save enables only when the editor differs from it. */
    private _baseline: string;

    /** True while an onSave is in flight, suppressing `syncDirty` so a mid-save edit can't re-enable Save. */
    private _saving = false;

    /**
     * @param definition - the initial definition text (the editor's seed and
     *   the starting Save baseline — Save begins disabled).
     * @param onSave - writes the editor's current text back to the database;
     *   Save is disabled for its duration and re-evaluated once it settles.
     * @param onRefresh - re-fetches the definition and reseeds the editor,
     *   discarding any unsaved edit with no confirmation prompt.
     */
    constructor(
        definition: string,
        onSave: (text: string) => void | Promise<void>,
        onRefresh: () => void,
    ) {
        this.editor = new CodeEditor(definition, { language: "sql" });
        this._baseline = definition;

        // Save is disabled for the duration of `onSave` and `_saving`
        // suppresses `syncDirty`, so neither a double-click nor a mid-save edit
        // can fire a second overlapping save. After the save settles,
        // `syncDirty` restores the right state: a successful save reloads the
        // panel (baseline updated → not dirty → disabled); a failed one leaves
        // the edits (still dirty → enabled).
        const handleSave = (): void => {
            this._saving = true;
            this._saveButton.setEnabled(false);

            void Promise.resolve(onSave(this.editor.getValue())).finally(() => {
                this._saving = false;
                this.syncDirty();
            });
        };

        this._saveButton = glyphButton("save", PRIMARY_COLOR, "Save", handleSave);
        this.toolbar = new ToolBar({
            components: [this._saveButton, glyphButton("refresh", PRIMARY_COLOR, "Refresh (Alt+R)", onRefresh)],
        });

        // Enable Save only once the definition is edited; seeding starts it disabled.
        this.editor.on("change", () => this.syncDirty());
        this.syncDirty();
    }

    /**
     * Reseed the editor text and Save baseline after a successful save, so the
     * panel reflects the object's new state in place and Save re-disables until
     * the user edits again.
     *
     * @param definition - the freshly re-fetched definition text.
     */
    reload(definition: string): void {
        this._baseline = definition;
        this.editor.setValue(definition);
        this.syncDirty();
    }

    /**
     * Enable Save only when the editor's text differs from the last-saved
     * baseline, and never while a save is in flight (`_saving`). Wired to the
     * editor's "change" event and called after the initial seed and each
     * {@link reload}.
     */
    private syncDirty(): void {
        if (this._saving) {
            return;
        }

        this._saveButton.setEnabled(this.editor.getValue() !== this._baseline);
    }
}
