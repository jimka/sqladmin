// The heuristic index advisor: walks an already-parsed EXPLAIN plan forest for
// the shapes that indicate a missing index (a selective sequential scan, a sort
// an index could serve, a join with no index on one side), works out which
// columns an index would need and in what order, drops anything an existing
// index already covers, and ranks the survivors. Pure and DOM-free — the
// `LoadTableStructure` injection point is what keeps this module fetch-free —
// so the app's node-only vitest can red-green the whole pipeline. Mirrors
// fkCardinality.ts's split: this module infers structure from data, a caller
// (QueryPanel/ExplainDiagramPanel) owns the DOM.
//
// All the judgement here is heuristic: plan shapes and row/cost figures, never
// a hypothetical-index cost re-estimate (see the plan's "Non-Goals" and its
// HypoPG addendum for the follow-up that would add one).

import type { TableStructure } from "../contract";
import type { ExplainPlanNode } from "./parseExplainPlan";
import type { ColumnRef } from "./planPredicates";
import { parseConditionColumns, parseSortKeyColumns } from "./planPredicates";
import { isColumnPrefixIndexed } from "./fkCardinality";
import { quoteIdent } from "./sql";

// Rows a Seq Scan must read before its filter is worth an index (ANALYZE path).
const MIN_SCANNED_ROWS = 1000;
// Estimated total cost a node must reach before it is worth an index (plain EXPLAIN path).
const MIN_ESTIMATED_COST = 1000;
// Fraction of the rows read that a Seq Scan's filter must discard (ANALYZE path).
const MIN_DISCARD_RATIO = 0.5;
// Most columns a suggested index may carry.
const MAX_INDEX_COLUMNS = 3;
// Most suggestions shown for one plan.
const MAX_SUGGESTIONS = 5;

// Join node types the join-condition heuristic fires on.
const JOIN_NODE_TYPES: ReadonlySet<string> = new Set(["Hash Join", "Merge Join", "Nested Loop"]);

/** How a column contributed to a candidate — one more role than
 *  {@link PredicateRole} ("sort" for a Sort node's key), since column
 *  ordering (equality, then sort, then range) needs to distinguish it. */
type EvidenceRole = "equality" | "sort" | "range";

/** One column reference plus the role it was seen in, attributed to a relation. */
interface Evidence {
    schema: string;
    relation: string;
    column: string;
    role: EvidenceRole;
}

/** A node's "work" figure, and which scale it is on. */
interface NodeWeight {
    /** Rows read (measured) or estimated total cost. */
    value: number;
    /** True when `value` is a measured row count, false when it is an estimated cost. */
    measured: boolean;
}

/** A relation's index candidate, before dedup and ranking. */
export interface IndexCandidate {
    schema: string;
    relation: string;
    /** Index columns in the order they must appear, already truncated to MAX_INDEX_COLUMNS. */
    columns: string[];
    /** One fixed-vocabulary phrase per contributing gate node, in plan order
     *  (depth-first, parent before children — the order buildPlanStepsRows uses). */
    reasons: string[];
    /** The plan-node ids that produced this candidate's evidence. */
    nodeIds: string[];
    /** Highest measured rows read among the contributing nodes; absent on a plain EXPLAIN. */
    rowsScanned?: number;
    /** Highest estimated total cost among the contributing nodes. */
    cost: number;
}

/** A ranked, deduped candidate, ready to display. */
export interface IndexSuggestion extends IndexCandidate {
    /** Row id — the suggestion's position in the returned array, as a string. */
    id: string;
    /** The `CREATE INDEX "schema"."relation" (...)` preview text. */
    ddl: string;
}

/** Fetches one relation's indexes/constraints. Injected so this module stays DOM- and fetch-free. */
export type LoadTableStructure = (schema: string, relation: string) => Promise<TableStructure>;

