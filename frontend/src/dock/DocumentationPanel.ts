// The editable documentation/notes panel: a WYSIWYG MarkdownEditor filling a
// Fit host, seeded from the persisted per-connection notes and reporting every
// edit back for persistence — the editable counterpart to DefinitionPanel's
// read-only CodeEditor. Unlike DefinitionPanel, the editor's dispose() is not
// tied to a returned closure here; the caller (SqlAdminController) keeps the
// editor reference itself so it can dispose it explicitly on tab close.

import { Container }      from "@jimka/typescript-ui/core";
import { Fit }            from "@jimka/typescript-ui/layout";
import { MarkdownEditor } from "@jimka/typescript-ui/component/editor";

/**
 * Build the documentation panel: a MarkdownEditor filling a Fit host, seeded
 * with `initial` and reporting edits through `onChange`.
 *
 * @param initial - The Markdown to seed the editor with (the persisted notes,
 *     or `""` when none were saved yet).
 * @param onChange - Called with the current Markdown on every edit.
 *
 * @returns The mount container plus the editor so the caller can `dispose()`
 *     it on teardown.
 */
export function DocumentationPanel(
    initial: string,
    onChange: (markdown: string) => void,
): { component: Container; editor: MarkdownEditor } {
    const editor = new MarkdownEditor(initial);
    editor.on("change", ({ value }) => onChange(value));

    const component = Container({ layoutManager: new Fit(), components: [editor] });

    return { component, editor };
}
