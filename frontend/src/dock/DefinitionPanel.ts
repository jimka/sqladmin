// A read-only, selectable view of a (materialized) view's SQL definition
// (pg_get_viewdef), shown in its own dock tab opened from the navigator's
// right-click menu — the definition counterpart to StructurePanel. The SQL is
// fetched by the controller (openDefinition) and passed in already-resolved, so
// this panel is a pure view with no data dependency of its own.

import { Container }  from "@jimka/typescript-ui/core";
import { Fit }        from "@jimka/typescript-ui/layout";
import { CodeEditor } from "@jimka/typescript-ui/component/editor";

/**
 * A panel showing a view's SQL definition as read-only, SQL-highlighted,
 * selectable text. A class-first composition wrapper: the instance owns
 * `content` (the mountable subtree) and `dispose` (releasing the editor's
 * view and theme subscription) rather than `extends`-ing a library base.
 */
export class DefinitionPanel {
    readonly content: Container;
    readonly dispose: () => void;

    constructor(definition: string) {
        const editor = new CodeEditor(definition, { language: "sql", readOnly: true });

        this.content = Container({ layoutManager: new Fit(), components: [editor] });
        this.dispose = () => editor.dispose();
    }
}
