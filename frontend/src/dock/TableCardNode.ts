// The card-mode node renderer for the relation-rooted ER diagram
// (RelationDiagramPanel): a table-name header followed by one fixed-height row
// per column (name, type, PK/FK markers). Every dimension comes from
// schemaCardModel — the shared geometry seam buildSchemaDiagram's card-mode
// branch also reads — so a column row's rendered vertical centre always agrees
// with the ELK port an FK edge was pinned to, without either side measuring the
// other. A node with no card `data` (or no columns — e.g. the injected root
// buildSchemaDiagram never fetches columns for) renders header-only.

import { Component, Panel }  from "@jimka/typescript-ui/core";
import { VBox, HBox }        from "@jimka/typescript-ui/layout";
import { Text }              from "@jimka/typescript-ui/component/input";
import type { DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { CARD_WIDTH, CARD_HEADER_HEIGHT, CARD_ROW_HEIGHT, cardHeight } from "../data/schemaCardModel";
import type { CardNodeData, ColumnRowData } from "../data/schemaCardModel";

// The root node's emphasis: a 2px accent border over the plain 1px card
// border, so the rooted relation reads as the anchor of the view (mirrors the
// prior plain-node DiagramNode styling this renderer replaces).
const ROOT_BORDER = "2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))";

// The default (non-root) card border, matching DiagramNode's plain node style
// so a card reads as the same kind of "box" as the flat schema diagram's nodes.
const CARD_BORDER = "1px solid var(--ts-ui-border-color, rgb(180, 180, 180))";

/**
 * Build one table card. Renders a header (the table name) followed by one row
 * per `CardNodeData` column; a node whose `data` is absent or carries no
 * columns renders header-only. Every content child is pointer-transparent so
 * clicks/double-clicks fall through to the card itself (the DiagramNode
 * precedent), which is what DiagramView's activation/selection wiring needs.
 *
 * @param node - The node's data, including its card `data.columns` when present.
 * @param isRoot - Whether this card is the diagram's rooted relation (accent border).
 * @returns The card Component, hosted directly by DiagramView.
 */
export function TableCardNode(node: DiagramNodeData, isRoot: boolean): Component {
    const columns = (node.data as CardNodeData | undefined)?.columns ?? [];

    const header = new Text(node.label ?? node.id);

    header.setFontWeight("bold");
    header.setPreferredSize(CARD_WIDTH, CARD_HEADER_HEIGHT);
    header.setPointerEvents("none");

    const card = Panel({
        layoutManager: new VBox({ spacing: 0 }),
        preferredSize: { width: CARD_WIDTH, height: cardHeight(columns.length) },
        components   : [header, ...columns.map(columnRow)],
    });

    card.setBorder(isRoot ? ROOT_BORDER : CARD_BORDER);
    card.setBackgroundColor("var(--ts-ui-diagram-node-bg, var(--ts-ui-button-bg, rgb(245, 245, 245)))");
    card.setCursor("pointer");

    return card;
}

/**
 * Build one fixed-height column row: the column name, its type, and a PK/FK
 * marker (blank for a plain column).
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

    const row = new Component({
        layoutManager: new HBox({ spacing: 6, stretching: true }),
        preferredSize: { width: CARD_WIDTH, height: CARD_ROW_HEIGHT },
        components   : [name, type, flag],
    });

    // pointer-events: none inherits, so this one call also covers the three
    // Text children nested inside the row (the DiagramNode precedent).
    row.setPointerEvents("none");

    return row;
}
