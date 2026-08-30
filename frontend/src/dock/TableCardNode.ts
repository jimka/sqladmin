// The card-mode node renderer for the relation-rooted ER diagram
// (RelationDiagramPanel): a table-name header followed by one fixed-height row
// per column (name, type, PK/FK markers). Every dimension comes from
// schemaCardModel — the shared geometry seam buildSchemaDiagram's card-mode
// branch also reads — so a column row's rendered vertical centre always agrees
// with the ELK port an FK edge was pinned to, without either side measuring the
// other. The card's frame is painted as an outline (not a border) and its
// insets are zeroed on the vertical axis — see theme.ts's CARD_FRAME/ROOT_FRAME
// below — because either one would eat into the card's inner height and shrink every
// row below schemaCardModel's CARD_ROW_HEIGHT, walking the ports off the row
// centres they were pinned to (see schemaCardModel's header comment for the
// renderer contract this follows). A node with no card `data` (or no columns —
// e.g. the injected root buildSchemaDiagram never fetches columns for) renders
// header-only.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends Panel directly, so
// `setSelected` is a real public method rather than a grafted-on cast.
// DiagramView.applySelectedVisual calls it as `component.setSelected?.(value)`
// — a method call on the node object, never a detached reference — so `this`
// is bound correctly and no arrow-function field is needed. `columnRow` stays a
// stateless module-level function.