/** One suggestions-table row. Keys are the column headers the table renders. */
export interface IndexSuggestionRow {
    "id": string;
    "Index": string;
    "Why": string;
    "Rows scanned"?: number;
    "Cost": number;
}

/**
 * The map key a structure is looked up under.
 *
 * @param schema - The relation's schema.
 * @param relation - The relation's (table) name.
 * @returns `${schema}.${relation}`.
 */
export function relationKey(schema: string, relation: string): string {
    return `${schema}.${relation}`;
}

/**
 * Build a parent-lookup for every node in the forest (id -> parent, `undefined`
 * for a root) via one depth-first pass. Needed because the size gate's estimated
 * path reads a node's *parent's* cost for an inner Nested Loop side, and the
 * join heuristic needs a resolved scan's own parent, not the join node's.
 *
 * @param roots - The plan roots.
 * @returns The id -> parent map.
 */
function buildParentMap(roots: ExplainPlanNode[]): Map<string, ExplainPlanNode | undefined> {
    const parents = new Map<string, ExplainPlanNode | undefined>();

    const walk = (node: ExplainPlanNode, parent: ExplainPlanNode | undefined): void => {
        parents.set(node.id, parent);

        for (const child of node.children) {
            walk(child, node);
        }
    };

    for (const root of roots) {
        walk(root, undefined);
    }

    return parents;
}

/**
 * A node's "work" figure for the size gate: a measured row count when the plan
 * ran under ANALYZE, else an estimated cost. An inner Nested Loop side's own
 * estimated cost is per-loop (it does not include the repetition), so it takes
 * the loop's own total cost instead.
 *
 * @param node - The node to weigh.
 * @param parent - The node's parent, if any (see {@link buildParentMap}).
 * @returns The node's weight.
 */
function nodeWeight(node: ExplainPlanNode, parent: ExplainPlanNode | undefined): NodeWeight {
    if (node.actualRows !== undefined) {
        const loops = node.actualLoops ?? 1;
        const value = (node.actualRows + (node.rowsRemovedByFilter ?? 0)) * loops;

        return { value, measured: true };
    }

    if (node.parentRelationship === "Inner" && parent?.nodeType === "Nested Loop") {
        return { value: parent.totalCost ?? 0, measured: false };
    }

    return { value: node.totalCost ?? 0, measured: false };
}

/**
 * Whether `weight` clears the size gate for its own scale.
 *
 * @param weight - The node's weight.
 * @returns True when `value` reaches the measured or estimated threshold.
 */
function passesSizeGate(weight: NodeWeight): boolean {
    return weight.measured ? weight.value >= MIN_SCANNED_ROWS : weight.value >= MIN_ESTIMATED_COST;
}

/**
 * The Seq Scan filter heuristic's extra rule: the filter must have discarded
 * at least {@link MIN_DISCARD_RATIO} of the rows it read. Measured runs only —
 * the estimated path cannot compute a discard ratio, so it always passes.
 *
 * @param node - The Seq Scan node.
 * @param weight - The node's already-computed weight.
 * @returns Whether the discard-ratio rule is satisfied (or inapplicable).
 */
function passesDiscardRatio(node: ExplainPlanNode, weight: NodeWeight): boolean {
    if (!weight.measured) {
        return true;
    }

    const removed = node.rowsRemovedByFilter ?? 0;
    const kept    = node.actualRows ?? 0;
    const total   = removed + kept;

    return total > 0 && removed / total >= MIN_DISCARD_RATIO;
}

/**
 * The display cost for one contributing node: its own total cost on the
 * measured path (ANALYZE still reports cost estimates alongside actual rows),
 * or the (possibly Nested-Loop-substituted) weight value on the estimated path.
 *
 * @param node - The contributing node.
 * @param weight - The node's already-computed weight.
 * @returns The cost figure to roll into the candidate's `cost`.
 */
function contributionCost(node: ExplainPlanNode, weight: NodeWeight): number {
    return weight.measured ? (node.totalCost ?? 0) : weight.value;
}

