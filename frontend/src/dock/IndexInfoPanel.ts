// The dock work panel for one index's read-only detail: its owning table
// (a link back to the table's Structure tab), unique/primary flags, and full
// CREATE INDEX text — shown in its own tab opened from the navigator's
// double-click / "Show info" context item on an Indexes-category leaf.
//
// Read-only throughout, unlike SequenceInfoPanel: CREATE/DROP INDEX already
// live on StructurePanel's onCreateIndex/onDropIndex (see the plan's
// Non-Goals), so this tab has no Save toolbar and no dirty tracking. The
// definition renders in a bare CodeEditor — the same read-only construction
// QueryPanel.showPlan uses for the EXPLAIN plan pane ("Read-only (not
// disabled) keeps the plan selectable and copyable while blocking edits").
//
// Needs no disposal of its own: this panel `extends`-es a library base rather
// than composing one, so every child (the LabeledFieldSet's Link/Text rows,
// the CodeEditor) is a registered descendant, and the Dock's teardown on tab
// close reaches each one, same as SequenceInfoPanel.

import { Container, callable }         from "@jimka/typescript-ui/core";
import { Border as BorderLayout }      from "@jimka/typescript-ui/layout";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { Link, Text }                  from "@jimka/typescript-ui/component/input";
import { LabeledFieldSet }             from "@jimka/typescript-ui/component/container";
import { CodeEditor }                  from "@jimka/typescript-ui/component/editor";
import type { IndexDetail }            from "../contract";

/** Human-readable Yes/No for a boolean flag row. */
function yesNo(value: boolean): string {
    return value ? "Yes" : "No";
}

/** Dependencies {@link IndexInfoPanel} needs to link back to the owning table. */
export interface IndexInfoPanelDeps {
    schema: string;

    /** Open (or focus) the owning table's Structure tab and reveal it in the navigator. */
    onOpenTable: (schema: string, table: string) => void;
}

/** A tab-filling, read-only view of one index's flags and full definition. */
class IndexInfoPanel extends Container {
    /**
     * @param detail - the index's name, definition, flags, and owning table,
     *   fetched by the controller before construction.
     * @param deps - the schema (for the fieldset legend) and the "open table" callback.
     */
    constructor(detail: IndexDetail, deps: IndexInfoPanelDeps) {
        const tableLink = new Link(detail.table, {
            listeners: { action: () => deps.onOpenTable(deps.schema, detail.table) },
        });

        // The legend is the index's schema-qualified name — see
        // SequenceInfoPanel's identical rationale (must be non-empty, or the
        // fieldset's top border shows a gap where the legend notch would sit).
        const fieldSet = new LabeledFieldSet(`${deps.schema}.${detail.name}`, {
            rows: [
                [{ title: "Table", component: tableLink }],
                [{ title: "Unique", component: new Text(yesNo(detail.unique)) }],
                [{ title: "Primary", component: new Text(yesNo(detail.primary)) }],
            ],
        });

        // Read-only (not disabled) keeps the definition selectable and
        // copyable while blocking edits — mirrors QueryPanel.showPlan's own
        // CodeEditor construction for the EXPLAIN plan pane.
        const editor = new CodeEditor(detail.definition, { language: "sql", readOnly: true });

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this.addComponent(fieldSet, { placement: Placement.NORTH });
        this.addComponent(editor, { placement: Placement.CENTER });
    }
}

const IndexInfoPanelCallable = callable(IndexInfoPanel);
type IndexInfoPanelCallable = IndexInfoPanel;
export { IndexInfoPanelCallable as IndexInfoPanel };
