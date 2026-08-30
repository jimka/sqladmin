// The dock work panel for one index's read-only detail: its owning table
// (a link back to the table's Structure tab), unique/primary flags, and full
// CREATE INDEX text — shown in its own tab opened from the navigator's
// double-click / "Show info" context item on an Indexes-category leaf.
//
// Read-only throughout, unlike SequenceInfoPanel: CREATE/DROP INDEX already
// live on StructurePanel's onCreateIndex/onDropIndex (see the plan's
// Non-Goals), so this tab has no Save toolbar and no dirty tracking — but it
// does carry a Refresh button, the only toolbar action it has. The definition
// renders in a bare CodeEditor — the same read-only construction
// QueryPanel.showPlan uses for the EXPLAIN plan pane ("Read-only (not
// disabled) keeps the plan selectable and copyable while blocking edits").
//
// Needs no disposal of its own: this panel `extends`-es a library base rather
// than composing one, so every child (the toolbar, the LabeledFieldSet's
// Link/Text rows, the CodeEditor) is a registered descendant, and the Dock's
// teardown on tab close reaches each one, same as SequenceInfoPanel.

import { Container, callable }         from "@jimka/typescript-ui/core";
import { Border as BorderLayout }      from "@jimka/typescript-ui/layout";
import { Placement }                   from "@jimka/typescript-ui/primitive";
import { ToolBar }                     from "@jimka/typescript-ui/component/menubar";
import { Link, Text }                  from "@jimka/typescript-ui/component/input";
import { LabeledFieldSet, Spacer }     from "@jimka/typescript-ui/component/container";
import { Glyph }                       from "@jimka/typescript-ui/component/display";
import { CodeEditor }                  from "@jimka/typescript-ui/component/editor";
import { refresh }                     from "@jimka/typescript-ui/glyphs/solid/refresh";
import { glyphButton }                 from "./glyphButton";
import { REFRESH_SHORTCUT }            from "../shell/queryShortcuts";
import { PRIMARY_COLOR }               from "../theme";
import { yesNo }                       from "../textFormat";
import type { IndexDetail }            from "../contract";

Glyph.register(refresh);

/** Dependencies {@link IndexInfoPanel} needs to link back to the owning table. */
export interface IndexInfoPanelDeps {
    schema: string;

    /** Open (or focus) the owning table's Structure tab and reveal it in the navigator. */
    onOpenTable: (schema: string, table: string) => void;

    /** Re-fetch this index's detail and reseed the tab in place. */
    onRefresh: () => void;
}

/** A tab-filling, read-only view of one index's flags and full definition. */
class IndexInfoPanel extends Container {
    private readonly _tableLink:   Link;
    private readonly _uniqueText:  Text;
    private readonly _primaryText: Text;
    private readonly _editor:      CodeEditor;

    // Mutable: replaced with the freshly reloaded detail after a successful
    // Refresh, so the table link's click handler always targets the current
    // owning table.
    private _detail: IndexDetail;

    /**
     * @param detail - the index's name, definition, flags, and owning table,
     *   fetched by the controller before construction.
     * @param deps - the schema (for the fieldset legend) and the "open table" /
     *   "refresh" callbacks.
     */
    constructor(detail: IndexDetail, deps: IndexInfoPanelDeps) {
        // The click handler reads `this._detail` only when invoked, never at
        // construction, so it is safe to build here even though `this` is
        // unavailable until `super()` returns — the same shape
        // SequenceInfoPanel's Save handler uses (see COMPONENT_CONVENTIONS.md
        // (b)).
        const tableLink = new Link(detail.table, {
            listeners: { action: () => deps.onOpenTable(deps.schema, this._detail.table) },
        });
        const uniqueText  = new Text(yesNo(detail.unique));
        const primaryText = new Text(yesNo(detail.primary));

        // The legend is the index's schema-qualified name — see
        // SequenceInfoPanel's identical rationale (must be non-empty, or the
        // fieldset's top border shows a gap where the legend notch would sit).
        const fieldSet = new LabeledFieldSet(`${deps.schema}.${detail.name}`, {
            rows: [
                [{ title: "Table", component: tableLink }],
                [{ title: "Unique", component: uniqueText }],
                [{ title: "Primary", component: primaryText }],
            ],
        });

        // Read-only (not disabled) keeps the definition selectable and
        // copyable while blocking edits — mirrors QueryPanel.showPlan's own
        // CodeEditor construction for the EXPLAIN plan pane.
        const editor = new CodeEditor(detail.definition, { language: "sql", readOnly: true });

        // Flex spacer pushes Refresh to the far right rather than leaving it
        // pinned at the toolbar's left edge — matches the other four tabs'
        // Refresh placement.
        const toolbar = new ToolBar({
            components: [Spacer.flex(), glyphButton("refresh", PRIMARY_COLOR, `Refresh (${REFRESH_SHORTCUT})`, () => deps.onRefresh())],
        });

        // The fieldset and editor sit in a nested Border below the toolbar —
        // the toolbar already claims the root's NORTH placement, so the
        // fieldset/editor pair (previously NORTH/CENTER on the root itself)
        // moves into its own Border inside the root's CENTER, mirroring
        // DefinitionPanel's toolbar-NORTH-of-content shape.
        const content = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
        content.addComponent(fieldSet, { placement: Placement.NORTH });
        content.addComponent(editor, { placement: Placement.CENTER });

        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this._tableLink   = tableLink;
        this._uniqueText  = uniqueText;
        this._primaryText = primaryText;
        this._editor      = editor;
        this._detail      = detail;

        this.addComponent(toolbar, { placement: Placement.NORTH });
        this.addComponent(content, { placement: Placement.CENTER });
    }

    /**
     * Reseed every widget after a successful Refresh — called by the
     * controller instead of rebuilding the tab, so the panel simply reflects
     * the index's new state in place.
     *
     * @param detail - the freshly re-fetched index detail.
     */
    reload(detail: IndexDetail): void {
        this._detail = detail;
        this._tableLink.setText(detail.table);
        this._uniqueText.setText(yesNo(detail.unique));
        this._primaryText.setText(yesNo(detail.primary));
        this._editor.setValue(detail.definition);
    }
}

const IndexInfoPanelCallable = callable(IndexInfoPanel);
type IndexInfoPanelCallable = IndexInfoPanel;
export { IndexInfoPanelCallable as IndexInfoPanel };
