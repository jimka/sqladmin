---
touches-shared:
  - frontend/src/SqlAdminController.ts
  - frontend/src/dock/QueryPanel.ts
  - frontend/src/dock/ExplainDiagramPanel.ts
  - frontend/src/dock/IndexForm.ts
  - frontend/src/data/api.ts
  - frontend/src/data/explain.ts
  - frontend/src/data/fkCardinality.ts
  - frontend/src/data/parseExplainPlan.ts
  - frontend/src/data/sql.ts
  - frontend/tests/data/fkCardinality.test.ts
  - frontend/tests/data/parseExplainPlan.test.ts
  - backend/app/main.py
  - backend/app/operations/explain_query.py
  - README.md
---

# Heuristic Index Advisor — Implementation Plan

## Overview

SQLAdmin can already show a query's plan as a tree and a diagram: the SQL workspace's "Explain diagram" button re-runs the statement as `EXPLAIN (FORMAT JSON)`, [`parseExplainPlan.ts:89`](frontend/src/data/parseExplainPlan.ts#L89) turns the payload into a node forest, and [`ExplainDiagramPanel.ts:140`](frontend/src/dock/ExplainDiagramPanel.ts#L140) renders it. Nothing reads the plan for *advice*.

This plan adds an index advisor. It reads the same parsed plan, spots the plan shapes that indicate a missing index, works out which columns an index would need and in what order, drops anything an existing index already covers, and shows the survivors as `CREATE INDEX` statements in a new collapsible strip below the plan diagram. Clicking one opens the app's existing DDL preview dialog ([`SqlPreviewDialog.ts:103`](frontend/src/dock/SqlPreviewDialog.ts#L103)) with the columns pre-checked, so the statement is executed by the same path as every other index the app creates.

All the judgement is heuristic: plan shapes and row counts, never a hypothetical-index cost re-estimate. The analysis is pure TypeScript in two new `frontend/src/data/` modules, unit-tested under the project's node-environment vitest. The backend gains one flag — `verbose` on the existing explain operation — because `EXPLAIN (VERBOSE)` is what makes Postgres name the schema of each scanned relation and qualify every predicate column with its alias.

---

## Architecture Decisions

### The heuristics run in the frontend, over the already-parsed plan tree

`collectIndexCandidates` and its helpers live in `frontend/src/data/suggestIndexes.ts` and take an `ExplainPlanNode[]`. No plan analysis is added to the backend.[^frontend-analysis]

This mirrors the EXPLAIN feature's own split: [`explain_query.py:106`](backend/app/operations/explain_query.py#L106) passes the plan tree through "unchanged as `planJson`", and every derived view — the parse, the diagram, the steps table, the number formatting — is a pure `frontend/src/data/` module with its own vitest suite. [`fkCardinality.ts`](frontend/src/data/fkCardinality.ts) is the closest precedent of all: it already decides "is this column list covered by an existing index" client-side, by parsing `pg_indexes.indexdef` text.

### The plan JSON is fetched with `VERBOSE`

`showDiagram` in [`QueryPanel.ts:688`](frontend/src/dock/QueryPanel.ts#L688) asks for `{ analyze, format: "json", verbose: true }`. The backend's `ExplainQueryCommand` gains a `verbose` flag that adds `VERBOSE` to the `EXPLAIN (…)` option list.[^verbose]

Two things follow from `VERBOSE`, and the advisor needs both:

| Without `VERBOSE` | With `VERBOSE` |
|---|---|
| `"Relation Name": "orders"` | `"Schema": "public", "Relation Name": "orders"` |
| `Filter: (status = 'x'::text)` on a single-table query, `(o.status = 'x'::text)` on a join | `Filter: (o.status = 'x'::text)` always |

A candidate with no schema is dropped, so the advisor is inert on a plan fetched without the flag.

### One suggestion per relation, built from every piece of evidence for it

The walk emits **evidence** — one `{schema, relation, column, role}` record per column reference it recognises — and then groups the evidence by relation. Each relation yields at most one suggestion, whose column list is the union of its evidence.[^one-per-relation]

Grouping is what produces multi-column suggestions: a relation that is both filtered and sorted gets one composite index, not two single-column ones.

### Column order: equality first, then sort keys, then ranges

Within a relation's suggestion, columns are ordered by the role they were seen in — every equality column first, then every sort-key column, then every range column — keeping first-seen order inside each group. A column seen in more than one role keeps its strongest role (equality beats sort beats range) and appears once.[^column-order]

| Evidence for `orders` | Suggested columns |
|---|---|
| `status =`, `total >` | `status, total` |
| `status =`, sort on `created_at`, `total >` | `status, created_at, total` |
| sort on `created_at`, `customer_id =` | `customer_id, created_at` |
| `total >`, `total =` | `total` (equality wins; listed once) |

The list is truncated to `MAX_INDEX_COLUMNS` (3).

### Predicates are read with conservative regular expressions, not a SQL parser

`frontend/src/data/planPredicates.ts` splits a plan-text condition on top-level `AND` and matches each conjunct against a column-reference pattern. Anything it does not recognise is dropped rather than guessed at.[^regex-parsing]

| Plan text | Extracted |
|---|---|
| `(o.status = 'active'::text)` | `o.status`, equality |
| `((o.status)::text = 'x'::text)` | `o.status`, equality |
| `((o.status = 'x'::text) AND (o.total > 100))` | `o.status` equality, `o.total` range |
| `(o.customer_id = c.id)` | `o.customer_id` and `c.id`, both equality |
| `(lower((o.email)::text) = 'x'::text)` | nothing — expression on the left |
| `((o.a = 1) OR (o.b = 2))` | nothing — top-level `OR` |
| `(o.status <> 'x'::text)` | nothing — `<>` is not an indexable operator here |

`parseConditionColumns`'s known limits are stated in `## Potential Challenges` and repeated in the module header.

### A candidate is dropped when an existing index already leads with it

Before a suggestion is shown, the relation's `TableStructure` is fetched and the candidate column list is tested as a **leading prefix** of each existing index and each primary-key/unique constraint. A prefix match drops the candidate.

| Candidate | Existing | Verdict |
|---|---|---|
| `status` | `btree (status)` | dropped — exact match |
| `status` | `btree (status, created_at)` | dropped — candidate is a prefix |
| `status, created_at` | `btree (status)` | kept — the composite is strictly more useful |
| `status, created_at` | `btree (created_at, status)` | kept — order matters to a B-tree |
| `status` | `btree (lower(status))` | kept — an expression index is unparseable, so it never covers |

If the structure fetch for a relation fails, that relation's candidates are dropped — the advisor never suggests an index it could not check.

### `isFkCovered` is renamed `isColumnPrefixIndexed`

[`fkCardinality.ts:200`](frontend/src/data/fkCardinality.ts#L200) already implements exactly the prefix-coverage test above; only its name is foreign-key-specific. It is renamed and its doc comment generalised, and the advisor calls it rather than reimplementing the loop.[^rename]

### Suggestions ride the existing "Explain diagram" action

Nothing new appears on the SQL workspace toolbar. The advisor runs inside `showDiagram`, between the parse and the tab mount, and its output is handed to `ExplainDiagramPanel`. A plain Explain run (the text plan) is untouched and costs no extra round trip.[^ride-diagram]

### The suggestions strip is a SOUTH region, not a fourth accordion section

`ExplainDiagramPanel`'s Border layout gains a `Placement.SOUTH` region, `collapsible: true`, added only when there is at least one suggestion.[^south-region]

### "Create index…" reuses the shared DDL preview dialog

The button hands `(schema, relation, columns)` up to a new `SqlAdminController.createSuggestedIndex`, which fetches the table's columns, builds the existing [`IndexForm`](frontend/src/dock/IndexForm.ts) with the suggested ones pre-checked, and opens `openSqlPreviewDialog` with `previewIndex` + `executeDdl` — the same three calls `createIndex` already makes at [`SqlAdminController.ts:1123`](frontend/src/SqlAdminController.ts#L1123).

The statement that actually runs is therefore always the backend's `ddl.create_index` output ([`ddl.py:576`](backend/app/sql/ddl.py#L576)), edited or not. The `CREATE INDEX` text the advisor shows in its table is a **preview only**; the dialog's editable SQL editor is where a user copies or adjusts it.[^ddl-two-sources]

---

## Public API

### `frontend/src/data/planPredicates.ts` (new)

```ts
/** How a predicate uses a column: `=`/`= ANY` versus an ordered comparison. */
export type PredicateRole = "equality" | "range";

/** A column reference read out of plan text, with its alias qualifier when present. */
export interface ColumnRef {
    alias?: string;
    column: string;
}

/** A column reference plus the role the predicate used it in. */
export interface PredicateRef extends ColumnRef {
    role: PredicateRole;
}

/** Read the indexable column references out of a Filter / Index Cond / Hash Cond /
 *  Merge Cond / Join Filter text. Returns `[]` for a condition with a top-level OR
 *  and for any conjunct that is not a bare column comparison. */
export function parseConditionColumns(condition: string): PredicateRef[];

/** Read the column references out of a "Sort Key" array, stripping ASC/DESC and
 *  NULLS FIRST/LAST. Returns `[]` if any term is not a bare column reference. */
export function parseSortKeyColumns(sortKey: string[]): ColumnRef[];
```

### `frontend/src/data/suggestIndexes.ts` (new)

```ts
import type { TableStructure } from "../contract";
import type { ExplainPlanNode } from "./parseExplainPlan";

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

/** The map key a structure is looked up under: `${schema}.${relation}`. */
export function relationKey(schema: string, relation: string): string;

/** Walk the plan and emit one candidate per relation that passed its heuristic's gate. */
export function collectIndexCandidates(roots: ExplainPlanNode[]): IndexCandidate[];

/** Drop every candidate whose columns are a leading prefix of an existing index or
 *  PK/unique constraint, and every candidate with no entry in `structures`. */
export function rejectCoveredCandidates(
    candidates: IndexCandidate[],
    structures: Map<string, TableStructure>,
): IndexCandidate[];

/** Sort, truncate to MAX_SUGGESTIONS, and assign `id` + `ddl`. */
export function rankCandidates(candidates: IndexCandidate[]): IndexSuggestion[];

/** The `CREATE INDEX` preview text for a candidate. */
export function suggestionDdl(candidate: IndexCandidate): string;

/** collect -> fetch each relation's structure -> reject covered -> rank. */
export function resolveIndexSuggestions(
    roots: ExplainPlanNode[],
    load: LoadTableStructure,
): Promise<IndexSuggestion[]>;

/** One row per suggestion, in ranked order. */
export function buildIndexSuggestionRows(suggestions: IndexSuggestion[]): IndexSuggestionRow[];
```

### `frontend/src/data/parseExplainPlan.ts` (added fields)

```ts
export interface ExplainPlanNode {
    // ...existing fields unchanged...

    /** "Schema" — the scanned relation's schema; VERBOSE only. */
    schema?: string;
    /** "Alias" — the relation's alias in the query, which plan predicates qualify with. */
    alias?: string;
    /** "Parent Relationship" — e.g. "Outer", "Inner", "SubPlan". */
    parentRelationship?: string;

    /** "Filter" — the residual qualifier applied after the scan. */
    filter?: string;
    /** "Rows Removed by Filter" — analyze only. */
    rowsRemovedByFilter?: number;
    /** "Index Cond" — the qualifier an index scan pushed into the index. */
    indexCond?: string;
    /** "Hash Cond" — a Hash Join's join qualifier. */
    hashCond?: string;
    /** "Merge Cond" — a Merge Join's join qualifier. */
    mergeCond?: string;
    /** "Join Filter" — a join qualifier not usable as the join method's own condition. */
    joinFilter?: string;
    /** "Sort Key" — the sort expressions of a Sort node. */
    sortKey?: string[];
}
```

### `frontend/src/data/fkCardinality.ts` (renamed export)

```ts
/** True when `columns` is a leading prefix of some index's or PK/unique constraint's
 *  own column list — i.e. a lookup on `columns` can use that index's B-tree. */
export function isColumnPrefixIndexed(columns: string[], structure: TableStructure): boolean;
```

### `frontend/src/data/sql.ts` (newly exported)

```ts
/** Quote a SQL identifier: wrap in double quotes, doubling any embedded quote. */
export function quoteIdent(name: string): string;
```

### `frontend/src/data/explain.ts` (added field)

```ts
export interface ExplainOptions {
    analyze: boolean;
    format: ExplainFormat;
    /** Ask for `EXPLAIN (VERBOSE …)`, which adds each scan's "Schema" and
     *  alias-qualifies every predicate column. Defaults to false. */
    verbose?: boolean;
}
```

### `frontend/src/dock/IndexSuggestionsView.ts` (new)

```ts
/** The suggestions strip: a "Create index…" toolbar over a table of suggestions. */
declare class IndexSuggestionsView extends Panel {
    constructor(suggestions: IndexSuggestion[], onCreateIndex: (suggestion: IndexSuggestion) => void);
}
```

Exported through `callable()` under the class name, per [`COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) section (d).

### `frontend/src/dock/ExplainDiagramPanel.ts` (added constructor argument)

```ts
/** Already-computed suggestions plus the click handler for the strip's Create button. */
export interface ExplainAdvisorInput {
    suggestions: IndexSuggestion[];
    onCreateIndex: (suggestion: IndexSuggestion) => void;
}

declare class ExplainDiagramPanel extends Panel {
    constructor(
        roots: ExplainPlanNode[],
        summary: ExplainSummary,
        layout: AccordionLayoutBinding,
        advisor?: ExplainAdvisorInput,
    );
}
```

### `frontend/src/dock/QueryPanel.ts` (added option)

```ts
/** What the panel needs to compute index suggestions and act on one. */
export interface IndexAdvisorHooks {
    loadTableStructure: LoadTableStructure;
    onCreateIndex: (schema: string, relation: string, columns: string[]) => void;
}

export interface QueryPanelOptions {
    // ...existing fields unchanged...
    /** Enables the index advisor. Omitted when the controller has no database name,
     *  in which case no suggestions are computed and no strip is shown. */
    indexAdvisor?: IndexAdvisorHooks;
}
```

### `frontend/src/dock/IndexForm.ts` (added constructor argument)

```ts
declare class IndexForm extends Panel {
    constructor(schema: string, table: string, columns: string[], initiallySelected?: string[]);
}
```

### `frontend/src/SqlAdminController.ts` (new method)

```ts
/** Open the CREATE INDEX dialog for an advisor suggestion, with the suggested
 *  columns pre-checked. Fetches the table's full column list for the checklist. */
private createSuggestedIndex(schema: string, table: string, columns: string[]): Promise<void>;
```

### `backend/app/operations/explain_query.py`

```python
def _explain_options(analyze: bool, verbose: bool, fmt: str) -> str:
    """Assemble the EXPLAIN option list, e.g. "ANALYZE, VERBOSE, FORMAT JSON"."""


class ExplainQueryCommand(Command):
    def __init__(
        self,
        conn: asyncpg.Connection,
        sql: str,
        analyze: bool,
        fmt: str,
        verbose: bool = False,
    ) -> None: ...
```

---

## Internal Structure

### Evidence and the heuristics

The walk visits every node with its parent. Each heuristic emits evidence only when its **gate node** — named per heuristic below — passes the size gate that follows.

| Heuristic | Fires on | Evidence | Gate node | Reason string |
|---|---|---|---|---|
| Seq-scan filter | `Seq Scan` with `filter` and `relationName` | each recognised conjunct of `filter`, attributed to this node's own relation | the `Seq Scan` itself | `Seq Scan filter on status, total` |
| Sort key | `Sort` with `sortKey`, whose keys all resolve to one `Seq Scan` relation beneath it | each sort key, role `sort` | the `Sort` itself | `Sort on created_at` — or `Top-N sort on created_at` when the parent is `Limit` |
| Join condition | `Hash Join` / `Merge Join` / `Nested Loop` with `hashCond` / `mergeCond` / `joinFilter` | each side that resolves to a `Seq Scan` relation beneath the join | that side's `Seq Scan`, not the join node | `Hash Join condition on customer_id` |
| Composite | not a separate pass — falls out of grouping several roles' evidence onto one relation | — | — | — |

Alias resolution uses a per-subtree map from `alias ?? relationName` to the scan node that produced it:

- On a `Seq Scan`'s own `Filter`, an unqualified reference belongs to that scan's relation; a reference qualified with a *different* alias is dropped (it is a correlated reference to an outer relation).
- In a join condition or a sort key, an unqualified reference is dropped as ambiguous, and a qualified one is dropped unless its alias resolves to a `Seq Scan` in that node's subtree.
- A `Sort` whose keys resolve to more than one relation produces nothing — one single-table index cannot serve it.

### The size gate

```ts
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
```

Every constant is tunable; these are first-cut values chosen to keep small tables and toy queries silent.[^thresholds]

Each gate node gets a weight:

```ts
/** A node's "work" figure, and which scale it is on. */
interface NodeWeight {
    /** Rows read (measured) or estimated total cost. */
    value: number;
    /** True when `value` is a measured row count, false when it is an estimated cost. */
    measured: boolean;
}
```

- **Measured** (`actualRows` present): `value = (actualRows + (rowsRemovedByFilter ?? 0)) * (actualLoops ?? 1)`. Passes when `value >= MIN_SCANNED_ROWS`.
- **Estimated** (no `actualRows`): `value = totalCost`, except that a node whose `parentRelationship` is `"Inner"` under a `Nested Loop` takes the `Nested Loop`'s own `totalCost` instead, since the child's estimate is per-loop and does not include the repetition. Passes when `value >= MIN_ESTIMATED_COST`.

Two extra rules on top of the gate:

- A `Seq Scan` filter also needs `rowsRemovedByFilter / (rowsRemovedByFilter + actualRows) >= MIN_DISCARD_RATIO` — measured runs only; the estimated path cannot compute it and skips the check.
- A `Sort` whose immediate parent is a `Limit` skips the size gate entirely: a top-N query is worth an ordered index at any table size.

### Ranking

A candidate's `rowsScanned` and `cost` are the maxima over its contributing nodes — the gate nodes that produced its evidence, whose ids are kept in `nodeIds`. Candidates sort by `rowsScanned` when it is present and by `cost` otherwise; within one plan every node either carries measured rows or none does, so the whole list is on one scale.

Ties break on the contributing-node count descending, then on `${schema}.${relation}` ascending, so the order is stable.

| Candidate | Rows scanned | Cost | Nodes | Place | Why |
|---|---|---|---|---|---|
| `orders (status, created_at)` | 100000 | 2100 | 2 | 1 | most rows scanned; wins the tie on node count |
| `line_items (order_id)` | 100000 | 3400 | 1 | 2 | ties on rows, loses on node count — the higher cost does not rescue it |
| `shipments (order_id)` | 40000 | 900 | 1 | 3 | fewer rows scanned |
| `regions (code)` | 900 | 40 | 1 | — | never reaches ranking: gated out at collection |

### The suggestions strip

`IndexSuggestionsView` is a Border-layout `Panel`:

- **NORTH** — a `ToolBar` holding one `glyphButton("plus", CONSTRUCTIVE_COLOR, "Create index…", …)`, disabled until a row is selected.
- **CENTER** — a `MemoryStore`-backed `Table` over `buildIndexSuggestionRows(...)`, columns `Index`, `Why`, `Rows scanned`, `Cost`, with `appendUnlisted: false` so the `id` field stays off the table while the record still carries it (the same arrangement as `STEP_COLUMNS` in [`ExplainDiagramPanel.ts:111`](frontend/src/dock/ExplainDiagramPanel.ts#L111)).

The panel is pinned to a fixed height (`SUGGESTIONS_HEIGHT = 140`) as both `minSize` and `preferredSize`, the way the Plan-steps table is.

---

## Ordered Implementation Steps

1. **`backend/app/operations/explain_query.py`** — add a module-level `_explain_options(analyze, verbose, fmt) -> str` that joins `"ANALYZE"`, `"VERBOSE"`, and `f"FORMAT {fmt.upper()}"` with `", "`, skipping the flags that are off. Add a `verbose: bool = False` parameter to `__init__` ([line 43](backend/app/operations/explain_query.py#L43)), store it as `self._verbose`, and replace the inline option string in `apply()` ([line 79](backend/app/operations/explain_query.py#L79)) with a call to the new helper. Update the module docstring to mention the flag.

2. **`backend/tests/test_explain_query.py`** — add four `_explain_options` cases: no flags, analyze only, verbose only, both. Follows the file's existing no-database, pure-logic style.

3. **`backend/app/main.py`** — pass `bool(body.get("verbose", False))` as the fifth argument at [line 859](backend/app/main.py#L859) and document the field in the route docstring's `Args`.

   Checkpoint: `cd backend && poetry run pytest` green.

4. **`frontend/src/data/explain.ts`** — add the optional `verbose` field to `ExplainOptions` ([line 12](frontend/src/data/explain.ts#L12)).

5. **`frontend/src/data/api.ts`** — send `verbose: opts.verbose ?? false` from `runExplain` ([line 320](frontend/src/data/api.ts#L320)).

6. **`frontend/src/data/parseExplainPlan.ts`** — add the ten fields listed in `## Public API` to `ExplainPlanNode` ([line 9](frontend/src/data/parseExplainPlan.ts#L9)) and read them in `parseNode` ([line 115](frontend/src/data/parseExplainPlan.ts#L115)) with the existing `num` / `stringArray` helpers plus a `str` helper for the string fields. `alias` is now stored as well as passed to `nodeLabel`. No existing field or behaviour changes.

7. **`frontend/tests/data/parseExplainPlan.test.ts`** — add a case asserting each new field is captured, and a case asserting each is `undefined` when the source omits it.

8. **`frontend/src/data/sql.ts`** — export `quoteIdent` ([line 13](frontend/src/data/sql.ts#L13)) and extend the file header to say it is shared with the advisor's preview DDL.

9. **`frontend/src/data/fkCardinality.ts`** — rename `isFkCovered` to `isColumnPrefixIndexed` ([line 200](frontend/src/data/fkCardinality.ts#L200)), rewrite its doc comment in generic terms (columns, not FK columns), rename its parameter `fkColumns` to `columns`, and update the one call site at [line 303](frontend/src/data/fkCardinality.ts#L303). No behaviour change.

10. **`frontend/tests/data/fkCardinality.test.ts`** — update the import and the `describe` label to the new name.

    Checkpoint: `cd frontend && npm run typecheck && npm test` green; `grep -rn 'isFkCovered' frontend/` — zero matches.

11. **Create `frontend/src/data/planPredicates.ts`** — the condition/sort-key readers from `## Public API`. Write the header comment in the style of `fkCardinality.ts`: pure, DOM-free, and explicit about what it refuses to parse. Implement in this order: a quote- and paren-aware top-level splitter (reject the whole condition on a depth-0 `OR`), a column-reference matcher, an operator-to-role map, and `parseSortKeyColumns` reusing the identifier grammar.

12. **Create `frontend/tests/data/planPredicates.test.ts`** — one `it` per row of the extraction table in `## Architecture Decisions`, plus a sort-key case with `DESC` / `NULLS LAST` and one with an expression term.

13. **Create `frontend/src/data/suggestIndexes.ts`** — the constants, `NodeWeight`, the alias map, the three detections, grouping (which is what produces composite suggestions), column ordering, `rejectCoveredCandidates` (calling `isColumnPrefixIndexed`), `rankCandidates`, `suggestionDdl` (calling `quoteIdent`), `buildIndexSuggestionRows`, and `resolveIndexSuggestions`. `resolveIndexSuggestions` collects the distinct relation keys, calls `load` for each under `Promise.allSettled`, builds the structure map from the fulfilled ones only, then rejects and ranks.

14. **Create `frontend/tests/data/suggestIndexes.test.ts`** — the five fixtures from `## Expected Behaviour`, each built from a hand-written plan-node literal in the style of `buildPlanSteps.test.ts`'s `node()` helper, plus a fake `LoadTableStructure`.

    Checkpoint: `cd frontend && npm test` green with the new suites.

15. **Create `frontend/src/dock/IndexSuggestionsView.ts`** — the Border-layout panel from `## Internal Structure`. Class-first: build the toolbar and the table as locals before `super()`, wire the table's `"selection"` listener after. Register the `plus` glyph at module scope, as `StructurePanel.ts` does. Export through `callable()`.

16. **`frontend/src/dock/ExplainDiagramPanel.ts`** — export `ExplainAdvisorInput`, add the optional fourth constructor parameter ([line 150](frontend/src/dock/ExplainDiagramPanel.ts#L150)), and build an `IndexSuggestionsView` as a local before `super()` when `advisor` is set and `advisor.suggestions.length > 0`. Add it to the `components` array at [line 218](frontend/src/dock/ExplainDiagramPanel.ts#L218) as `{ placement: Placement.SOUTH, collapsible: true }`. Extend the file header to describe the strip.

17. **`frontend/src/dock/QueryPanel.ts`** — export `IndexAdvisorHooks`, add `indexAdvisor?: IndexAdvisorHooks` to `QueryPanelOptions` ([line 129](frontend/src/dock/QueryPanel.ts#L129)) and to the destructuring at [line 222](frontend/src/dock/QueryPanel.ts#L222). In `showDiagram` ([line 674](frontend/src/dock/QueryPanel.ts#L674)): pass `verbose: true` to `runExplain`; after the `roots.length === 0` guard, when `indexAdvisor` is set, `await resolveIndexSuggestions(roots, indexAdvisor.loadTableStructure)`, re-check the `seq !== runSeq` guard, and build the `ExplainAdvisorInput`; pass it through `showDiagramTab` ([line 723](frontend/src/dock/QueryPanel.ts#L723)) to the panel constructor. Extend the closing `notify(...)` with `", N index suggestion(s)"` or `", no index suggestions"` when the advisor ran, and leave it unchanged when it did not.

18. **`frontend/src/dock/IndexForm.ts`** — add the optional `initiallySelected` parameter ([line 35](frontend/src/dock/IndexForm.ts#L35)) and forward it to `ColumnChecklist`, which already accepts it ([`ColumnChecklist.ts:28`](frontend/src/dock/ColumnChecklist.ts#L28)).

19. **`frontend/src/SqlAdminController.ts`** — add the private `createSuggestedIndex(schema, table, columns)` described in `## Public API`, modelled on `createIndex` ([line 1123](frontend/src/SqlAdminController.ts#L1123)) but fetching the column list with `getColumns(ref)` and reporting a fetch failure through `notifyError(err, ref)`. In `openQuery` ([line 2316](frontend/src/SqlAdminController.ts#L2316)), pass `indexAdvisor` — built only when `this._database !== undefined` — with `loadTableStructure` bound to `getStructure({ connectionId, database, schema, name: relation, kind: "table" })` and `onCreateIndex` bound as `(schema, relation, columns) => void this.createSuggestedIndex(schema, relation, columns)` — the `void` discards the promise, matching how `onSave` wraps `promptAndSaveQuery` in the same options bag.

    Checkpoint: `cd frontend && npm run typecheck` clean.

20. **`README.md`** per `## Documentation Impact`.

21. **Verification** per `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/data/planPredicates.ts` |
| Create | `frontend/src/data/suggestIndexes.ts` |
| Create | `frontend/src/dock/IndexSuggestionsView.ts` |
| Create | `frontend/tests/data/planPredicates.test.ts` |
| Create | `frontend/tests/data/suggestIndexes.test.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/data/api.ts` |
| Modify | `frontend/src/data/explain.ts` |
| Modify | `frontend/src/data/fkCardinality.ts` |
| Modify | `frontend/src/data/parseExplainPlan.ts` |
| Modify | `frontend/src/data/sql.ts` |
| Modify | `frontend/src/dock/ExplainDiagramPanel.ts` |
| Modify | `frontend/src/dock/IndexForm.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/tests/data/fkCardinality.test.ts` |
| Modify | `frontend/tests/data/parseExplainPlan.test.ts` |
| Modify | `backend/app/main.py` |
| Modify | `backend/app/operations/explain_query.py` |
| Modify | `backend/tests/test_explain_query.py` |
| Modify | `README.md` |

---

## Expected Behaviour

### Unit-testable — `parseConditionColumns` / `parseSortKeyColumns`

1. `(o.status = 'active'::text)` yields one `{alias: "o", column: "status", role: "equality"}`.
2. `((o.status)::text = 'x'::text)` yields the same — the cast-wrapping parentheses and the `::text` suffix are stripped.
3. `((o.status = 'x'::text) AND (o.total > 100))` yields `status` equality and `total` range, in that order.
4. `(o.customer_id = c.id)` yields two equality refs, `o.customer_id` and `c.id`.
5. `(o.status = ANY ('{a,b}'::text[]))` yields `status` equality.
6. `((o.a = 1) OR (o.b = 2))` yields `[]`.
7. `(lower((o.email)::text) = 'x'::text)` yields `[]`.
8. `(o.status <> 'x'::text)` yields `[]`.
9. `(status = 'x'::text)` yields `{column: "status"}` with no `alias`.
10. `parseSortKeyColumns(["o.created_at DESC", "o.id"])` yields `created_at` then `id`, both aliased `o`.
11. `parseSortKeyColumns(["(o.total * 2)"])` yields `[]`.

### Unit-testable — `collectIndexCandidates` / `resolveIndexSuggestions`

12. **Seq scan with a selective filter.** `Seq Scan` on `public.orders`, `Filter: (o.status = 'shipped'::text)`, `Actual Rows: 500`, `Rows Removed by Filter: 99500` → one candidate, columns `["status"]`, reason `Seq Scan filter on status`, `rowsScanned` 100000.
13. **Sort before a limit.** `Limit → Sort (Sort Key: ["o.created_at DESC"]) → Seq Scan on public.orders`, every node reporting `Actual Rows: 50` → one candidate, columns `["created_at"]`, reason `Top-N sort on created_at`. The tiny row count does not gate it out.
14. **Sort with no limit, small input.** The same tree without the `Limit` parent, the `Sort` still at `Actual Rows: 50` → no candidate.
15. **Join with no index on one side.** `Hash Join (Hash Cond: (o.customer_id = c.id))` over `Seq Scan on public.orders` (alias `o`, `Actual Rows: 200000`) and `Hash → Seq Scan on public.customers` (alias `c`, `Actual Rows: 300`) → one candidate for `orders`, columns `["customer_id"]`, reason `Hash Join condition on customer_id`; `customers` is gated out by row count.
16. **Composite predicate.** `Sort (Sort Key: ["o.created_at"], Actual Rows: 10000) → Seq Scan on public.orders, Filter: ((o.status = 'x'::text) AND (o.total > 100)), Actual Rows: 10000, Rows Removed by Filter: 90000` → **one** candidate for `orders` with columns `["status", "created_at", "total"]` and two reasons in plan order, `Sort on created_at` then `Seq Scan filter on status, total`.
17. **Already indexed.** Fixture 12's plan, with a `LoadTableStructure` returning an index `CREATE INDEX ix ON public.orders USING btree (status)` → `resolveIndexSuggestions` returns `[]`.
18. **Partially indexed.** Fixture 16's plan with an existing `btree (status)` → the composite candidate survives, since `["status","created_at","total"]` is not a prefix of `["status"]`.
19. **Unknown structure.** Fixture 12's plan with a `LoadTableStructure` that rejects → `resolveIndexSuggestions` returns `[]`.
20. **No schema.** Fixture 12's plan with `Schema` absent from the scan node → no candidate.
21. **Ranking and truncation.** Six candidates over the gate → `rankCandidates` returns five, ordered by `rowsScanned` descending.
22. **`suggestionDdl`.** A candidate for `public.orders` with columns `["status", "created_at"]` renders `CREATE INDEX ON "public"."orders" ("status", "created_at")`.
23. **`buildIndexSuggestionRows`.** A suggestion with two reasons renders `Why` as the two phrases joined with `"; "`, and omits `Rows scanned` entirely when the suggestion has none.

### Unit-testable — `_explain_options` (pytest)

24. `(False, False, "text")` → `"FORMAT TEXT"`; `(True, False, "json")` → `"ANALYZE, FORMAT JSON"`; `(False, True, "json")` → `"VERBOSE, FORMAT JSON"`; `(True, True, "json")` → `"ANALYZE, VERBOSE, FORMAT JSON"`.

### Manual verification

25. Against the demo database, run `SELECT * FROM sales.orders WHERE status = 'shipped'` (or any seeded table large enough to clear the gate), press Explain, then "Explain diagram". The Diagram tab opens with a suggestions strip below the diagram, and the status line reports the suggestion count.
26. Selecting a suggestion enables "Create index…"; clicking it opens the "Create index" dialog with the suggested columns already checked and a generated `CREATE INDEX` in the preview editor.
27. Executing the dialog creates the index. Re-running Explain and "Explain diagram" on the same statement no longer offers that suggestion.
28. A query over a small, fully-indexed table produces no strip at all, and the status line reads "no index suggestions".
29. The strip's collapse chevron tucks it away and hands its height back to the diagram; the WEST accordion's own collapse and its saved section sizes still work.
30. The Explain (text) tab, the JSON plan export, and the plain Run path are unchanged.

---

## Verification

- `cd backend && poetry run pytest` — the extended `test_explain_query.py` and the rest green.
- `cd frontend && npm run typecheck` — clean. Every changed signature gained only a trailing optional parameter or a new optional field, so existing call sites keep compiling.
- `cd frontend && npm test` — the two new suites plus the extended `parseExplainPlan` and `fkCardinality` suites green.
- `cd frontend && npm run build` — `tsc --noEmit` plus a production Vite build.
- `grep -rn 'isFkCovered' frontend/` — zero matches.
- `grep -rn 'CREATE INDEX ON' frontend/src/` — matches only `suggestIndexes.ts`'s `suggestionDdl`; the executed statement still comes from the backend. (Six unrelated `CREATE INDEX` mentions already exist in comments, so the grep needs the `ON`.)
- Manual cases 25-30. Entry point: `npm run dev` in `frontend` with the backend running, log in against the demo database, and use the SQL workspace's Explain and "Explain diagram" toolbar buttons.

---

## Documentation Impact

- **`README.md`** — extend the **SQL workspace** bullet under `## Highlights`: after `EXPLAIN` a statement, the plan diagram carries a heuristic index advisor that reads the plan for sequential scans with selective filters, sorts an index could serve, and join columns with no index, then offers the matching `CREATE INDEX` — cross-checked against the table's existing indexes, and executed through the same preview dialog as every other DDL action. Say plainly that the advice is heuristic and is not validated against a hypothetical cost estimate.
- **`CHANGELOG.md`** — no entry; changelog text is written at release time, per [`release-steps.md`](release-steps.md).
- **`TODO.md`** — no change. The existing "Surface unindexed foreign keys as a diagnostic" bullet is about schema-wide FK coverage reporting, which this plan does not touch.
- **`frontend/COMPONENT_CONVENTIONS.md`** — no change. `IndexSuggestionsView` follows the existing class-first `extends Panel` form.
- **`backend/README.md`** — no change. The layout list is per-module and gains no module.

---

## Potential Challenges

- **`VERBOSE` inflates the plan payload.** Every node gains an `Output` array of its target-list expressions. `parseExplainPlan` ignores unknown fields, so nothing breaks; the cost is transfer size on a wide `SELECT *`. Only the diagram fetch sets the flag — the JSON export path does not.
- **String literals can hide an `AND` or a comma.** `Filter: (o.note = 'a AND b')` would mis-split under a naive scan. The splitter tracks single-quote state (with `''` as the escape) as well as paren depth; a literal containing an unbalanced quote still mis-splits, and the result is a dropped conjunct, never a wrong column.
- **A quoted identifier containing a dot defeats alias splitting.** `"my.col"` is read as alias `"my` plus column `col"`, which resolves to no known alias and is therefore dropped. Conservative, not wrong.
- **A cast can make a suggested index unusable.** `((o.code)::text = 'x'::text)` yields a plain `code` candidate, and for a non-binary-coercible column type the planner would not use a plain B-tree on it. This is a known false positive; the preview dialog is where a user catches it.
- **`IS NULL`, `LIKE`, and `<>` are ignored.** All three can be served by an index in the right circumstances (a partial index, `text_pattern_ops`, a low-selectivity negation). Recognising them would mean emitting index kinds the advisor cannot express, so they are dropped.
- **Partitioned tables and temp tables.** A plan can scan a partition or a temp relation whose `/structure` fetch fails or returns nothing useful. The "no structure, no suggestion" rule drops those relations silently.
- **Two round trips before the strip appears.** The diagram fetch is followed by one `/structure` request per distinct relation, all issued together under `Promise.allSettled`. The `seq !== runSeq` guard is re-checked after the awaits, so a newer run still wins.
- **The controller may have no database name.** `SqlAdminController._database` is optional, and `getStructure` needs it in the URL. The advisor hooks are simply not passed in that case, and the panel behaves exactly as it does today.

---

## Critical Files

Read before starting:

- [`frontend/src/data/parseExplainPlan.ts`](frontend/src/data/parseExplainPlan.ts) — the node model being extended, and the `num`/`stringArray`/`isObject` helpers the new fields reuse.
- [`frontend/src/data/fkCardinality.ts`](frontend/src/data/fkCardinality.ts) — the precedent this plan's approach mirrors: index-coverage analysis as a pure frontend module. `parseIndexColumns` and the renamed `isColumnPrefixIndexed` are consumed directly.
- [`frontend/src/data/buildPlanSteps.ts`](frontend/src/data/buildPlanSteps.ts) — the row-shape-as-table-columns convention `IndexSuggestionRow` copies.
- [`frontend/src/dock/ExplainDiagramPanel.ts`](frontend/src/dock/ExplainDiagramPanel.ts) — the Border regions, the steps table's `ColumnSpec`, and the pre-`super()` local-building discipline.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) lines 666-740 — `showDiagram` / `showDiagramTab`, the `runSeq` guard, and the busy-button handling the advisor runs inside.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) lines 1117-1157 and 2303-2340 — `createIndex`/`dropIndex` as the model for `createSuggestedIndex`, and `openQuery` as the wiring site.
- [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts) — the form + editable-preview + execute/retry contract the Create action plugs into.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — sections (b), (c), and (d) govern `IndexSuggestionsView`.
- [`backend/app/operations/explain_query.py`](backend/app/operations/explain_query.py) — the option assembly and the ANALYZE rollback the `verbose` flag slots into.

---

## Non-Goals

- **No HypoPG, and no cost re-estimation of any kind.** Nothing here creates a hypothetical index or re-runs `EXPLAIN` to measure a cost delta.[^hypopg]
- **No index kinds beyond a plain multi-column B-tree.** No expression indexes, no partial indexes, no `USING gin`/`gist`, no `INCLUDE` columns, no operator classes. The dialog lets a user add a method by hand.
- **No advice about dropping unused or redundant indexes.** The advisor only adds.
- **No schema-wide or database-wide scan.** Suggestions come from one plan, on demand. Reporting every unindexed foreign key across a schema is a separate backlog item in `TODO.md`.
- **No suggestions from the plain Explain (text) tab.** They ride the "Explain diagram" action, which is the only path that already fetches a JSON plan.
- **No persistence.** Suggestions are recomputed per diagram build; nothing is stored, dismissed, or remembered.
- **No dedicated clipboard button.** The DDL text is a table column, and the preview dialog's editable SQL editor is the copy/edit surface.

---

## Addendum: HypoPG cost validation (future follow-up)

Not part of this plan. Recorded here so the shape is not re-derived later.

[HypoPG](https://github.com/HypoPG/hypopg) is a Postgres extension that creates *hypothetical* indexes — catalog entries the planner can see but that hold no data and cost nothing to build. It turns the advisor's guesses into measurements:

1. Probe once per session: `SELECT 1 FROM pg_extension WHERE extname = 'hypopg'`.
2. For each suggestion, inside a transaction that is always rolled back: `SELECT hypopg_create_index('CREATE INDEX ON …')`, re-run the user's statement as plain `EXPLAIN (FORMAT JSON)` (never `ANALYZE` — a hypothetical index cannot be executed against), read the new root `Total Cost`, then `hypopg_reset()`.
3. Report the delta beside each suggestion, and drop any suggestion the planner declines to use or that improves the cost by less than some percentage.

Two things make this a natural follow-up rather than part of the first cut. It needs a backend operation of its own — several statements per suggestion, all inside one rolled-back transaction, which is server-side work by nature — so it does not fit the "backend fetches, frontend derives" split this plan follows. And most managed Postgres hosts do not ship the extension, so the heuristic path has to keep working unchanged and be the fallback whenever the probe comes back empty. The fallback is exactly what this plan builds: the follow-up adds a "validated" column and a stricter filter on top, and changes nothing about how candidates are found.

---

## Notes

[^frontend-analysis]: A backend `SuggestIndexesCommand` was the alternative, and it has one real advantage — it could fetch the plan and the catalog in a single request on one connection. It was rejected on precedent and on test economics. The EXPLAIN feature's backend half deliberately does no interpretation: `ExplainQueryCommand` hands the plan tree through untouched, and five frontend modules read it. Putting a second, Python implementation of plan reading beside them would split the plan-comprehension logic across two languages, with `fkCardinality.ts`'s existing index-coverage code on the TypeScript side and the new predicate parsing on the Python side. The frontend also already holds the parsed tree at the moment the advisor needs it, so the analysis costs no extra EXPLAIN. The one thing the backend genuinely owns — reading `pg_indexes` — is already exposed by the `/structure` route the FK diagram uses.

[^verbose]: The alternative was a backend query that resolves a bare relation name to a schema through `pg_class` + `pg_table_is_visible`. `VERBOSE` is better on correctness, not just on effort: the planner has *already* resolved the name through the session's `search_path`, so its answer is the right one by construction, while re-resolving afterwards can pick a different relation when two schemas hold the same table name or when a temp table shadows a permanent one. `VERBOSE` also forces Postgres to alias-qualify every scan qualifier (`show_scan_qual` sets `useprefix` when `es->verbose`), which removes the whole class of ambiguity the predicate reader would otherwise face on single-table queries. The flag is opt-in rather than always-on for `FORMAT JSON`, so the user-facing JSON plan export keeps producing exactly the payload it does today.

[^one-per-relation]: Emitting one suggestion per plan node was the obvious alternative and produces noise: a five-way join over one heavily filtered fact table would offer the same table three times with overlapping column lists. Grouping also gives the composite heuristic for free — it is not a separate detection pass, just what happens when a relation contributes both a filter column and a sort key — and it gives the "how often does this table get scanned" signal a natural home as the contributing-node count in the ranking tie-break.

[^column-order]: A B-tree can use its columns left to right only as long as each one is constrained by equality. The first range predicate ends that: everything after it is unusable for further lookup, and the index's stored order no longer matches the query's `ORDER BY`. So equality columns must lead, and a sort column must come before any range column if the index is to serve the sort at all. Placing sort *after* range — the other candidate ordering — would leave the sort unserved in exactly the case the sort heuristic exists to fix. Within a group the order is first-seen rather than sorted: it is stable, cheap, and no better rule is available without column statistics the advisor does not read.

[^regex-parsing]: A real SQL expression parser was considered and rejected. Postgres's plan text is deparsed output, not user SQL — it is regular enough that a handful of patterns cover the shapes that matter, and any input that falls outside them is by definition an expression the advisor could not build a plain B-tree for anyway. So the parser's error mode and its "not indexable" mode are the same thing, and being conservative costs a missed suggestion rather than a wrong one. A grammar would also be a new dependency or a few hundred lines of new code, against `fkCardinality.ts`'s existing precedent of reading Postgres-generated SQL text with a small hand-rolled scanner (`parseIndexColumns` does exactly this for `indexdef`, and returns `null` on anything it does not recognise).

[^rename]: The function is generic already — nothing in its body knows about foreign keys — so the advisor either calls it under a misleading name, or duplicates six lines of prefix matching, or the name gets fixed. The rename touches three places: the declaration, one call site inside the same file, and the test's import and `describe` label. It is behaviour-preserving and mechanically checkable with a grep for the old name. Moving the function to a new shared module was the other option and was rejected as churn: `parseIndexColumns` would have to move with it, and both have their only other consumer inside `fkCardinality.ts`.

[^ride-diagram]: Surfacing suggestions from the plain Explain button would mean issuing a second, `FORMAT JSON` EXPLAIN on every Explain run — a real cost under `ANALYZE`, which re-executes the statement (rolled back, but still executed). The Diagram action already pays that cost for its own reasons, so the advisor rides it for free. The status-line message is what makes the feature discoverable from the Explain flow: it reports the suggestion count when the diagram opens.

[^south-region]: A fourth section in the WEST accordion was the first idea and fails on two counts. The column is pinned to 320px, which cannot show a `CREATE INDEX` statement, and adding a section changes `ACCORDION_DEFAULT_OPEN.explainDiagram` from three entries to four — `readOpen` requires an exact length match ([`layoutStore.ts:147`](frontend/src/data/layoutStore.ts#L147)), so every user's saved open flags for that site would be discarded on upgrade. A SOUTH region is full width, needs no layout-store change, and gets the same collapse chevron the WEST column already has.

[^ddl-two-sources]: The advisor renders a `CREATE INDEX` string for display and the backend renders one for execution, which is two generators for one statement. Collapsing them is not worth it either way round: asking the backend for a preview per suggestion means one `/ddl/table/index` round trip per row before anything can be shown, and executing the frontend's string would bypass `ddl.create_index`'s identifier quoting and method validation, which is the app's single authority for DDL text. Keeping the frontend string strictly a preview bounds the drift risk — both spell the same simple form, `CREATE INDEX ON "s"."t" ("a", "b")`, and both quote identifiers with the same rule, since `suggestionDdl` calls the `quoteIdent` in `sql.ts` that already exists as "the front-end mirror of the backend's `quote_ident`".

[^thresholds]: 1000 rows and cost 1000 are round numbers, not measurements, and the plan says so. The point of the gate is to stay silent on the small tables an admin tool spends most of its time in, where a sequential scan is genuinely the right plan and an index would only slow writes down. The 0.5 discard ratio is the other half of that: a scan that reads a million rows and keeps a million of them is not filtering, and an index would not help it. All five constants are module-level `const`s with comments, so tuning is a one-line change once the feature has been used against real plans.

[^hypopg]: See `## Addendum: HypoPG cost validation (future follow-up)` for the shape a later pass would take, including the fallback when the extension is absent.
