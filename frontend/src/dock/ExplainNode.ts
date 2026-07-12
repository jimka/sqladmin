// The custom DiagramView node renderer for the EXPLAIN plan diagram: a card with
// a bold header over a metric grid — costs, row width, actual timings (when
// analyzed), group key, hash batches, and peak memory, the last three as small
// visuals (a batches badge, a memory bar, group-key chips). Row *counts* aren't
// on the card — they label the edges, where they read as data flowing between
// nodes (see buildExplainDiagram). The whole card is
// tinted by its `heat` (self-cost / self-time share of the plan) so hot spots
// stand out. The metric rows live in a Grid whose first column is `"content"`-
// sized, so the label column auto-widens to its longest label (e.g. "actual
// rows") instead of truncating, and every value lines up in one column.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends Panel directly, so
// `setSelected` is a real public method DiagramView.applySelectedVisual calls as
// `component.setSelected?.(value)` (a method call, never a detached reference —
// no arrow field needed). Selection is shown with an accent border rather than a
// background swap, because the background carries the heat tint. The cell-building
// helpers are stateless module-level functions.

import { Component, Panel }                  from "@jimka/typescript-ui/core";
import { VBox, HBox, Grid, FillType, AnchorType } from "@jimka/typescript-ui/layout";
import { Insets }                            from "@jimka/typescript-ui/primitive";
import { Text }                              from "@jimka/typescript-ui/component/input";
import type { DiagramNodeData }              from "@jimka/typescript-ui/component/diagram";
import type { ExplainNodeData }              from "../data/buildExplainDiagram";
import type { ExplainPlanNode }              from "../data/parseExplainPlan";
import { formatMetric, formatRange }         from "../data/explainFormat";

// Fixed card width: wide enough for a node-type heading and a "label   value"
// row without wrapping, narrow enough to keep a deep plan's columns readable. The
// card width is fixed (not content-sized) so cards stay uniform and ELK gets a
// deterministic node size; only the internal label column auto-sizes.
const CARD_WIDTH = 240;

// Fixed heights (px) for the header and each metric row, so the card's total
// height is a simple function of how many rows the node has — the preferred size
// ELK lays the node out at. Header is taller for the bold heading.
const HEADER_HEIGHT = 24;
const ROW_HEIGHT    = 18;

// Vertical padding (px) above the header and below the last row, so rows aren't
// flush against the border.
const CARD_PAD = 4;

// Horizontal inset (px) of the header text and the metric grid from the card
// edge, so content isn't flush against the border.
const CARD_INSET = 6;

// Fixed width (px) of the gap column between the auto-sized label column and the
// value column, so labels and values never touch.
const LABEL_GAP = 8;

// The card's border colours: a plain 1px frame deselected, a 2px accent frame
// selected (DiagramView drives the swap through setSelected).
const CARD_BORDER     = "1px solid var(--ts-ui-border-color, rgb(180, 180, 180))";
const SELECTED_BORDER = "2px solid var(--ts-ui-accent-color, rgb(30, 100, 200))";

// Heat tint endpoints: a node with heat 0 sits at the neutral base; heat 1 sits
// at the warm "hot spot" colour. The card background is a linear blend between
// them, scaled by MAX_TINT so even the hottest node stays light enough to read.
const BASE_RGB: readonly [number, number, number] = [245, 245, 245];
const HOT_RGB:  readonly [number, number, number] = [231, 111,  81];
const MAX_TINT = 0.75;

// The memory bar's track width (px) and its fill/track colours. The fill width is
// the track width times the node's plan-relative memory share.
const MEM_BAR_WIDTH = 56;
const MEM_BAR_HEIGHT = 8;
const MEM_TRACK_BG  = "var(--ts-ui-border-color, rgb(210, 210, 210))";
const MEM_FILL_BG   = "var(--ts-ui-accent-color, rgb(30, 100, 200))";

// A hash node that spilled into more than one batch (didn't fit in work_mem) is
// worth flagging, so its batches badge is tinted amber rather than neutral.
const BATCH_OK_BG    = "var(--ts-ui-input-bg, rgb(255, 255, 255))";
const BATCH_SPILL_BG = "rgba(240, 180, 60, 0.35)";

// The dim colour weight for a row's leading label, so the value reads as primary.
const LABEL_OPACITY = 0.6;

// A small font size (px) for the chip / badge / memory sub-labels, set apart from
// the row's primary text.
const SMALL_FONT = 11;

/** One metric row of the card: a dim leading label and its value cell. */
interface CardRow {
    label: string;
    value: Component;
}

/**
 * One plan-node card in the EXPLAIN diagram. Renders a heat-tinted header over a
 * metric grid; `setSelected` swaps the border to the accent frame. A node whose
 * `data` is absent renders header-only.
 */
