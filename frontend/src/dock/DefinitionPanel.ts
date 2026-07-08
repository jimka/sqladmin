// A read-only, selectable view of a (materialized) view's SQL definition
// (pg_get_viewdef), shown in its own dock tab opened from the navigator's
// right-click menu — the definition counterpart to StructurePanel. The SQL is
// fetched by the controller (openDefinition) and passed in already-resolved, so
// this panel is a pure view with no data dependency of its own.

import { Container }  from "@jimka/typescript-ui/core";
import { Fit }        from "@jimka/typescript-ui/layout";
import { CodeEditor } from "@jimka/typescript-ui/component/editor";

/**
 * Build a panel showing a view's SQL definition as read-only, SQL-highlighted,
 * selectable text.
 *
 * @returns The panel content plus a disposer that must be called on teardown
 *     to release the editor's view and theme subscription.
 */
export function DefinitionPanel(definition: string): { content: Container; dispose: () => void } {
    const editor = new CodeEditor(definition, { language: "sql", readOnly: true });
    const content = Container({ layoutManager: new Fit(), components: [editor] });

    return { content, dispose: () => editor.dispose() };
}
