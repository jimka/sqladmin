// Pure composition of an edge-hover tooltip from the diagram's hover payload
// (every edge within the pointer's hit tolerance). No DOM, no ELK — type-only
// imports from the diagram barrel keep this node-vitest-testable, the same
// purity discipline as buildSchemaDiagram.ts:16-21. The library carries no
// `tooltip` field on `DiagramEdgeData` — a model string cannot describe a
// merged trunk carrying several different foreign keys — so the app composes
// the text here from the hover event's edge array instead.
//
// Two independent things can put several foreign keys under one pointer: a
// single edge can be a folded edge (collapseParallelFkEdges) carrying several
// keys in its `fks` array, and a hover can also report several edges sharing a
// junction stub. The pair list below flattens across both — every hovered
// edge's every key — so the bundle forms cover a folded edge, a stubbed
// bundle, and a folded edge inside a stubbed bundle alike.

import type { DiagramEdgeData } from "@jimka/typescript-ui/component/diagram";
import type { FkDetail, FkEdgeData } from "./buildSchemaDiagram";
import { referentialActionParts } from "./fkCardinality";

/**
 * Cap on the number of rendered detail *lines* a bundle tooltip draws before
 * collapsing the rest into a trailing "…and N more" line. The tooltip renders
 * roughly 20px per line beside the cursor, so eight lines plus the heading stays
 * under about 180px tall — comfortably inside a viewport without the tooltip
 * needing to reposition.
 */
const MAX_TOOLTIP_LINES = 8;

/** One (edge, FK key) pair, resolved from an edge that actually carries FkEdgeData. */
interface FkEdgePair {
    edge: DiagramEdgeData;
    fk:   FkDetail;
}

/**
 * Narrows an edge's opaque `data` to {@link FkEdgeData}: an edge contributes
 * when its `data` is an object carrying a `fks` array — the shape
 * `buildSchemaDiagram` gives every FK edge, and the one the dependency /
 * inheritance / role diagrams' edges never have.
 *
 * @param data - The edge's `data` payload.
 * @returns Whether `data` is `FkEdgeData`.
 */
function isFkEdgeData(data: unknown): data is FkEdgeData {
    return typeof data === "object" && data !== null && Array.isArray((data as { fks?: unknown }).fks);
}

/**
 * The optional referential-action line, joining whichever of `onUpdate` /
 * `onDelete` deviates from the Postgres `"NO ACTION"` default with `" · "`,
 * matching `columnTooltip`'s attribute separator (schemaCardModel.ts).
 *
 * @param fk - The edge's FK data.
 * @returns The line, or `null` when both actions are the default.
 */
