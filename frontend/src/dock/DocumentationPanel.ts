// The editable documentation/notes panel: a WYSIWYG MarkdownEditor filling a
// Fit host, seeded from the persisted per-connection notes and reporting every
// edit back for persistence — the editable counterpart to DefinitionPanel's
// read-only CodeEditor. A class-first composition wrapper: the instance owns
// `content` and `dispose`, which now internalizes the editor teardown — the
// editor itself is no longer exposed to the caller.

import { Container }      from "@jimka/typescript-ui/core";
import { Fit }            from "@jimka/typescript-ui/layout";
import { MarkdownEditor } from "@jimka/typescript-ui/component/editor";

/**
 * The documentation panel: a MarkdownEditor filling a Fit host, seeded with
 * `initial` and reporting edits through `onChange`.
 */
export class DocumentationPanel {
    readonly content: Container;
    readonly dispose: () => void;

    /**
     * @param initial - The Markdown to seed the editor with (the persisted
     *     notes, or `""` when none were saved yet).
     * @param onChange - Called with the current Markdown on every edit.
     */
    constructor(initial: string, onChange: (markdown: string) => void) {
        const editor = new MarkdownEditor(initial);
        editor.on("change", ({ value }) => onChange(value));

        // Focus the editor so the user can type straight away on a freshly opened
        // Notes tab (Tools → Notes…). The panel content is built before the Dock
        // mounts it, so the contenteditable does not exist yet — onFirstLayout runs
        // once the editor has mounted and laid out, when it can take focus.
        editor.onFirstLayout(() => editor.focus());

        this.content = Container({ layoutManager: new Fit(), components: [editor] });
        this.dispose = () => editor.dispose();
    }
}
