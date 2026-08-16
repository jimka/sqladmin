// A read-only Dock panel pairing a collapsible WEST info column with the plan
// DiagramView (CENTER), opened from QueryPanel's "Explain diagram" button. The
// WEST column is an accordion of three sections — a Summary table (planning /
// execution time), the structural plan Tree, and a flat Plan-steps table — and
// collapses away entirely (the Border WEST region's chevron) to give the diagram
// the full width. An optional SOUTH strip (IndexSuggestionsView, also
// collapsible) shows the heuristic index advisor's ranked CREATE INDEX
// suggestions below the diagram, mounted only when the caller already computed
// at least one; a full-width region rather than a fourth WEST section, since
// the 320px WEST column can't show a CREATE INDEX statement (see the plan's
// "SOUTH region, not a fourth accordion section" architecture decision). The
// tree and diagram stay correlated by node id
// (ExplainPlanNode.id === DiagramNodeData.id === the id carried on each
// TreeNode.data): selecting a tree row selects and scrolls the matching diagram
// node into the viewport (the feature's hard requirement), and selecting a
// diagram node highlights and scrolls its tree row. Neither programmatic
// selectNode emits, so the two directions never feed back into each other — only
// genuine user clicks drive a cross-selection.
//
// The Plan-steps table is the plan laid out flat, one row per node in plan
// (depth-first) order — its default, unsorted order. Only the Action and Cost
// columns show by default; the rest are spec-hidden and user-revealable via the
// table's column context menu. Its metric columns carry the *raw* numbers (see
// buildPlanSteps) so a header click sorts them numerically; clicking through to
// clear returns to plan order.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends Panel directly (a
// Border-layout Panel, like RelationDiagramPanel). The accordion (with its
// tables + tree) and the DiagramView are built as locals before super() (they
// are super()'s children — the super-cascade trap) and the tree/diagram
// "selection" listeners are wired after super() via .on(...), capturing the
// locals directly; the handlers close over the sibling view and the id→TreeNode
// map rather than instance fields. This panel is never itself a top-level
// dock tab (unlike SchemaDiagramPanel/RelationDiagramPanel) — it is only ever
// constructed inside QueryPanel's diagram slot, and both a rebuild and a close
// go through the library's own tab-close disposal now. That dispose() cascades
// through Component's child teardown to the DiagramView below, whose
// ElkLayoutEngine terminates the ELK Web Worker it holds.

import { Component, Panel, callable } from "@jimka/typescript-ui/core";
import { Border }                   from "@jimka/typescript-ui/layout";
import { Placement }                from "@jimka/typescript-ui/primitive";
import { Tree }                     from "@jimka/typescript-ui/component/tree";
import type { TreeNode }            from "@jimka/typescript-ui/component/tree";
import { AccordionPanel }           from "@jimka/typescript-ui/component/container";
import { Table }                    from "@jimka/typescript-ui/component/table";
import type { ColumnSpec }          from "@jimka/typescript-ui/component/table";
import { Model, MemoryStore }       from "@jimka/typescript-ui/data";
import type { FieldType, ModelRecord } from "@jimka/typescript-ui/data";
import { DiagramView }              from "@jimka/typescript-ui/component/diagram";
import type { DiagramNodeData }     from "@jimka/typescript-ui/component/diagram";
import { buildExplainDiagram }      from "../data/buildExplainDiagram";
import { buildPlanStepsRows }       from "../data/buildPlanSteps";
import { formatMetric }             from "../data/explainFormat";
import { ExplainNode }              from "./ExplainNode";
import { elkWorkerFactory }         from "./elkWorkerFactory";
import { IndexSuggestionsView }     from "./IndexSuggestionsView";
import type { ExplainPlanNode, ExplainSummary } from "../data/parseExplainPlan";
import type { AccordionLayoutBinding } from "../data/layoutStore";
import type { IndexSuggestion } from "../data/suggestIndexes";

// Fixed width of the WEST info column: fits the Action + Cost columns of the
// steps table and a node-type tree heading without stealing canvas width from
// the diagram (mirrors RelationDiagramPanel's LEGEND_WIDTH rationale). The column
// collapses to a strip via the Border region's chevron when the user wants it out
// of the way.
const LEFT_WIDTH = 320;