import { Component, Panel, callable, Event } from "@jimka/typescript-ui/core";
import { VBox, HBox }        from "@jimka/typescript-ui/layout";
import { Insets }            from "@jimka/typescript-ui/primitive";
import { Text }              from "@jimka/typescript-ui/component/input";
import { Tooltip }           from "@jimka/typescript-ui/overlay";
import type { DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { CARD_WIDTH, CARD_HEADER_HEIGHT, CARD_ROW_HEIGHT, cardHeight, cardTooltip, tableTooltip } from "../data/schemaCardModel";
import type { CardNodeData, ColumnRowData } from "../data/schemaCardModel";
import { CARD_FRAME, ROOT_FRAME } from "../theme";

// The card's frame, painted as an `outline` rather than a `border`: an outline
// takes no layout space, so the card's inner height stays exactly
// cardHeight(columns.length) and every row renders at its full CARD_ROW_HEIGHT
// — which is what makes a row's centre coincide with the FK port
// schemaCardModel pinned to it. A border would eat 1px (2px on the root card)
// off the inner height and shrink every row instead. Same widths and colours as
// the borders they replace: the root node's 2px accent frame over the plain
// 1px card frame, so the rooted relation still reads as the anchor of the view.

// Horizontal breathing room between the card's frame and its row text — the
// Panel default, restated because the card must pass explicit insets to get
// ZERO vertical ones (see schemaCardModel's header comment).
const CARD_INSET_X = 4;

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

// The badge's opacity: present but secondary to the label it trails. Matches
// the "dim the supporting value" weight the framework already uses for a
// receded label, so the badge reads as an annotation rather than a second
// name (mirrors the library DiagramNode's own badge opacity).
const BADGE_OPACITY = 0.6;

// The card's default background. Also the deselected background setSelected
// restores. Matches DiagramNode's plain node background so a card reads as the
// same kind of box as the flat schema diagram's nodes.
const CARD_BG = "var(--ts-ui-diagram-node-bg, var(--ts-ui-button-bg, rgb(245, 245, 245)))";

// The selected-card background: the accent-tinted shade DiagramNode uses for
// its own `.selected` state, so single-click selection reads the same in the
// card-mode diagram as it does in the flat one. Doubles as the column-row
// emphasis tint (setEmphasisedColumns) — a row's own tint stacks visually over
// a selected card's tint since the two are on different elements (row vs. card).
const CARD_SELECTED_BG = "var(--ts-ui-diagram-node-selected-bg, var(--ts-ui-table-row-selected, rgba(30, 100, 200, 0.15)))";

/**
 * One table card: a header (the table name) followed by one row per
 * `CardNodeData` column; a node whose `data` is absent or carries no columns
 * renders header-only. Rows take pointer events (for their hover tooltip,
 * {@link cardTooltip}: the table block, a blank line, then the column block)
 * but clicks/double-clicks still resolve to the card — DiagramView's
 * nodeIdAt matches any target the card element contains — so its
 * activation/selection wiring keeps working; `setSelected` is the selection
 * highlight DiagramView drives via its duck-typed
 * `component.setSelected?.(value)`. The card itself is also tooltip-attached
 * (the table block alone) — hovering the header strip, the side margins, or a
 * header-only card shows it, since it wins only where no row's own tooltip
 * intercepts the hover first.
 */
class TableCardNode extends Panel {
    // Column rows keyed by name, for setEmphasisedColumns. Built as a local
    // before super() (the rows are super()'s children) and assigned after
    // (COMPONENT_CONVENTIONS.md (b)).
    private readonly rows: Map<string, Component>;

    /**
     * @param node - The node's data, including its card `data.columns` when present.
     * @param isRoot - Whether this card is the diagram's rooted relation (accent outline).
     * @param onSelectColumn - Invoked with a clicked row's column name; omitted
     *   for diagrams with no column-emphasis wiring (e.g. none today outside
     *   RelationDiagramPanel).
     */
    constructor(node: DiagramNodeData, isRoot: boolean, onSelectColumn?: (column: string) => void) {
        const columns = (node.data as CardNodeData | undefined)?.columns ?? [];

        // The header is a row so a depth badge can trail the table name; the
        // name cell takes the weight and ellipsises, and the row stays pinned
        // to CARD_WIDTH, because the card's width is the shared geometry
        // schemaCardModel pins the FK ports to and must not change. The 6px
        // gap is columnRow's row spacing, so the header's cells line up with
        // the rows below.
        const name = new Text(node.label ?? node.id);

        name.setFontWeight("bold");
        name.setPointerEvents("none");

        const badge = node.badge !== undefined ? new Text(node.badge) : null;

        badge?.setOpacity(BADGE_OPACITY);
        badge?.setPointerEvents("none");

        const header = new Component({
            layoutManager: new HBox({ spacing: 6, itemAlign: "stretch" }),
            preferredSize: { width: CARD_WIDTH, height: CARD_HEADER_HEIGHT },
            components   : badge ? [{ component: name, constraints: { weight: 1 } }, badge] : [name],
        });

        // The wrapper itself must also opt out of pointer events — every
        // Component stamps its own `cursor: default`, and `name`/`badge` being
        // transparent does not stop the row `Component` they sit inside from
        // capturing hover/click first. Without this the header strip shows the
        // default arrow instead of the card's pointer cursor (setCursor below).
        header.setPointerEvents("none");

        const tableBlock = tableTooltip(node.label ?? node.id, columns);

        const rows = new Map<string, Component>();
        const rowComponents = columns.map((column) => {
            const row = columnRow(column, tableBlock, onSelectColumn);

            rows.set(column.name, row);

            return row;
        });

        super({
            layoutManager: new VBox({ spacing: 0 }),
            preferredSize: { width: CARD_WIDTH, height: cardHeight(columns.length) },
            insets       : new Insets(0, CARD_INSET_X, 0, CARD_INSET_X),
            components   : [header, ...rowComponents],
        });

        this.rows = rows;

        this.setOutline(isRoot ? ROOT_FRAME : CARD_FRAME);
        this.setBackgroundColor(CARD_BG);
        this.setCursor("pointer");
        Tooltip.attach(this, tableBlock);
    }

    /**
     * Restores the single-click selection highlight DiagramView drives through
     * a duck-typed `setSelected` call: swap the background to the accent shade
     * while selected. The outline is left as-is so a root card keeps its accent
     * frame. A real method — DiagramView.applySelectedVisual calls it as
     * `component.setSelected?.(value)`, a method call (never a detached
     * reference), so `this` is bound correctly and no arrow field is needed.
     *
     * @param value - Whether the card is selected.
     */
    setSelected(value: boolean): void {
        this.setBackgroundColor(value ? CARD_SELECTED_BG : CARD_BG);
    }

    /**
     * Tint the named column rows and clear every other row's tint.
     *
     * @param columns - The column names to highlight; empty clears all.
     */
    setEmphasisedColumns(columns: readonly string[]): void {
        const emphasised = new Set(columns);

        for (const [name, row] of this.rows) {
            row.setBackgroundColor(emphasised.has(name) ? CARD_SELECTED_BG : "transparent");
        }
    }
}

/**
 * Build one fixed-height column row: the column name, its type, and a PK/FK
 * marker (blank for a plain column). Hovering the row shows a tooltip with the
 * table block, a blank line, then the column's full name, type, and
 * attributes ({@link cardTooltip}). A click reports the column name to
 * `onSelectColumn`, when given, and still bubbles to the card (no
 * `stopPropagation`) so DiagramView selects the table as it does today.
 *
 * @param column - The row's data.
 * @param tableBlock - The card's {@link tableTooltip} result, computed once
 *   per card and shared by every row.
 * @param onSelectColumn - Invoked with the column's name on click.
 * @returns A `CARD_ROW_HEIGHT`-tall row component.
 */
function columnRow(column: ColumnRowData, tableBlock: string, onSelectColumn?: (column: string) => void): Component {
    const name = new Text(column.name);
    const type = new Text(column.type);

    type.setOpacity(0.6);

    const flag = new Text(column.pk ? "PK" : column.fk ? "FK" : "");

    flag.setFontWeight("bold");
    flag.setPreferredSize({ width: FLAG_COL_WIDTH, height: CARD_ROW_HEIGHT });

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
        layoutManager: new HBox({ spacing: 6, itemAlign: "stretch" }),
        preferredSize: { width: CARD_WIDTH, height: CARD_ROW_HEIGHT },
        components   : [
            { component: name, constraints: { weight: NAME_WEIGHT } },
            { component: type, constraints: { weight: TYPE_WEIGHT } },
            flag,
        ],
    });

    row.setCursor("pointer");

    Tooltip.attach(row, cardTooltip(tableBlock, column));

    // Internal wiring on a privately-owned child this function just built —
    // the app-side counterpart of the library's cell-editor carve-out (see
    // ARCHITECTURE.md); there is no semantic on("action") surface on a plain
    // Component to route through instead. Exact-target is correct because the
    // row's three labels are pointer-transparent, so a click's target is
    // always the row element itself.
    Event.addListener(row, "click", () => onSelectColumn?.(column.name));

    return row;
}

const TableCardNodeCallable = callable(TableCardNode);
type TableCardNodeCallable = TableCardNode;
export { TableCardNodeCallable as TableCardNode };
