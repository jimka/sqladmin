// A read-only, selectable view of a (materialized) view's SQL definition
// (pg_get_viewdef), shown in its own dock tab opened from the navigator's
// right-click menu — the definition counterpart to StructurePanel. The SQL is
// fetched by the controller (openDefinition) and passed in already-resolved, so
// this panel is a pure view with no data dependency of its own.

import { Container, Panel }    from "@jimka/typescript-ui/core";
import { Fit }      from "@jimka/typescript-ui/layout";
import { TextArea } from "@jimka/typescript-ui/component/input";

/** Build a panel showing a view's SQL definition as read-only, selectable text. */
export function DefinitionPanel(definition: string): Panel {
    const area = new TextArea(definition, { readOnly: true });

    return Container({ layoutManager: new Fit(), components: [area] });
}