/**
 * Map every `alias ?? relationName` reachable under `node`'s own subtree to the
 * Seq Scan that produced it — the per-subtree alias resolution the Sort and
 * join heuristics both need (a reference qualified with an alias from outside
 * the subtree cannot be served by a single-table index built from it).
 *
 * @param node - The subtree root (a Sort or a join node); `node` itself is
 *   excluded (neither is ever a Seq Scan).
 * @returns The alias/relationName -> Seq Scan map.
 */
function scanAliasMap(node: ExplainPlanNode): Map<string, ExplainPlanNode> {
    const map = new Map<string, ExplainPlanNode>();

    const walk = (n: ExplainPlanNode): void => {
        if (n.nodeType === "Seq Scan" && n.relationName !== undefined) {
            map.set(n.alias ?? n.relationName, n);
        }

        for (const child of n.children) {
            walk(child);
        }
    };

    for (const child of node.children) {
        walk(child);
    }

    return map;
}

/**
 * Resolve every ref to the *same* Seq Scan via `aliasMap` — an unqualified ref
 * is ambiguous, a ref whose alias resolves to no scan in this subtree cannot
 * be served, and refs resolving to more than one relation cannot be served by
 * one single-table index.
 *
 * @param refs - The column refs to resolve (e.g. a Sort's keys).
 * @param aliasMap - This node's per-subtree alias map (see {@link scanAliasMap}).
 * @returns The single resolved Seq Scan, or `null` when resolution fails.
 */
function resolveSingleRelation(refs: ColumnRef[], aliasMap: Map<string, ExplainPlanNode>): ExplainPlanNode | null {
    let resolved: ExplainPlanNode | null = null;

    for (const ref of refs) {
        if (ref.alias === undefined) {
            return null;
        }

        const scan = aliasMap.get(ref.alias);

        if (!scan) {
            return null;
        }

        if (resolved !== null && resolved !== scan) {
            return null;
        }

        resolved = scan;
    }

    return resolved;
}

/** One heuristic's contribution: the evidence it produced, plus its gate
 *  node's id/reason/weight/cost for reason ordering and ranking. */
interface Contribution {
    schema: string;
    relation: string;
    nodeId: string;
    reason: string;
    weight: NodeWeight;
    cost: number;
    evidence: Evidence[];
}

/**
 * The Seq-scan-filter heuristic: a `Seq Scan` with a schema, a relation, and a
 * filter whose recognised conjuncts (after dropping any correlated-outer-alias
 * reference) pass the size + discard-ratio gate.
 *
 * @param node - The candidate Seq Scan node.
 * @param parent - The node's parent, if any.
 * @returns The contribution, or `null` when the heuristic does not fire.
 */
function seqScanFilterContribution(node: ExplainPlanNode, parent: ExplainPlanNode | undefined): Contribution | null {
    if (node.nodeType !== "Seq Scan" || !node.filter || !node.relationName || !node.schema) {
        return null;
    }

    const selfAlias = node.alias ?? node.relationName;
    const refs       = parseConditionColumns(node.filter).filter(r => r.alias === undefined || r.alias === selfAlias);

    if (refs.length === 0) {
        return null;
    }

    const weight = nodeWeight(node, parent);

    if (!passesSizeGate(weight) || !passesDiscardRatio(node, weight)) {
        return null;
    }

    const schema   = node.schema;
    const relation = node.relationName;

    return {
        schema, relation, nodeId: node.id,
        reason  : `Seq Scan filter on ${refs.map(r => r.column).join(", ")}`,
        weight, cost: contributionCost(node, weight),
        evidence: refs.map(r => ({ schema, relation, column: r.column, role: r.role })),
    };
}

