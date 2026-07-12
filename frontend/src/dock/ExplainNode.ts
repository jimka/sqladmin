// The custom DiagramView node renderer for the EXPLAIN plan diagram: a multi-row
// card showing a plan node's costs, rows/width, actual timings (when analyzed),
// group key, hash batches, and peak memory — the last three as small visuals (a
// batches badge, a memory bar, group-key chips). The whole card is tinted by its
// `heat` (self-cost / self-time share of the plan) so hot spots stand out.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends Panel directly, so
// `setSelected` is a real public method DiagramView.applySelectedVisual calls as
// `component.setSelected?.(value)` (a method call, never a detached reference —
// no arrow field needed). Selection is shown with an accent border rather than a
// background swap, because the background carries the heat tint. The row-building
// helpers are stateless module-level functions.

import { Component, Panel }        from "@jimka/typescript-ui/core";
import { VBox, HBox }              from "@jimka/typescript-ui/layout";
import { Insets }                  from "@jimka/typescript-ui/primitive";
import { Text }                    from "@jimka/typescript-ui/component/input";
import type { DiagramNodeData }    from "@jimka/typescript-ui/component/diagram";
import type { ExplainNodeData }    from "../data/buildExplainDiagram";
import type { ExplainPlanNode }    from "../data/parseExplainPlan";
import { formatMetric, formatRange } from "../data/explainFormat";

// Fixed card width: wide enough for a node-type heading and a "label   value"
// row without wrapping, narrow enough to keep a deep plan's columns readable.
const CARD_WIDTH = 240;

// Fixed heights (px) for the header and each detail row, so the card's total
// height is a simple function of how many rows the node actually has — the
// preferred size ELK lays the node out at. Header is taller for the bold heading.
const HEADER_HEIGHT = 24;
const ROW_HEIGHT    = 18;

// Vertical padding (px) above the header and below the last row, matching the
// card's own inset so rows aren't flush against the border.
const CARD_PAD = 4;

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

// Fixed width (px) of every row's leading label column, so all rows' values —
// text, chips, badges, the memory bar — line up in a single column down the card.
const LABEL_WIDTH = 72;

/**
 * One plan-node card in the EXPLAIN diagram. Renders a heat-tinted header plus a
 * detail row per present metric group; `setSelected` swaps the border to the
 * accent frame. A node whose `data` is absent renders header-only.
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
        header.setPointerEvents("none");

        const rows = plan ? detailRows(plan, info?.memShare ?? 0) : [];

        super({
            layoutManager: new VBox({ spacing: 0 }),
            preferredSize: { width: CARD_WIDTH, height: HEADER_HEIGHT + rows.length * ROW_HEIGHT + 2 * CARD_PAD },
            padding      : new Insets(CARD_PAD, 0, CARD_PAD, 0),
            components   : [header, ...rows],
        });

        this.setBorder(CARD_BORDER);
        this.setBackgroundColor(heatTint(info?.heat ?? 0));
        this.setCursor("pointer");
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
 * Build the card's detail rows, in fixed order, each present only when its source
 * fields are: cost, rows/width, actual time (analyze), actual rows (analyze),
 * group key, hash batches, and peak memory.
 *
 * @param plan - The plan node.
 * @param memShare - The node's plan-relative memory share (0..1) for the bar.
 *
 * @returns The row components to stack under the header.
 */
function detailRows(plan: ExplainPlanNode, memShare: number): Component[] {
    const rows: Component[] = [];

    if (plan.startupCost !== undefined || plan.totalCost !== undefined) {
        rows.push(labeledRow("cost", formatRange(plan.startupCost, plan.totalCost)));
    }

    if (plan.planRows !== undefined || plan.planWidth !== undefined) {
        rows.push(labeledRow("rows", `${formatMetric(plan.planRows)}    width ${formatMetric(plan.planWidth)}`));
    }

    if (plan.actualTotalTime !== undefined || plan.actualStartupTime !== undefined) {
        const loops = plan.actualLoops !== undefined ? `  ×${formatMetric(plan.actualLoops)}` : "";

        rows.push(labeledRow("time", `${formatRange(plan.actualStartupTime, plan.actualTotalTime)} ms${loops}`));
    }

    if (plan.actualRows !== undefined) {
        rows.push(labeledRow("actual rows", formatMetric(plan.actualRows)));
    }

    if (plan.groupKey && plan.groupKey.length > 0) {
        rows.push(chipRow("group", plan.groupKey));
    }

    if (plan.hashBatches !== undefined) {
        rows.push(batchesRow(plan.hashBatches));
    }

    if (plan.peakMemoryUsage !== undefined) {
        rows.push(memoryRow(plan.peakMemoryUsage, memShare));
    }

    return rows;
}

/**
 * One fixed-height row: a dim leading label in the shared label column, then the
 * given value components. Every row is built through here, so their values line
 * up in one column regardless of whether the value is text, chips, or a bar.
 *
 * @param label - The dim leading label (e.g. "cost").
 * @param values - The value components to place after the label.
 *
 * @returns The row component.
 */
function metricRow(label: string, values: Component[]): Component {
    const labelText = new Text(label);

    labelText.setOpacity(LABEL_OPACITY);
    labelText.setPreferredSize(LABEL_WIDTH, ROW_HEIGHT);
    labelText.setPointerEvents("none");

    return new Component({
        layoutManager: new HBox({ spacing: 6 }),
        preferredSize: { width: CARD_WIDTH, height: ROW_HEIGHT },
        padding      : new Insets(0, 6, 0, 6),
        components   : [labelText, ...values],
    });
}

/**
 * One fixed-height row: a dim leading label and its value text.
 *
 * @param label - The dim leading label (e.g. "cost").
 * @param value - The value text.
 *
 * @returns The row component.
 */
function labeledRow(label: string, value: string): Component {
    const valueText = new Text(value);

    valueText.setPointerEvents("none");

    return metricRow(label, [valueText]);
}

/**
 * A row of small chips (e.g. group-key expressions) after a dim leading label.
 * Chips overflowing horizontally are clipped — the card keeps its fixed width.
 *
 * @param label - The dim leading label (e.g. "group").
 * @param values - The chip texts.
 *
 * @returns The row component.
 */
function chipRow(label: string, values: string[]): Component {
    const row = metricRow(label, values.map(chip));

    row.setOverflow("hidden");

    return row;
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

    text.setFontSize(11);
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
 * The "batches" row: a badge with the hash-batch count, amber when the hash
 * spilled past one batch (didn't fit in work_mem).
 *
 * @param batches - The node's "Hash Batches".
 *
 * @returns The row component.
 */
function batchesRow(batches: number): Component {
    return metricRow("batches", [badge(formatMetric(batches), batches > 1 ? BATCH_SPILL_BG : BATCH_OK_BG)]);
}

/**
 * The "memory" row: a bar sized to the node's plan-relative memory share, with
 * its peak-memory kB beside it.
 *
 * @param peakMemoryKb - The node's "Peak Memory Usage" in kB.
 * @param memShare - The node's plan-relative memory share (0..1) for the bar.
 *
 * @returns The row component.
 */
function memoryRow(peakMemoryKb: number, memShare: number): Component {
    return metricRow("memory", [memoryBar(memShare), memoryLabel(peakMemoryKb)]);
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

    text.setFontSize(11);
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

    text.setFontSize(11);
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