// The Summary table's fixed height (px): a header row plus the two metric rows
// (planning / execution time) plus its border. Pinned so the tiny summary doesn't
// claim a section share the tree/steps sections need.
const SUMMARY_HEIGHT = 88;

// Plan tree's floor and target-until-fill height (px): four rows at the
// library Tree's fixed 24px ROW_HEIGHT (mirrors treeExplorerView.ts's
// TREE_MIN_HEIGHT — same Tree class, same derivation). Set as both the
// section's minSize and preferredSize below: Tree.getPreferredSize reports
// flatRows.length * ROW_HEIGHT (an ever-growing number after expandAll())
// whenever no explicit preferredSize constraint is set, so leaving this
// unset is what let Plan tree balloon past its siblings' budget. The
// section's weight: 1 still grows it into all the leftover height once
// resizable mode resolves the open budget — this constant only bounds what
// Plan tree asks for, not what it renders at.
const PLAN_TREE_MIN_HEIGHT = 96;

// Plan steps' fixed height (px), mirroring the app's established 96px
// accordion-section floor (treeExplorerView's TREE_MIN_HEIGHT,
// PropertyValuePanel's PANEL_MIN_HEIGHT, QueriesView's SECTION_MIN_HEIGHT).
// Set as both minSize and preferredSize, and carries no weight, so under
// resizable mode it holds this px across a container resize instead of
// growing or shrinking with the window or the plan's row count — the flat
// steps table scrolls internally (Table's own VirtualScroller) for rows
// beyond what this height shows.
const PLAN_STEPS_MIN_HEIGHT = 96;

// The flat plan-steps model, one field per column. Metric fields are numeric so a
// header click sorts by magnitude, not lexically; the field *names* are the column
// headers the table renders (a PlanStepRow is keyed by these names, so it doubles
// as the store record).
const STEP_FIELDS: { name: string; type: FieldType }[] = [
    // The plan-node id, carried on the record for row→tree/diagram selection;
    // never a column (STEP_COLUMNS omits it and sets appendUnlisted: false).
    { name: "id",            type: "string" },
    { name: "Action",        type: "string" },
    { name: "Cost",          type: "number" },
    { name: "Expected Rows", type: "number" },
    { name: "Actual Rows",   type: "number" },
    { name: "Width",         type: "number" },
    { name: "Time",          type: "number" },
    { name: "Batches",       type: "number" },
    { name: "Group",         type: "string" },
    { name: "Memory",        type: "number" },
];

// Only Action and Cost show by default; every other column starts hidden and the
// user reveals it from the table's column context menu. appendUnlisted: false
// keeps the unlisted "id" field off the table (and out of the column menu) while
// the record still carries it for selection.
const STEP_COLUMNS: ColumnSpec = {
    appendUnlisted: false,
    columns: [
        { field: "Action" },
        { field: "Cost" },
        { field: "Expected Rows", hidden: true },
        { field: "Actual Rows",   hidden: true },
        { field: "Width",         hidden: true },
        { field: "Time",          hidden: true },
        { field: "Batches",       hidden: true },
        { field: "Group",         hidden: true },
        { field: "Memory",        hidden: true },
    ],
};

// The summary model: a label column and a value column, one row per metric
// (planning / execution time) — labels on the left, formatted values on the
// right. Plain strings; a two-row summary has nothing worth sorting.
const SUMMARY_FIELDS: { name: string; type: FieldType }[] = [
    { name: "Metric", type: "string" },
    { name: "Value",  type: "string" },
];

/** Already-computed suggestions plus the click handler for the strip's Create button. */
export interface ExplainAdvisorInput {
    suggestions: IndexSuggestion[];
    onCreateIndex: (suggestion: IndexSuggestion) => void;
}

/**
 * A read-only Dock panel pairing a collapsible WEST accordion (Summary table /
 * plan Tree / flat Plan-steps table) with the plan DiagramView (CENTER). Tree
 * selection selects + reveals the diagram node; diagram selection selects +
 * reveals the tree row. Class-first: extends Panel.
 */