function referentialActionLine(fk: FkDetail): string | null {
    const parts = referentialActionParts(fk.onUpdate, fk.onDelete);

    return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The full multi-line detail for one FK edge: its column-to-column header and
 * the optional referential-action line.
 *
 * Index coverage is deliberately absent. A folded edge carries one key per
 * fold, so a per-key coverage line repeated the same sentence down the tooltip
 * and crowded out the part that identifies the keys. The warning-tinted stroke
 * still marks an uncovered edge; surfacing which key it is belongs in the
 * relation's own structure view, not on hover (see TODO.md).
 *
 * @param pair - The edge and its FK data.
 * @returns The detail text.
 */
function singleEdgeDetail(pair: FkEdgePair): string {
    const lines = [fkHeader(pair)];
    const actionLine = referentialActionLine(pair.fk);

    if (actionLine !== null) {
        lines.push(actionLine);
    }

    return lines.join("\n");
}

/**
 * The one-line `source(columns) → target(refColumns)` header shared by the
 * single-edge detail and the "different targets" bundle form.
 *
 * @param pair - The edge and its FK data.
 * @returns The header line.
 */
function fkHeader(pair: FkEdgePair): string {
    return `${pair.edge.source}(${pair.fk.columns.join(", ")}) → ${pair.edge.target}(${pair.fk.refColumns.join(", ")})`;
}

/** Whether every pair references the same node on the same columns. */
function shareOneTarget(pairs: FkEdgePair[]): boolean {
    const [first, ...rest] = pairs;

    return rest.every(p => p.edge.target === first.edge.target
        && p.fk.refColumns.length === first.fk.refColumns.length
        && p.fk.refColumns.every((c, i) => c === first.fk.refColumns[i]));
}

/**
 * Caps a bundle's detail blocks at a {@link MAX_TOOLTIP_LINES}-line visual
 * budget, appending a trailing summary line for the rest. Every block
 * `multiEdgeSummary` passes in is one line today (index coverage was removed —
 * see `singleEdgeDetail`'s and `multiEdgeSummary`'s own notes on that), but the
 * cap still counts *rendered lines*, not blocks: a block that ever grows past
 * one line (an optional referential-action line, say) is still budgeted
 * correctly, and one that would only partially fit is excluded whole rather
 * than split across the boundary. The trailing summary still counts
 * contributing *keys*, not lines, matching the existing `"…and N more"` contract.
 *
 * @param blocks - Every detail block, one per contributing key.
 * @returns The blocks to render, capped to the line budget.
 */
function capDetailLines(blocks: string[]): string[] {
    let lineBudget = MAX_TOOLTIP_LINES;
    let shown = blocks.length;

    for (const [i, block] of blocks.entries()) {
        const blockLineCount = block.split("\n").length;

        if (blockLineCount > lineBudget) {
            shown = i;
            break;
        }

        lineBudget -= blockLineCount;
    }

    if (shown === blocks.length) {
        return blocks;
    }

    return [...blocks.slice(0, shown), `…and ${blocks.length - shown} more`];
}

/**
 * The heading + capped detail blocks for two or more contributing keys: a
 * merged-trunk summary (`"N references to target(refColumns)"` plus each
 * source's own column) when every key shares the same target and referenced
 * columns, else a plain foreign-key list (`"N foreign keys here"` plus each
 * key's full header). Index coverage is absent from both forms, for the reason
 * {@link singleEdgeDetail} gives — so every key contributes exactly one line
 * and the cap counts keys and lines alike.
 *
 * @param pairs - Every contributing edge/key pair, in hover-payload order.
 * @returns The bundle tooltip text.
 */
function multiEdgeSummary(pairs: FkEdgePair[]): string {
    if (shareOneTarget(pairs)) {
        const heading = `${pairs.length} references to ${pairs[0].edge.target}(${pairs[0].fk.refColumns.join(", ")})`;
        const detail  = pairs.map(p => `${p.edge.source}(${p.fk.columns.join(", ")})`);

        return [heading, ...capDetailLines(detail)].join("\n");
    }

    const heading = `${pairs.length} foreign keys here`;
    const detail  = pairs.map(p => fkHeader(p));

    return [heading, ...capDetailLines(detail)].join("\n");
}

/**
 * The `\n`-separated tooltip text for the edges under the pointer. The pairs
 * it renders come from every hovered edge's every folded key, in hover order
 * then declaration order — so a folded edge, a stubbed bundle, and a folded
 * edge inside a stubbed bundle all render through the same bundle forms.
 *
 * @param edges - Every edge within the hit tolerance, in draw order.
 *
 * @returns The tooltip text, or null when no edge carries foreign-key data.
 */
export function fkEdgeTooltip(edges: DiagramEdgeData[]): string | null {
    const pairs = edges
        .filter((edge): edge is DiagramEdgeData & { data: FkEdgeData } => isFkEdgeData(edge.data))
        .flatMap((edge): FkEdgePair[] => edge.data.fks.map(fk => ({ edge, fk })));

    if (pairs.length === 0) {
        return null;
    }

    if (pairs.length === 1) {
        return singleEdgeDetail(pairs[0]);
    }

    return multiEdgeSummary(pairs);
}
