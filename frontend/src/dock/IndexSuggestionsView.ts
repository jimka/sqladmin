// The heuristic index advisor's suggestions strip: a "Create index…" toolbar
// over a table of ranked CREATE INDEX suggestions, mounted as ExplainDiagramPanel's
// SOUTH region only when there is at least one suggestion. Selecting a row and
// clicking "Create index…" hands the suggestion up to the caller (wired to
// SqlAdminController.createSuggestedIndex), which opens the same DDL preview
// dialog every other index the app creates goes through — this view never
// executes anything itself, `Index`'s cell text is a preview only.
//
// Class-first (see ../COMPONENT_CONVENTIONS.md): a Border-layout Panel, built
// the same way ExplainDiagramPanel is — the toolbar and table are locals
// before super() (they are super()'s children), the table's "selection"
// listener is wired after.

import { Panel, callable }        from "@jimka/typescript-ui/core";
import { Border }                 from "@jimka/typescript-ui/layout";
import { Placement }              from "@jimka/typescript-ui/primitive";
import { ToolBar }                from "@jimka/typescript-ui/component/menubar";
import { Table }                  from "@jimka/typescript-ui/component/table";
import type { ColumnSpec }        from "@jimka/typescript-ui/component/table";
import { Model, MemoryStore }     from "@jimka/typescript-ui/data";
import type { FieldType }         from "@jimka/typescript-ui/data";
import { Glyph }                  from "@jimka/typescript-ui/component/display";
import { plus }                   from "@jimka/typescript-ui/glyphs/solid/plus";
import { glyphButton }            from "./glyphButton";
import { buildIndexSuggestionRows } from "../data/suggestIndexes";
import type { IndexSuggestion }     from "../data/suggestIndexes";
import { CONSTRUCTIVE_COLOR }       from "../theme";

Glyph.register(plus);

// Fixed height (px) of the whole strip — the toolbar plus the table — pinned
// the way the Plan-steps table is (ExplainDiagramPanel's
// PLAN_STEPS_MIN_HEIGHT). Sized only on the outer strip: the table sits in
// the BorderLayout's CENTER, so it fills whatever height the toolbar above it
// leaves, and scrolls internally for more rows than that shows.
const SUGGESTIONS_HEIGHT = 140;

// The suggestions model: one field per IndexSuggestionRow key. Metric fields are
// numeric so a header click sorts by magnitude; the field *names* are the column
// headers the table renders (a row object doubles as the store record).
const SUGGESTION_FIELDS: { name: string; type: FieldType }[] = [
    // Carried on the record for the toolbar's selection -> suggestion lookup;
    // never a column (SUGGESTION_COLUMNS omits it via appendUnlisted: false).
    { name: "id",            type: "string" },
    { name: "Index",         type: "string" },
    { name: "Why",           type: "string" },
    { name: "Rows scanned",  type: "number" },
    { name: "Cost",          type: "number" },
];

const SUGGESTION_COLUMNS: ColumnSpec = {
    appendUnlisted: false,
    columns: [
        { field: "Index" },
        { field: "Why" },
        { field: "Rows scanned" },
        { field: "Cost" },
    ],
};

/** The suggestions strip: a "Create index…" toolbar over a table of suggestions. */
class IndexSuggestionsView extends Panel {
    /**
     * @param suggestions - The ranked suggestions to show, in order.
     * @param onCreateIndex - Called with the selected suggestion when
     *   "Create index…" is clicked.
     */
    constructor(suggestions: IndexSuggestion[], onCreateIndex: (suggestion: IndexSuggestion) => void) {
        const byId  = new Map(suggestions.map(s => [s.id, s]));
        const model = new Model({ fields: SUGGESTION_FIELDS.map((field, order) => ({ ...field, order })) });
        const store = new MemoryStore({ model, data: buildIndexSuggestionRows(suggestions), autoLoad: true });
        const table = Table(store, SUGGESTION_COLUMNS);

        const createButton = glyphButton("plus", CONSTRUCTIVE_COLOR, "Create index…", () => {
            const [record] = table.getSelectedRecords();
            const id       = record?.get("id");
            const suggestion = typeof id === "string" ? byId.get(id) : undefined;

            if (suggestion) {
                onCreateIndex(suggestion);
            }
        });

        createButton.setEnabled(false);

        const toolbar = new ToolBar({ components: [createButton] });

        super({
            layoutManager: new Border(),
            components   : [
                { component: toolbar, constraints: { placement: Placement.NORTH } },
                { component: table,   constraints: { placement: Placement.CENTER } },
            ],
        });

        this.setMinSize({ width: 0, height: SUGGESTIONS_HEIGHT });
        this.setPreferredSize({ width: 0, height: SUGGESTIONS_HEIGHT });

        table.on("selection", (records) => {
            createButton.setEnabled(records.length > 0);
        });
    }
}

const IndexSuggestionsViewCallable = callable(IndexSuggestionsView);
type IndexSuggestionsViewCallable = IndexSuggestionsView;
export { IndexSuggestionsViewCallable as IndexSuggestionsView };