class ExplainDiagramPanel extends Panel {
    /**
     * @param roots - The parsed plan roots (from `parseExplainPlan`).
     * @param summary - The top-level planning/execution times (from
     *   `parseExplainSummary`); both shown as an en dash when absent.
     * @param layout - The tab's saved section open flags plus the toggle save
     *   hook (`controller.layout.bindAccordion("explainDiagram")`, threaded in
     *   via QueryPanel). The accordion is resizable — a dragged gutter's sizes
     *   persist alongside each section's open flag.
     * @param advisor - The heuristic index advisor's already-computed
     *   suggestions plus its Create-button hook. Omitted (or empty) when the
     *   advisor did not run or found nothing — the SOUTH strip is then not
     *   mounted at all, so a plain Explain diagram looks exactly as it did
     *   before this feature existed.
     */
    constructor(
        roots: ExplainPlanNode[],
        summary: ExplainSummary,
        layout: AccordionLayoutBinding,
        advisor?: ExplainAdvisorInput,
    ) {
        // Locals before super() — they are super()'s children (this is
        // unavailable until super() returns).
        const data         = buildExplainDiagram(roots);
        const treeNodeById = new Map<string, TreeNode>();
        const tree         = new Tree();

        tree.setNodes(toTreeNodes(roots, treeNodeById));
        // Flatten the whole plan so every row is visible — and so tree.selectNode
        // (which no-ops under a collapsed ancestor) can reach any node on a
        // diagram→tree reverse selection.
        tree.expandAll();

        // Bound Plan tree's own reported preferred height so it stops growing with
        // the flattened row count (see Tree.getPreferredSize; PLAN_TREE_MIN_HEIGHT's
        // comment above has the full reasoning). Its weight: 1 (below) still grows
        // it to fill the accordion's leftover height; this only sets the floor and
        // the shrink/seed baseline.
        tree.setPreferredSize({ width: 0, height: PLAN_TREE_MIN_HEIGHT });
        tree.setMinSize({ width: 0, height: PLAN_TREE_MIN_HEIGHT });

        // The flat steps table — built as a local so its row selection can be
        // wired to cross-select the tree + diagram (below).
        const stepsTable = buildStepsTable(roots);

        // The default open flags live in ACCORDION_DEFAULT_OPEN
        // (data/layoutStore.ts); `open` reads them (or a saved override).
        const open = layout.loadOpen();

        // The WEST info column: a fixed-height Summary table over the plan Tree
        // over a fixed-height flat Plan-steps table, with draggable gutters
        // between every adjacent pair of open sections (resizable: true below).
        // Only Plan tree carries a weight, so it alone absorbs the column's
        // leftover height on an ordinary resize — expanding to fill available
        // space and, once its own VirtualRowView-backed scroller is given less
        // height than the flattened row count needs, scrolling internally rather
        // than reporting an ever-growing preferred height. Summary and Plan steps
        // stay pinned at their own fixed height (PLAN_STEPS_MIN_HEIGHT et al.)
        // regardless of window size or the plan's row count; a user gutter-drag
        // can still resize any of the three, floored at its own min.
        const accordion = new AccordionPanel({
            preferredSize: { width: LEFT_WIDTH, height: 0 },
            minSize      : { width: LEFT_WIDTH, height: 0 },
            // Draggable gutters between adjacent open sections (up to two, once
            // Plan steps is also open). Plan tree carries the accordion's only
            // weight, so it alone absorbs leftover height on an ordinary resize;
            // Summary and Plan steps hold their fixed height (see the min-floor
            // constants above) unless the user drags a gutter, which can still
            // resize any of the three — floored at its own min. See
            // ## Architecture Decisions in explain-accordion-resize.md.
            resizable: true,
            sections: [
                { label: "Summary",    component: buildSummaryTable(summary), initiallyOpen: open[0] },
                { label: "Plan tree",  component: tree,                       initiallyOpen: open[1], weight: 1 },
                { label: "Plan steps", component: stepsTable,                 initiallyOpen: open[2] },
            ],
            onSectionToggle: layout.onToggle,
        });

        // Custom node renderer: each node is a metric card (costs, rows, actual
        // timings, group key, batches, memory) heat-tinted by its plan share.
        const diagram = new DiagramView({
            data,
            nodeRenderer: (n: DiagramNodeData) => ExplainNode(n),
            elkWorkerFactory,
            initialFocusNode: roots[0]?.id,
        });

        // The suggestions strip: built only when the advisor ran and found at
        // least one suggestion, so a plain Explain diagram (no advisor input, or
        // an advisor that found nothing) mounts no SOUTH region at all.
        const suggestionsView = advisor && advisor.suggestions.length > 0
            ? new IndexSuggestionsView(advisor.suggestions, advisor.onCreateIndex)
            : null;

        super({
            layoutManager: new Border(),
            components   : [
                // collapsible: the Border region grows a chevron that tucks the
                // whole info column into a strip, handing its width to the diagram.
                { component: accordion, constraints: { placement: Placement.WEST, collapsible: true } },
                { component: diagram,   constraints: { placement: Placement.CENTER } },
                // collapsible: the same chevron behaviour as the WEST column, so the
                // strip can be tucked away and hand its height back to the diagram.
                ...(suggestionsView
                    ? [{ component: suggestionsView, constraints: { placement: Placement.SOUTH, collapsible: true } }]
                    : []),
            ],
        });

        // Restore the last dragged section split, if any (a stale array is
        // discarded by the library; the accordion falls back to its normal
        // weight-seeded sizing instead). Unlike the sidebar rails, this panel is
        // rebuilt on every Explain run — without this, a drag on one Explain tab
        // would be forgotten the moment a new one opens (see ## Architecture
        // Decisions in explain-accordion-resize.md).
        const savedSizes = layout.loadSizes();

        if (savedSizes !== null) {
            accordion.getAccordion().applySectionSizes(savedSizes);
        }

        accordion.getAccordion().on("sectionresize", layout.onSizes);

        // Three-way cross-selection: a click in any of the three views (tree row,
        // diagram card, steps-table row) selects and reveals the matching entry in
        // the other two, so a plan node stays highlighted everywhere at once. All
        // views correlate by the plan-node id (the tree→diagram select+scroll is
        // the feature's hard requirement).
        //
        // `syncing` guards re-entrancy: tree.selectNode / diagram.selectNode are
        // programmatic and don't emit, but Table.selectRecord does fire
        // "selection" like a user click, so without the guard driving the table
        // from a tree/diagram click would re-enter this wiring. Each handler
        // early-returns while a sync is in flight.
        let syncing = false;

        /** Select + reveal the matching diagram card for a plan id. */
        const selectInDiagram = (id: string): void => {
            diagram.selectNode(id).revealNode(id);
        };

        /**
         * Select + scroll the matching tree row. expandAll above guarantees the
         * row is in the flattened (visible) set, so the select never no-ops.
         */
        const selectInTree = (id: string): void => {
            const treeNode = treeNodeById.get(id);

            if (treeNode) {
                tree.selectNode(treeNode);
            }
        };

        /**
         * Select + scroll the matching steps-table row. The id is looked up on
         * each record's hidden "id" field, so it resolves after a re-sort.
         */
        const selectInSteps = (id: string): void => {
            const record = stepsTable.getStore().getRecords().find(r => r.get("id") === id);

            if (record) {
                stepsTable.selectRecord(record);
            }
        };

        /** Run `apply` under the re-entrancy guard. */
        const sync = (apply: () => void): void => {
            if (syncing) {
                return;
            }

            syncing = true;

            try {
                apply();
            } finally {
                syncing = false;
            }
        };

        tree.on("selection", (nodes: TreeNode[]) => {
            const id = nodes[0]?.data;

            if (typeof id === "string") {
                sync(() => { selectInDiagram(id); selectInSteps(id); });
            }
        });

        diagram.on("selection", (selection: DiagramNodeData[]) => {
            const id = selection[0]?.id;

            if (id !== undefined) {
                sync(() => { selectInTree(id); selectInSteps(id); });
            }
        });

        stepsTable.on("selection", (records: ModelRecord[]) => {
            const id = records[0]?.get("id");

            if (typeof id === "string") {
                sync(() => { selectInDiagram(id); selectInTree(id); });
            }
        });
    }
}