export class ExplainNode extends Panel {
    /**
     * @param node - The diagram node data; its `data` is the {@link ExplainNodeData}.
     */
    constructor(node: DiagramNodeData) {
        const info = node.data as ExplainNodeData | undefined;
        const plan = info?.plan;

        const header = new Text(node.label ?? node.id);

        header.setFontWeight("bold");
        header.setPreferredSize(CARD_WIDTH, HEADER_HEIGHT);
        header.setPadding(new Insets(0, CARD_INSET, 0, CARD_INSET));
        header.setPointerEvents("none");

        const rows = plan ? detailRows(plan, info?.memShare ?? 0) : [];

        super({
            layoutManager: new VBox({ spacing: 0 }),
            preferredSize: { width: CARD_WIDTH, height: HEADER_HEIGHT + rows.length * ROW_HEIGHT + 2 * CARD_PAD },
            padding      : new Insets(CARD_PAD, 0, CARD_PAD, 0),
            components   : rows.length > 0 ? [header, metricGrid(rows)] : [header],
        });

        this.setBorder(CARD_BORDER);
        this.setBackgroundColor(heatTint(info?.heat ?? 0));
        this.setCursor("pointer");
        // Clip a long group-key chip run at the card edge rather than letting it
        // spill outside the node box.
        this.setOverflow("hidden");
    }

    /**
     * Restores the single-click selection highlight DiagramView drives through a
     * duck-typed `setSelected` call: swap to the accent border while selected. The
     * background is left as-is so the node's heat tint stays visible. A real method
     * (DiagramView.applySelectedVisual calls it as `component.setSelected?.(value)`),
     * so `this` is bound and no arrow field is needed.
     *
     * @param value - Whether the node is selected.
     */
    setSelected(value: boolean): void {
        this.setBorder(value ? SELECTED_BORDER : CARD_BORDER);
    }
}

/**
 * Build the card's metric rows, in fixed order, each present only when its source
 * fields are: cost, row width, actual time (analyze), group key, hash batches,
 * and peak memory. Row counts are not here — they label the edges instead.
 *
 * @param plan - The plan node.
 * @param memShare - The node's plan-relative memory share (0..1) for the bar.
 *
 * @returns The rows (label + value cell) to lay out under the header.
 */
function detailRows(plan: ExplainPlanNode, memShare: number): CardRow[] {
    const rows: CardRow[] = [];

    if (plan.startupCost !== undefined || plan.totalCost !== undefined) {
        rows.push({ label: "cost", value: valueText(formatRange(plan.startupCost, plan.totalCost)) });
    }

    if (plan.planWidth !== undefined) {
        rows.push({ label: "width", value: valueText(`${formatMetric(plan.planWidth)} B`) });
    }

    if (plan.actualTotalTime !== undefined || plan.actualStartupTime !== undefined) {
        const loops = plan.actualLoops !== undefined ? `  ×${formatMetric(plan.actualLoops)}` : "";

        rows.push({ label: "time", value: valueText(`${formatRange(plan.actualStartupTime, plan.actualTotalTime)} ms${loops}`) });
    }

    if (plan.groupKey && plan.groupKey.length > 0) {
        rows.push({ label: "group", value: chipsCell(plan.groupKey) });
    }

    if (plan.hashBatches !== undefined) {
        rows.push({ label: "batches", value: badge(formatMetric(plan.hashBatches), plan.hashBatches > 1 ? BATCH_SPILL_BG : BATCH_OK_BG) });
    }

    if (plan.peakMemoryUsage !== undefined) {
        rows.push({ label: "memory", value: memoryCell(plan.peakMemoryUsage, memShare) });
    }

    return rows;
}

/**
 * Lay the rows into a 3-column grid — a `"content"`-sized label column, a
 * fixed-width gap, and a `"weight"`-sized value column — so the label column
 * auto-widens to its longest label and every value shares one left edge. Cells
 * are added in row-major flow order (label, gap, value per row).
 *
 * @param rows - The metric rows.
 *
 * @returns The grid component holding the rows.
 */
function metricGrid(rows: CardRow[]): Component {
    const cells: Component[] = [];

    for (const row of rows) {
        cells.push(labelCell(row.label));
        cells.push(new Component()); // the fixed-width gap column
        cells.push(row.value);
    }

    return new Component({
        layoutManager: new Grid({
            columns      : 3,
            rows         : rows.length,
            spacing      : 0,
            defaultFill  : FillType.NONE,
            defaultAnchor: AnchorType.WEST,
            columnTracks : [{ mode: "content" }, { mode: "fixed", value: LABEL_GAP }, { mode: "weight", value: 1 }],
            rowTracks    : rows.map(() => ({ mode: "fixed" as const, value: ROW_HEIGHT })),
        }),
        preferredSize: { width: CARD_WIDTH, height: rows.length * ROW_HEIGHT },
        padding      : new Insets(0, CARD_INSET, 0, CARD_INSET),
        components   : cells,
    });
}

