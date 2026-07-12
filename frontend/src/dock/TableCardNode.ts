// The card-mode node renderer for the relation-rooted ER diagram
// (RelationDiagramPanel): a table-name header followed by one fixed-height row
// per column (name, type, PK/FK markers). Every dimension comes from
// schemaCardModel — the shared geometry seam buildSchemaDiagram's card-mode
// branch also reads — so a column row's rendered vertical centre always agrees
// with the ELK port an FK edge was pinned to, without either side measuring the
// other. A node with no card `data` (or no columns — e.g. the injected root
// buildSchemaDiagram never fetches columns for) renders header-only.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends Panel directly, so
// `setSelected` is a real public method rather than a grafted-on cast.
// DiagramView.applySelectedVisual calls it as `component.setSelected?.(value)`
// — a method call on the node object, never a detached reference — so `this`
// is bound correctly and no arrow-function field is needed. `columnRow` stays a
// stateless module-level function.

import { Component, Panel }  from "@jimka/typescript-ui/core";
import { VBox, HBox }        from "@jimka/typescript-ui/layout";
import { Text }              from "@jimka/typescript-ui/component/input";
import { Tooltip }           from "@jimka/typescript-ui/overlay";
import type { DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { CARD_WIDTH, CARD_HEADER_HEIGHT, CARD_ROW_HEIGHT, cardHeight, columnTooltip } from "../data/schemaCardModel";
import type { CardNodeData, ColumnRowData } from "../data/schemaCardModel";

// The root node's emphasis: a 2px accent border over the plain 1px card
// border, so the rooted relation reads as the anchor of the view (mirrors the
// prior plain-node DiagramNode styling this renderer replaces).
const ROOT_BORDER = "2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))";

// The default (non-root) card border, matching DiagramNode's plain node style
// so a card reads as the same kind of "box" as the flat schema diagram's nodes.
const CARD_BORDER = "1px solid var(--ts-ui-border-color, rgb(180, 180, 180))";

// Fixed width, in pixels, reserved for a row's trailing PK/FK marker. Reserved
// on every row (even markerless ones, whose flag is empty) so a marker's
// presence never shifts the type column — the type column's left edge is then
// identical on every row. Wide enough for the two-letter "PK"/"FK" labels.
const FLAG_COL_WIDTH = 22;

// Main-axis weights splitting a row's remaining width (all but the reserved
// flag column) between the name and type cells. Fixed across rows, so both the
// name column and the type column keep a constant width — the types line up
// with each other — while each cell ellipsises its own overflow. Name is given
// the larger share as the more identifying (and typically longer) field.
const NAME_WEIGHT = 2;
const TYPE_WEIGHT = 1;

// The card's default background. Also the deselected background setSelected
// restores. Matches DiagramNode's plain node background so a card reads as the
// same kind of box as the flat schema diagram's nodes.
const CARD_BG = "var(--ts-ui-diagram-node-bg, var(--ts-ui-button-bg, rgb(245, 245, 245)))";

// The selected-card background: the accent-tinted shade DiagramNode uses for
// its own `.selected` state, so single-click selection reads the same in the
// card-mode diagram as it does in the flat one.
const CARD_SELECTED_BG = "var(--ts-ui-diagram-node-selected-bg, var(--ts-ui-table-row-selected, rgba(30, 100, 200, 0.15)))";

/**
 * One table card: a header (the table name) followed by one row per
 * `CardNodeData` column; a node whose `data` is absent or carries no columns
 * renders header-only. Rows take pointer events (for their hover tooltip) but
 * clicks/double-clicks still resolve to the card — DiagramView's nodeIdAt
 * matches any target the card element contains — so its activation/selection
 * wiring keeps working; `setSelected` is the selection highlight DiagramView
 * drives via its duck-typed `component.setSelected?.(value)`.
 */
export class TableCardNode extends Panel {
    /**
     * @param node - The node's data, including its card `data.columns` when present.
     * @param isRoot - Whether this card is the diagram's rooted relation (accent border).
     */
    constructor(node: DiagramNodeData, isRoot: boolean) {
        const columns = (node.data as CardNodeData | undefined)?.columns ?? [];

        const header = new Text(node.label ?? node.id);

        header.setFontWeight("bold");
        header.setPreferredSize(CARD_WIDTH, CARD_HEADER_HEIGHT);
        header.setPointerEvents("none");

        super({
            layoutManager: new VBox({ spacing: 0 }),
            preferredSize: { width: CARD_WIDTH, height: cardHeight(columns.length) },
            components   : [header, ...columns.map(columnRow)],
        });

        this.setBorder(isRoot ? ROOT_BORDER : CARD_BORDER);
        this.setBackgroundColor(CARD_BG);
        this.setCursor("pointer");
    }

    /**
     * Restores the single-click selection highlight DiagramView drives through
     * a duck-typed `setSelected` call: swap the background to the accent shade
     * while selected. The border is left as-is so a root card keeps its accent
     * frame. A real method — DiagramView.applySelectedVisual calls it as
     * `component.setSelected?.(value)`, a method call (never a detached
     * reference), so `this` is bound correctly and no arrow field is needed.
     *
     * @param value - Whether the card is selected.
     */
    setSelected(value: boolean): void {
        this.setBackgroundColor(value ? CARD_SELECTED_BG : CARD_BG);
    }
}

/**
 * Build one fixed-height column row: the column name, its type, and a PK/FK
 * marker (blank for a plain column). Hovering the row shows a tooltip with the
 * column's full name, type, and attributes ({@link columnTooltip}).
 *
 * @param column - The row's data.
 * @returns A `CARD_ROW_HEIGHT`-tall row component.
 */
function columnRow(column: ColumnRowData): Component {
    const name = new Text(column.name);
    const type = new Text(column.type);

    type.setOpacity(0.6);

    const flag = new Text(column.pk ? "PK" : column.fk ? "FK" : "");

    flag.setFontWeight("bold");
    flag.setPreferredSize(FLAG_COL_WIDTH, CARD_ROW_HEIGHT);

    // The three labels are pointer-transparent (individually, not via the row):
    // hover/click then land on the row itself, so its cursor governs (no
    // pointer-cursor flicker over the text, the DiagramNode precedent) and its
    // hover fires the tooltip. Clicks still bubble to the card for DiagramView's
    // selection/activation (nodeIdAt resolves any target the card contains).
    name.setPointerEvents("none");
    type.setPointerEvents("none");
    flag.setPointerEvents("none");

    // Weighted name/type cells over a fixed-width flag column: name and type
    // each keep a constant share of the row on every card, so the type column
    // lines up across rows and each cell ellipsises its own overflow instead of
    // the whole row shrinking the name toward its min width.
    const row = new Component({
        layoutManager: new HBox({ spacing: 6, stretching: true }),
        preferredSize: { width: CARD_WIDTH, height: CARD_ROW_HEIGHT },
        components   : [
            { component: name, constraints: { weight: NAME_WEIGHT } },
            { component: type, constraints: { weight: TYPE_WEIGHT } },
            flag,
        ],
    });

    row.setCursor("pointer");

    Tooltip.attach(row, columnTooltip(column));

    return row;
}