/**
 * The Sort-key heuristic: a `Sort` whose keys all resolve to one Seq Scan
 * relation beneath it. Skips the size gate entirely when the Sort's immediate
 * parent is a `Limit` (a top-N query is worth an ordered index at any size).
 *
 * @param node - The candidate Sort node.
 * @param parent - The node's parent, if any.
 * @returns The contribution, or `null` when the heuristic does not fire.
 */
function sortKeyContribution(node: ExplainPlanNode, parent: ExplainPlanNode | undefined): Contribution | null {
    if (node.nodeType !== "Sort" || !node.sortKey || node.sortKey.length === 0) {
        return null;
    }

    const refs = parseSortKeyColumns(node.sortKey);

    if (refs.length === 0) {
        return null;
    }

    const resolved = resolveSingleRelation(refs, scanAliasMap(node));

    if (!resolved || !resolved.schema || !resolved.relationName) {
        return null;
    }

    const isTopN = parent?.nodeType === "Limit";
    const weight = nodeWeight(node, parent);

    if (!isTopN && !passesSizeGate(weight)) {
        return null;
    }

    const schema   = resolved.schema;
    const relation = resolved.relationName;
    const columns  = refs.map(r => r.column).join(", ");

    return {
        schema, relation, nodeId: node.id,
        reason  : isTopN ? `Top-N sort on ${columns}` : `Sort on ${columns}`,
        weight, cost: contributionCost(node, weight),
        evidence: refs.map(r => ({ schema, relation, column: r.column, role: "sort" as const })),
    };
}

/**
 * The join-condition heuristic: a `Hash Join` / `Merge Join` / `Nested Loop`
 * whose join qualifier's recognised refs each resolve to a Seq Scan beneath
 * it. Unlike the other two heuristics, this one can yield *several*
 * contributions from a single node — one per side that resolves and clears
 * its own scan's gate (the plan's worked example: a large left side survives,
 * a tiny right side does not).
 *
 * @param node - The candidate join node.
 * @param parents - The whole forest's id -> parent map (a resolved scan's own
 *   parent may be several levels below `node`).
 * @returns The contributions (possibly empty) from this join node.
 */
function joinConditionContributions(
    node: ExplainPlanNode,
    parents: Map<string, ExplainPlanNode | undefined>,
): Contribution[] {
    if (!JOIN_NODE_TYPES.has(node.nodeType)) {
        return [];
    }

    const condition = node.hashCond ?? node.mergeCond ?? node.joinFilter;

    if (!condition) {
        return [];
    }

    const aliasMap = scanAliasMap(node);
    const contributions: Contribution[] = [];

    for (const ref of parseConditionColumns(condition)) {
        if (ref.alias === undefined) {
            continue;
        }

        const scan = aliasMap.get(ref.alias);

        if (!scan || !scan.schema || !scan.relationName) {
            continue;
        }

        const weight = nodeWeight(scan, parents.get(scan.id));

        if (!passesSizeGate(weight)) {
            continue;
        }

        const schema   = scan.schema;
        const relation = scan.relationName;

        contributions.push({
            schema, relation, nodeId: scan.id,
            reason  : `${node.nodeType} condition on ${ref.column}`,
            weight, cost: contributionCost(scan, weight),
            evidence: [{ schema, relation, column: ref.column, role: ref.role }],
        });
    }

    return contributions;
}

// Column-order strength: equality columns lead, then sort keys, then range
// columns (see the plan's "Column order" architecture decision) — a lower
// number sorts earlier and wins when the same column is seen in two roles.
const ROLE_STRENGTH: Record<EvidenceRole, number> = { equality: 0, sort: 1, range: 2 };

/**
 * Order a relation's evidence into an index column list: grouped by each
 * column's *strongest* role (equality beats sort beats range), first-seen
 * order preserved within a group, truncated to {@link MAX_INDEX_COLUMNS}.
 *
 * @param evidence - Every evidence record collected for one relation.
 * @returns The ordered, truncated column list.
 */