/**
 * One dim leading-label cell; the `"content"` column sizes to it, so its full
 * text is always shown (never truncated).
 *
 * @param label - The label text.
 *
 * @returns The label cell.
 */
function labelCell(label: string): Component {
    const text = new Text(label);

    text.setOpacity(LABEL_OPACITY);
    text.setPointerEvents("none");

    return text;
}

/**
 * One plain value cell.
 *
 * @param value - The value text.
 *
 * @returns The value cell.
 */
function valueText(value: string): Component {
    const text = new Text(value);

    text.setPointerEvents("none");

    return text;
}

/**
 * A value cell of small chips (e.g. group-key expressions), clipped at its edge
 * so a long run doesn't overflow the card.
 *
 * @param values - The chip texts.
 *
 * @returns The chips cell.
 */
function chipsCell(values: string[]): Component {
    const box = new Component({
        layoutManager: new HBox({ spacing: 4 }),
        components   : values.map(chip),
    });

    box.setOverflow("hidden");
    box.setPointerEvents("none");

    return box;
}

/**
 * One rounded chip holding a single value.
 *
 * @param value - The chip's text.
 *
 * @returns The chip component.
 */
function chip(value: string): Component {
    const text = new Text(value);

    text.setFontSize(SMALL_FONT);
    text.setPointerEvents("none");

    const box = new Component({
        layoutManager: new HBox({ spacing: 0 }),
        components   : [text],
    });

    box.setBackgroundColor("var(--ts-ui-button-bg, rgb(230, 230, 230))");
    box.setBorderRadius("8px");
    box.setPadding(new Insets(1, 6, 1, 6));
    box.setPointerEvents("none");

    return box;
}

/**
 * One rounded, tinted badge holding a label.
 *
 * @param label - The badge text.
 * @param background - The badge background colour.
 *
 * @returns The badge component.
 */
function badge(label: string, background: string): Component {
    const text = new Text(label);

    text.setFontSize(SMALL_FONT);
    text.setPointerEvents("none");

    const box = new Component({
        layoutManager: new HBox({ spacing: 0 }),
        components   : [text],
    });

    box.setBackgroundColor(background);
    box.setBorderRadius("4px");
    box.setPadding(new Insets(1, 5, 1, 5));
    box.setBorder(CARD_BORDER);
    box.setPointerEvents("none");

    return box;
}

/**
 * A value cell pairing the memory bar with its peak-memory kB label.
 *
 * @param peakMemoryKb - The node's "Peak Memory Usage" in kB.
 * @param memShare - The node's plan-relative memory share (0..1) for the bar.
 *
 * @returns The memory cell.
 */
function memoryCell(peakMemoryKb: number, memShare: number): Component {
    return new Component({
        layoutManager: new HBox({ spacing: 6 }),
        components   : [memoryBar(memShare), memoryLabel(peakMemoryKb)],
    });
}

/**
 * The memory bar: a fixed-width track with a fill sized to `share`.
 *
 * @param share - The node's plan-relative memory share (0..1).
 *
 * @returns The bar component.
 */
function memoryBar(share: number): Component {
    const clamped = Math.max(0, Math.min(1, share));

    const fill = new Component({ layoutManager: new HBox({ spacing: 0 }) });

    fill.setPreferredSize(Math.round(MEM_BAR_WIDTH * clamped), MEM_BAR_HEIGHT);
    fill.setBackgroundColor(MEM_FILL_BG);
    fill.setBorderRadius("2px");
    fill.setPointerEvents("none");

    const track = new Component({
        layoutManager: new HBox({ spacing: 0 }),
        preferredSize: { width: MEM_BAR_WIDTH, height: MEM_BAR_HEIGHT },
        components   : [fill],
    });

    track.setBackgroundColor(MEM_TRACK_BG);
    track.setBorderRadius("2px");
    track.setOverflow("hidden");
    track.setPointerEvents("none");

    return track;
}

/**
 * The peak-memory label shown beside the memory bar.
 *
 * @param kb - The peak memory usage in kB.
 *
 * @returns The label component.
 */
function memoryLabel(kb: number): Component {
    const text = new Text(`${formatMetric(kb)} kB`);

    text.setFontSize(SMALL_FONT);
    text.setOpacity(LABEL_OPACITY);
    text.setPointerEvents("none");

    return text;
}

/**
 * Blend the base and hot colours by `heat` (scaled by MAX_TINT) into an opaque
 * `rgb(...)` string for the card background.
 *
 * @param heat - The node's heat (0..1).
 *
 * @returns The tinted `rgb(...)` colour.
 */
function heatTint(heat: number): string {
    const t = Math.max(0, Math.min(1, heat)) * MAX_TINT;
    const mix = (i: number): number => Math.round(BASE_RGB[i] + (HOT_RGB[i] - BASE_RGB[i]) * t);

    return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}