/**
 * Build the Summary table: two rows (planning / execution time) with the metric
 * label on the left and its formatted value on the right. A MemoryStore-backed
 * {@link Table} (no column spec, so both fields show), pinned to a small fixed
 * height and a real min floor equal to its own fixed height, so the accordion's
 * resizable mode can pin it but never crush it.
 *
 * @param summary - The parsed top-level times.
 *
 * @returns The summary table component.
 */
function buildSummaryTable(summary: ExplainSummary): Component {
    const model = new Model({ fields: SUMMARY_FIELDS.map((field, order) => ({ ...field, order })) });
    const store = new MemoryStore({
        model,
        data    : [
            { "Metric": "Planning Time",  "Value": formatMs(summary.planningTime) },
            { "Metric": "Execution Time", "Value": formatMs(summary.executionTime) },
        ],
        autoLoad: true,
    });
    const table = Table(store);

    table.setMinSize({ width: 0, height: SUMMARY_HEIGHT });
    table.setPreferredSize({ width: LEFT_WIDTH, height: SUMMARY_HEIGHT });

    return table;
}

/**
 * Build the flat Plan-steps table: one row per plan node in plan order, only
 * Action + Cost shown (the rest spec-hidden, user-revealable). Unsorted, so the
 * default order is plan order; a header click sorts numerically and clearing the
 * sort returns to plan order. Pinned to `PLAN_STEPS_MIN_HEIGHT` (min and
 * preferred) so the accordion's resizable mode holds it at a fixed, sane height
 * and scrolls its rows internally rather than growing.
 *
 * @param roots - The parsed plan roots.
 *
 * @returns The steps table (typed, so its `"selection"` event can be wired).
 */