function orderColumns(evidence: Evidence[]): string[] {
    const strongestRole = new Map<string, EvidenceRole>();
    const firstSeen: string[] = [];

    for (const e of evidence) {
        const existing = strongestRole.get(e.column);

        if (existing === undefined) {
            strongestRole.set(e.column, e.role);
            firstSeen.push(e.column);
        } else if (ROLE_STRENGTH[e.role] < ROLE_STRENGTH[existing]) {
            strongestRole.set(e.column, e.role);
        }
    }

    const byRole: Record<EvidenceRole, string[]> = { equality: [], sort: [], range: [] };

    for (const column of firstSeen) {
        byRole[strongestRole.get(column)!].push(column);
    }

    return [...byRole.equality, ...byRole.sort, ...byRole.range].slice(0, MAX_INDEX_COLUMNS);
}

/**
 * Walk the plan and emit one candidate per relation that passed at least one
 * heuristic's gate — grouping every contributing node's evidence onto its
 * relation (which is what produces a multi-column composite candidate when a
 * relation is both filtered and sorted).
 *
 * @param roots - The parsed plan roots.
 * @returns One candidate per relation with surviving evidence.
 */
export function collectIndexCandidates(roots: ExplainPlanNode[]): IndexCandidate[] {
    const parents = buildParentMap(roots);

    interface Group {
        schema: string;
        relation: string;
        evidence: Evidence[];
        // Keyed by nodeId, insertion-ordered — plan order (parent before
        // children), the order reasons/nodeIds must be reported in.
        contributions: Map<string, { reason: string; weight: NodeWeight; cost: number }>;
    }

    const groups = new Map<string, Group>();

    const add = (c: Contribution): void => {
        const key = relationKey(c.schema, c.relation);
        let group = groups.get(key);

        if (!group) {
            group = { schema: c.schema, relation: c.relation, evidence: [], contributions: new Map() };
            groups.set(key, group);
        }

        group.evidence.push(...c.evidence);

        if (!group.contributions.has(c.nodeId)) {
            group.contributions.set(c.nodeId, { reason: c.reason, weight: c.weight, cost: c.cost });
        }
    };

    const walk = (node: ExplainPlanNode): void => {
        const parent = parents.get(node.id);

        const filterHit = seqScanFilterContribution(node, parent);
        if (filterHit) add(filterHit);

        const sortHit = sortKeyContribution(node, parent);
        if (sortHit) add(sortHit);

        for (const joinHit of joinConditionContributions(node, parents)) {
            add(joinHit);
        }

        for (const child of node.children) {
            walk(child);
        }
    };

    for (const root of roots) {
        walk(root);
    }

    return [...groups.values()].map((group) => {
        const entries      = [...group.contributions.entries()];
        const measuredVals = entries.filter(([, c]) => c.weight.measured).map(([, c]) => c.weight.value);

        return {
            schema  : group.schema,
            relation: group.relation,
            columns : orderColumns(group.evidence),
            reasons : entries.map(([, c]) => c.reason),
            nodeIds : entries.map(([id]) => id),
            ...(measuredVals.length > 0 ? { rowsScanned: Math.max(...measuredVals) } : {}),
            cost: Math.max(...entries.map(([, c]) => c.cost)),
        };
    });
}

/**
 * Drop every candidate whose columns are a leading prefix of an existing index
 * or PK/unique constraint, and every candidate with no entry in `structures`
 * (the advisor never suggests an index it could not check).
 *
 * @param candidates - The collected candidates.
 * @param structures - Each relation's structure, keyed by {@link relationKey}.
 * @returns The surviving candidates.
 */
export function rejectCoveredCandidates(
    candidates: IndexCandidate[],
    structures: Map<string, TableStructure>,
): IndexCandidate[] {
    return candidates.filter((c) => {
        const structure = structures.get(relationKey(c.schema, c.relation));

        return structure !== undefined && !isColumnPrefixIndexed(c.columns, structure);
    });
}

