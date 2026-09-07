// The editable documentation/notes panel: a WYSIWYG MarkdownEditor with a
// formatting toolbar, seeded from the persisted per-connection notes and
// reporting every edit back for persistence — the app's only Markdown
// editor. DefinitionPanel's SQL editor is editable too (a DefinitionEditor
// with a dirty-gated Save button, not a read-only view); the genuinely
// read-only editors are IndexInfoPanel's index definition (IndexInfoPanel.ts)
// and QueryPanel's Explain plan viewer (QueryPanel.ts's showPlan). The panel
// extends the library's MarkdownDocumentPanel, which owns the toolbar and the
// editor and lays them out itself, so the Dock's teardown on tab close
// reaches both with no disposal of this class's own.

import { callable }             from "@jimka/typescript-ui/core";
import { MarkdownDocumentPanel } from "@jimka/typescript-ui/component/editor";

/**
 * The documentation panel: the library's MarkdownDocumentPanel (a toolbar
 * over a MarkdownEditor), seeded with `initial` and reporting edits through
 * `onChange`.
 */
class DocumentationPanel extends MarkdownDocumentPanel {
    /**
     * @param initial - The Markdown to seed the editor with (the persisted
     *     notes, or `""` when none were saved yet).
     * @param onChange - Called with the current Markdown on every edit.
     */
    constructor(initial: string, onChange: (markdown: string) => void) {
        super({ value: initial });

        // markClean() right after onChange (NotesStore.save persists
        // synchronously, no network round trip) keeps isDirty() reporting the
        // truth for the app-wide unsaved-changes guards (SqlAdminController's
        // beforetabclose veto, SqlAdminShell's beforeunload guard): text that
        // is already durably saved must never read as unsaved.
        this.on("change", ({ value }) => {
            onChange(value);
            this.markClean();
        });

        const editor = this.getEditor();

        // Focus the editor so the user can type straight away on a freshly opened
        // Notes tab (Tools → Notes…). The panel content is built before the Dock
        // mounts it, so the contenteditable does not exist yet — onFirstLayout runs
        // once the editor has mounted and laid out, when it can take focus.
        editor.onFirstLayout(() => editor.focus());
    }
}

// Callable-class export: consumers may write `DocumentationPanel(initial, onChange)`, no `new`.
const DocumentationPanelCallable = callable(DocumentationPanel);
type DocumentationPanelCallable = DocumentationPanel;
export { DocumentationPanelCallable as DocumentationPanel };