function buildStepsTable(roots: ExplainPlanNode[]): Table {
    const model = new Model({ fields: STEP_FIELDS.map((field, order) => ({ ...field, order })) });
    const store = new MemoryStore({ model, data: buildPlanStepsRows(roots), autoLoad: true });
    const table = Table(store, STEP_COLUMNS);

    // A real min floor (not the Table's default 100×100) so the accordion's
    // resizable mode can pin this section but never crush it to zero.
    table.setMinSize({ width: 0, height: PLAN_STEPS_MIN_HEIGHT });
    table.setPreferredSize({ width: LEFT_WIDTH, height: PLAN_STEPS_MIN_HEIGHT });

    return table;
}

/**
 * Format a millisecond time for the summary table: the trimmed number with a
 * " ms" suffix, or an en dash when the time is absent (e.g. execution time on a
 * plain, non-analyze plan).
 *
 * @param ms - The time in milliseconds, or `undefined`.
 *
 * @returns The display string.
 */
function formatMs(ms: number | undefined): string {
    return ms === undefined ? "–" : `${formatMetric(ms)} ms`;
}

/**
 * Map a parsed plan forest to the library Tree's node model, recording each
 * built TreeNode in `byId` under its plan-node id so a diagram→tree selection
 * can look it up. Each TreeNode carries the plan node's id as its opaque `data`
 * payload (the tree→diagram correlation key) and its heading as the label.
 *
 * @param roots - The plan nodes at this level.
 * @param byId - Accumulates id → TreeNode for reverse selection.
 *
 * @returns The TreeNode array for these roots.
 */
function toTreeNodes(roots: ExplainPlanNode[], byId: Map<string, TreeNode>): TreeNode[] {
    return roots.map((node) => {
        const treeNode: TreeNode = {
            label   : node.label,
            data    : node.id,
            children: node.children.length > 0 ? toTreeNodes(node.children, byId) : undefined,
        };

        byId.set(node.id, treeNode);

        return treeNode;
    });
}

const ExplainDiagramPanelCallable = callable(ExplainDiagramPanel);
type ExplainDiagramPanelCallable = ExplainDiagramPanel;
export { ExplainDiagramPanelCallable as ExplainDiagramPanel };