/**
 * The `CREATE INDEX` preview text for a candidate — display only; the
 * statement actually executed is always the backend's `ddl.create_index`
 * output, reached through the "Create index…" dialog.
 *
 * @param candidate - The candidate to render.
 * @returns The preview DDL text.
 */
export function suggestionDdl(candidate: IndexCandidate): string {
    const columns = candidate.columns.map(quoteIdent).join(", ");

    return `CREATE INDEX ON ${quoteIdent(candidate.schema)}.${quoteIdent(candidate.relation)} (${columns})`;
}

/**
 * Sort, truncate to {@link MAX_SUGGESTIONS}, and assign `id` + `ddl`. Sorts by
 * `rowsScanned` when present, by `cost` otherwise (within one plan every
 * candidate is on the same scale — see the plan's "Ranking" architecture
 * decision); ties break on contributing-node count descending, then on
 * `schema.relation` ascending for a stable order.
 *
 * @param candidates - The (already coverage-filtered) candidates.
 * @returns The ranked, capped suggestions.
 */
export function rankCandidates(candidates: IndexCandidate[]): IndexSuggestion[] {
    const ranked = [...candidates].sort((a, b) => {
        const aValue = a.rowsScanned ?? a.cost;
        const bValue = b.rowsScanned ?? b.cost;

        if (aValue !== bValue) {
            return bValue - aValue;
        }

        if (a.nodeIds.length !== b.nodeIds.length) {
            return b.nodeIds.length - a.nodeIds.length;
        }

        const aKey = relationKey(a.schema, a.relation);
        const bKey = relationKey(b.schema, b.relation);

        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });

    return ranked.slice(0, MAX_SUGGESTIONS).map((candidate, i) => ({
        ...candidate,
        id : String(i),
        ddl: suggestionDdl(candidate),
    }));
}

/**
 * The full pipeline: collect -> fetch each distinct relation's structure ->
 * reject covered -> rank. Every relation's `load` call runs concurrently
 * under `Promise.allSettled`; a rejected fetch drops just that relation's
 * candidates (per {@link rejectCoveredCandidates}), never the whole result.
 *
 * @param roots - The parsed plan roots.
 * @param load - Fetches one relation's structure (see {@link LoadTableStructure}).
 * @returns The ranked suggestions.
 */
export async function resolveIndexSuggestions(
    roots: ExplainPlanNode[],
    load: LoadTableStructure,
): Promise<IndexSuggestion[]> {
    const candidates = collectIndexCandidates(roots);

    if (candidates.length === 0) {
        return [];
    }

    const relations = new Map<string, { schema: string; relation: string }>();

    for (const c of candidates) {
        relations.set(relationKey(c.schema, c.relation), { schema: c.schema, relation: c.relation });
    }

    const fetched = await Promise.allSettled(
        [...relations.entries()].map(async ([key, { schema, relation }]) =>
            [key, await load(schema, relation)] as const),
    );

    const structures = new Map<string, TableStructure>();

    for (const result of fetched) {
        if (result.status === "fulfilled") {
            const [key, structure] = result.value;

            structures.set(key, structure);
        }
    }

    return rankCandidates(rejectCoveredCandidates(candidates, structures));
}

/**
 * One row per suggestion, in ranked order. `Why` joins every contributing
 * reason with `"; "`; `Rows scanned` is omitted (not zero) when the plan
 * carried no measured rows.
 *
 * @param suggestions - The ranked suggestions.
 * @returns The table rows.
 */
export function buildIndexSuggestionRows(suggestions: IndexSuggestion[]): IndexSuggestionRow[] {
    return suggestions.map(s => ({
        "id"   : s.id,
        "Index": s.ddl,
        "Why"  : s.reasons.join("; "),
        ...(s.rowsScanned !== undefined ? { "Rows scanned": s.rowsScanned } : {}),
        "Cost" : s.cost,
    }));
}
