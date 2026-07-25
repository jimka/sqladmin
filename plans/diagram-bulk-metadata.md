# Bulk Diagram Metadata — Implementation Plan

## Overview

Opening a schema, database, or relation-rooted diagram builds the graph model on the frontend by fetching metadata one table at a time. [`buildSchemaGraphData`](frontend/src/SqlAdminController.ts#L1525) lists a schema's tables, then issues one `/structure` **and** one `/columns` request per table — `2N` requests for `N` tables ([SqlAdminController.ts:1535-1538](frontend/src/SqlAdminController.ts#L1535)). [`buildDatabaseGraphData`](frontend/src/SqlAdminController.ts#L1610) does the same per schema, `O(schemas × tables)`. For the seeded 154-table `hub` schema that is 308 requests; the browser caps a host at ~6 concurrent connections, so they drain in ~50 waves and the diagram cannot render until the last one lands.

This plan adds two bulk backend endpoints — one per schema, one per database — each returning the whole graph's metadata in a fixed, small number of catalog queries independent of table count. The frontend calls the matching endpoint **once** behind the panel spinner and feeds the result into the existing pure graph builders ([`buildSchemaDiagram`](frontend/src/data/buildSchemaDiagram.ts#L70), [`annotateFkCardinality`](frontend/src/data/fkCardinality.ts#L252), [`buildDatabaseDiagram`](frontend/src/data/buildDatabaseDiagram.ts#L64)) unchanged. The backend returns raw per-table structures + columns; the frontend keeps assembling the graph.

This shrinks **fetch** time (308 requests → 1). It does not touch the separate ~15s ELK layout pass that runs inside `DiagramView` after the data arrives — that is out of scope (see `## Non-Goals`).

---

## Architecture Decisions

### Bulk backend endpoint, not progressive client render

Add backend routes that return the whole diagram's metadata in one response; the frontend fetches once and renders behind the existing spinner.[^why-bulk] The rejected alternative — streaming tables into the diagram as they arrive — is a footnote, not an option the implementer chooses.[^why-not-progressive]

### Return raw structures + columns; frontend keeps assembling the graph

Each endpoint returns per-table `structure` (indexes/constraints/foreign keys) and, for the schema endpoint, `columns` — the exact inputs [`buildSchemaDiagram`](frontend/src/data/buildSchemaDiagram.ts#L70) and [`annotateFkCardinality`](frontend/src/data/fkCardinality.ts#L252) already consume. The graph-assembly, FK-cardinality, and card-mode code stays byte-for-byte unchanged.[^why-raw]

### One catalog query per facet, generalized to schema/database scope

Mirror the [`/structure` route](backend/app/main.py#L431), which runs three separate per-table queries ([indexes/constraints/foreign keys](backend/app/operations/table_structure.py)) and combines their results in the route. The new operations are those same queries with the per-table filter (`AND c.relname = $2`) removed and a `table` (and `schema`) column added, so one query returns every table's rows in a schema (or database). The route groups the rows by table via a pure assembly helper.[^why-not-one-megaquery] The database endpoint reuses the identical query classes with a null schema filter — see `## Public API`.

### Precedent

[`ListDependenciesQuery`](backend/app/operations/list_dependencies.py) is the in-repo model for a **schema-scoped** catalog query that returns many relations' rows in one round trip and shapes them in a pure `get_result`. The new queries follow its structure (schema-bound `$1`, row-wise `get_result`, offline-testable by hand-setting `_raw`). The [`/structure` route](backend/app/main.py#L431) is the model for combining several query results into one response dict.

---

## Public API

### Backend — new operation module `backend/app/operations/graph.py`

Five `Query` classes, each taking `schema: str | None` (a concrete schema restricts to it; `None` spans every non-system schema in the database) and binding two params: `$1 = schema`, `$2 = list(_SYSTEM_SCHEMAS)`. Each `get_result()` returns a **flat list of rows tagged with `schema` and `table`**, plus a `payload` dict holding exactly the per-table contract element the existing per-table query emits.

```python
_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema")  # reuse the list_schemas.py definition

class SchemaTablesQuery(Query):
    """Base-table names in scope (information_schema.tables, table_type <> 'VIEW')."""
    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None: ...
    async def apply(self) -> None: ...
    def get_result(self) -> list[dict]: ...   # [{"schema": str, "table": str}]

class SchemaColumnsQuery(Query):
    """Every base table's columns; payload is the ColumnMeta contract dict."""
    def get_result(self) -> list[dict]: ...   # [{"schema","table","payload": <ColumnMeta contract>}]

class SchemaIndexesQuery(Query):
    def get_result(self) -> list[dict]: ...   # [{"schema","table","payload": <index contract>}]

class SchemaConstraintsQuery(Query):
    def get_result(self) -> list[dict]: ...   # [{"schema","table","payload": <constraint contract>}]

class SchemaForeignKeysQuery(Query):
    def get_result(self) -> list[dict]: ...   # [{"schema","table","payload": <fk contract>}]
```

Two pure assembly helpers in the same module (offline-unit-tested):

```python
def assemble_schema_graph(
    tables: list[dict],       # [{"schema","table"}] — the authoritative node set
    columns: list[dict],
    indexes: list[dict],
    constraints: list[dict],
    foreign_keys: list[dict],
) -> list[dict]:
    """[{"name": str, "structure": {"indexes","constraints","foreignKeys"}, "columns": [...]}], one per table, sorted by name."""

def assemble_database_graph(
    tables: list[dict],
    indexes: list[dict],
    constraints: list[dict],
    foreign_keys: list[dict],
) -> list[dict]:
    """[{"schema": str, "tables": [{"name": str, "structure": {...}}]}], grouped by schema then table (no columns)."""
```

### Backend — new routes in `backend/app/main.py`

```
GET /api/{connection_id}/{database}/{schema}/graph   -> {"tables": [SchemaGraphTable]}
GET /api/{connection_id}/{database}/graph            -> {"schemas": [DatabaseGraphSchema]}
```

The schema route runs `SchemaTablesQuery`, `SchemaColumnsQuery`, `SchemaIndexesQuery`, `SchemaConstraintsQuery`, `SchemaForeignKeysQuery` with `schema=<segment>`, then `assemble_schema_graph`. The database route runs the same four **structure** queries (not columns) with `schema=None`, then `assemble_database_graph`. Both acquire one pooled connection via `session_pool_for(session, connection_id).acquire()`, exactly like `/structure`.

### Frontend — new contract types in `frontend/src/contract.ts`

```ts
/** One table's full graph metadata as returned by the schema-graph endpoint. */
export interface SchemaGraphTable {
    name: string;
    structure: TableStructure;
    columns: ColumnMeta[];
}

/** The schema-graph endpoint envelope: every base table's structure + columns. */
export interface SchemaGraph {
    tables: SchemaGraphTable[];
}

/** One schema's tables (structure only) inside the database-graph envelope. */
export interface DatabaseGraphSchema {
    schema: string;
    tables: { name: string; structure: TableStructure }[];
}

/** The database-graph endpoint envelope: every non-system schema's tables. */
export interface DatabaseGraph {
    schemas: DatabaseGraphSchema[];
}
```

### Frontend — new client functions in `frontend/src/data/api.ts`

```ts
/** Fetch a whole schema's ER graph metadata (every base table's structure + columns) in one request. */
export function getSchemaGraph(ref: DbObjectRef): Promise<SchemaGraph> {
    return getJson<SchemaGraph>(`/api/${ref.connectionId}/${ref.database}/${ref.schema}/graph`);
}

/** Fetch a whole database's ER graph metadata (every non-system schema's tables + structures) in one request. */
export function getDatabaseGraph(ref: DbObjectRef): Promise<DatabaseGraph> {
    return getJson<DatabaseGraph>(`/api/${ref.connectionId}/${ref.database}/graph`);
}
```

---

## Internal Structure

### The schema/database scope guard (every new query)

Each query's SQL is the existing per-table query with the `AND <rel> = $2` predicate replaced by one scope clause, and the namespace + relation names surfaced in the SELECT. `<ns>` is that query's namespace column (`n.nspname`, `c.table_schema`, `i.schemaname`, …):

```sql
AND ($1::text IS NULL OR <ns> = $1)   -- concrete schema restricts; NULL spans the database
AND <ns> <> ALL($2::text[])           -- always exclude pg_catalog / information_schema
```

Worked transform for `SchemaForeignKeysQuery` (from [`ListForeignKeysQuery`](backend/app/operations/table_structure.py#L169)): keep the whole SELECT/JOIN body; add `n.nspname AS schema, c.relname AS table` to the projection; replace `WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2` with:

```sql
WHERE con.contype = 'f'
  AND ($1::text IS NULL OR n.nspname = $1)
  AND n.nspname <> ALL($2::text[])
ORDER BY n.nspname, c.relname, con.conname
```

`SchemaIndexesQuery` and `SchemaConstraintsQuery` transform identically; note the indexes query's redundant `n.nspname = $1` join predicate becomes `n.nspname = i.schemaname` so the join stays correct across schemas.

`SchemaTablesQuery`:

```sql
SELECT table_schema AS schema, table_name AS table
FROM information_schema.tables
WHERE table_type <> 'VIEW'
  AND ($1::text IS NULL OR table_schema = $1)
  AND table_schema <> ALL($2::text[])
ORDER BY table_schema, table_name
```

### The columns query (the one delicate generalization)

[`ListColumnsQuery`](backend/app/operations/list_columns.py) keys three places on `$2` (the outer filter, the `pk` sub-select, and the `seq` sub-select), and its `seq` sub-select does `DISTINCT ON (l.attnum)`. Made schema/database-wide, every one of those must carry table identity or it will attribute one table's primary-key/sequence rows to another. The matview fallback (`_MATVIEW_SQL`) is **dropped** — the graph only includes base tables (`SchemaTablesQuery` excludes views/matviews), so a matview branch would be dead code here.

```sql
SELECT
    c.table_schema AS schema,
    c.table_name   AS table,
    c.column_name  AS name,
    c.data_type    AS data_type,
    (c.is_nullable = 'YES') AS nullable,
    COALESCE(
        c.is_identity = 'YES' OR c.is_generated = 'ALWAYS' OR c.column_default LIKE 'nextval(%',
        false
    ) AS is_generated,
    (c.column_default IS NOT NULL) AS has_default,
    COALESCE(pk.is_pk, false) AS is_primary_key,
    seq.sequence_schema AS sequence_schema,
    seq.sequence_name   AS sequence_name
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema
 AND t.table_name   = c.table_name
 AND t.table_type  <> 'VIEW'                         -- base tables only, same set as SchemaTablesQuery
LEFT JOIN (
    SELECT tc.table_schema, tc.table_name, kcu.column_name, true AS is_pk
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
     AND kcu.table_schema    = tc.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
) pk ON pk.table_schema = c.table_schema
    AND pk.table_name   = c.table_name
    AND pk.column_name  = c.column_name
LEFT JOIN (
    SELECT DISTINCT ON (rn.nspname, rc.relname, l.attnum)
           rn.nspname AS ref_schema,
           rc.relname AS ref_table,
           a.attname  AS column_name,
           sn.nspname AS sequence_schema,
           s.relname  AS sequence_name
    FROM (
        SELECT d.refobjid AS attrelid, d.refobjsubid AS attnum, d.objid AS seqid, 1 AS arm
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
          AND d.deptype IN ('a', 'i') AND d.refobjsubid > 0
        UNION ALL
        SELECT ad.adrelid, ad.adnum, d.refobjid, 2
        FROM pg_catalog.pg_depend d
        JOIN pg_catalog.pg_attrdef ad ON ad.oid = d.objid
        WHERE d.classid = 'pg_attrdef'::regclass AND d.refclassid = 'pg_class'::regclass
          AND d.deptype = 'n'
    ) l
    JOIN pg_catalog.pg_class s      ON s.oid = l.seqid AND s.relkind = 'S'
    JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
    JOIN pg_catalog.pg_class rc     ON rc.oid = l.attrelid
    JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
    JOIN pg_catalog.pg_attribute a  ON a.attrelid = l.attrelid AND a.attnum = l.attnum
    ORDER BY rn.nspname, rc.relname, l.attnum, l.arm DESC, sn.nspname, s.relname
) seq ON seq.ref_schema  = c.table_schema
     AND seq.ref_table   = c.table_name
     AND seq.column_name = c.column_name
WHERE ($1::text IS NULL OR c.table_schema = $1)
  AND c.table_schema <> ALL($2::text[])
ORDER BY c.table_schema, c.table_name, c.ordinal_position
```

`get_result()` builds a [`ColumnMeta`](backend/app/contract.py#L81) per row (as [`ListColumnsQuery`](backend/app/operations/list_columns.py#L157) does) and returns `{"schema", "table", "payload": meta.to_contract()}`, preserving `ordinal_position` order.

### Frontend consumer rewrite

[`buildSchemaGraphData`](frontend/src/SqlAdminController.ts#L1525) becomes one fetch + a positional unpack (the endpoint's per-object shape removes the current positional-pairing fragility between the two `Promise.all` arrays):

```ts
private async buildSchemaGraphData(ref: DbObjectRef, opts?: { withColumns?: boolean }): Promise<DiagramData | null> {
    try {
        const graph      = await getSchemaGraph(ref);
        const tables     = graph.tables.map(t => t.name);
        const structures = graph.tables.map(t => t.structure);
        const columns    = graph.tables.map(t => t.columns);

        const columnsByTable: Map<string, ColumnMeta[]> | undefined =
            opts?.withColumns ? new Map(graph.tables.map(t => [t.name, t.columns])) : undefined;

        return annotateFkCardinality(buildSchemaDiagram(tables, structures, columnsByTable), tables, structures, columns);
    } catch (err) {
        this.notifyError(err, ref);

        return null;
    }
}
```

[`buildDatabaseGraphData`](frontend/src/SqlAdminController.ts#L1610) becomes:

```ts
private async buildDatabaseGraphData(ref: DbObjectRef): Promise<SchemaTables[] | null> {
    try {
        const graph = await getDatabaseGraph(ref);

        return graph.schemas.map(s => ({
            schema    : s.schema,
            tables    : s.tables.map(t => t.name),
            structures: s.tables.map(t => t.structure),
        } satisfies SchemaTables));
    } catch (err) {
        this.notifyError(err, ref);

        return null;
    }
}
```

The relation-rooted caller ([`openRelationDiagram`](frontend/src/SqlAdminController.ts#L1642)) calls `buildSchemaGraphData(ref, { withColumns: true })` and needs **no change** — the endpoint always returns columns, and `withColumns` still only decides whether the card-mode `columnsByTable` map is built.

---

## Ordered Implementation Steps

1. **Create `backend/app/operations/graph.py`.** Define `_SYSTEM_SCHEMAS` (copy from [`list_schemas.py`](backend/app/operations/list_schemas.py#L14)), the five `Query` classes per `## Public API` / `## Internal Structure`, and the two `assemble_*` helpers. Each query: `__init__(conn, schema)` stores `self._schema`, `self._raw = None`; `apply()` runs `self._conn.fetch(self._SQL, self._schema, list(_SYSTEM_SCHEMAS))`; `get_result()` raises `RuntimeError` before `apply()`, else maps rows. Docstrings per `~/.claude/CODE_CONVENTIONS.md` (Python section).
2. **Export the new symbols** from [`backend/app/operations/__init__.py`](backend/app/operations/__init__.py) — add the five query classes and both helpers to the imports and `__all__`.
3. **Add the two routes** to [`backend/app/main.py`](backend/app/main.py) beside [`structure`](backend/app/main.py#L431). Schema route: acquire the pool, run all five queries with `schema=<segment>`, return `{"tables": assemble_schema_graph(...)}`. Database route: run the four structure queries with `schema=None`, return `{"schemas": assemble_database_graph(...)}`. Import the new names at the top.
4. **Add the contract types** to [`frontend/src/contract.ts`](frontend/src/contract.ts) per `## Public API`.
5. **Add `getSchemaGraph` / `getDatabaseGraph`** to [`frontend/src/data/api.ts`](frontend/src/data/api.ts), importing the new contract types alongside the existing ones.
6. **Rewrite `buildSchemaGraphData` and `buildDatabaseGraphData`** in [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) per `## Internal Structure`. Update the imports: add `getSchemaGraph`, `getDatabaseGraph`; leave `getObjects`/`getStructure`/`getColumns`/`getSchemas` imports in place (still used by table-open, structure, and navigator paths).
7. **Update the two stale docstrings.** [`buildDatabaseGraphData`'s](frontend/src/SqlAdminController.ts#L1599) "O(schemas × tables) round trips" comment and the [`openRoleMembershipDiagram`](frontend/src/SqlAdminController.ts#L2564) "mirroring buildSchemaGraphData's per-table fan-out" comment both now describe removed behaviour — reword to reflect the single bulk fetch (role membership still fans out; note it no longer mirrors the schema path).
8. **Backend tests** — add `backend/tests/test_graph.py` (see `## Verification`).
9. **Frontend tests** — extend [`frontend/tests/data/api.test.ts`](frontend/tests/data/api.test.ts) with URL + parsed-shape cases for both new functions.
10. **Grep check:** `grep -rn "getStructure\|getColumns" frontend/src/SqlAdminController.ts` — expect matches only under the table-open / properties paths, none inside `buildSchemaGraphData` / `buildDatabaseGraphData`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `backend/app/operations/graph.py` |
| Create | `backend/tests/test_graph.py` |
| Modify | `backend/app/operations/__init__.py` |
| Modify | `backend/app/main.py` |
| Modify | `frontend/src/contract.ts` |
| Modify | `frontend/src/data/api.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/tests/data/api.test.ts` |

---

## Expected Behaviour

**Unit-testable — backend pure helpers (`assemble_*`, offline, hand-built row lists):**

- `assemble_schema_graph` groups facet rows under their `table` and returns one entry per name in `tables`, sorted by name. A table present in `tables` but absent from every facet list gets `structure` = `{indexes: [], constraints: [], foreignKeys: []}` and `columns: []`.
- Column order within a table follows the `columns` input order (the query's `ordinal_position` sort); FK/index/constraint order follows their query's `ORDER BY`.
- `assemble_database_graph` groups by `schema` then `table`, emits no `columns` key, and includes a schema even when one of its tables has zero foreign keys.
- Two tables with the same name in different schemas stay distinct in `assemble_database_graph` (grouping key is `(schema, table)`, not `table`).

**Unit-testable — backend query `get_result` (offline, set `_raw` by hand, mirroring [`test_table_structure.py`](backend/tests/test_table_structure.py)):**

- Each query maps its raw rows to `{"schema", "table", "payload"}`, with `payload` identical in shape to the per-table query's element (FK action codes mapped via `_FK_ACTIONS`, constraint `contype` via `_CONSTRAINT_TYPES`, column via `ColumnMeta.to_contract`).
- `get_result()` before `apply()` raises `RuntimeError` for all five.

**Unit-testable — frontend api client (offline, `vi.stubGlobal("fetch", …)`, mirroring [`api.test.ts`](frontend/tests/data/api.test.ts)):**

- `getSchemaGraph(ref)` GETs `/api/{conn}/{db}/{schema}/graph` and returns the parsed `{tables}` envelope; a non-OK response throws the backend `{detail}`.
- `getDatabaseGraph(ref)` GETs `/api/{conn}/{db}/graph` likewise.

**Needs a live DB / manual check (against the seeded `hub` schema):**

- **The SQL correctness of all five schema/database-wide queries** — especially `SchemaColumnsQuery`'s per-table primary-key and backing-sequence joins. Verify a serial/identity column reports `isPrimaryKey` + its `sequence` on the *right* table, and a same-named column in another table is unaffected.
- Opening the `hub` schema diagram issues **one** `/graph` request (DevTools Network), and the rendered node/edge set, FK crow's-foot cardinality markers, and uncovered-FK warning tint match what the per-table version produced.
- The database diagram issues **one** `/graph` request and spans every non-system schema; a cross-schema FK still draws an edge.
- The relation-rooted diagram (card mode) still shows column rows and column-to-column FK ports.

---

## Verification

- **Backend:** `cd backend && poetry run pytest tests/test_graph.py` (in a worktree, `poetry run python -m pytest`). Cover every `assemble_*` behaviour above and each query's `get_result` mapping + pre-`apply` guard.
- **Frontend typecheck + unit:** `cd frontend && npm run build` (tsc) and `npm run test` (vitest) — the extended `api.test.ts` cases go green.
- **Grep invariant:** step 10 above.
- **Manual smoke (live DB):** log in (Host `sqladmin-db`), open the `hub` schema diagram, the database diagram, and a relation diagram; confirm the single `/graph` request and visual parity per `## Expected Behaviour`. Backend SQL cannot be exercised by the offline pytest suite, so this manual pass is the only check on the queries themselves.

---

## Potential Challenges

- **`SchemaColumnsQuery` join correctness.** The primary-key and sequence sub-selects must carry `(table_schema, table_name)` and join on them, or metadata bleeds across same-named columns in different tables — the one place a naive filter-drop is wrong. Verify against a table whose PK column name repeats in a sibling table.
- **Payload key stripping.** `assemble_*` must emit structure elements *without* the `schema`/`table` tags — the frontend `TableStructure` shape has no such keys. Keeping the element under a `payload` sub-dict (not spread) sidesteps this cleanly.
- **Large database payload.** The database endpoint omits columns precisely because a whole-DB column dump could be large; keep it structure-only. If a pathological database is still heavy, that is a size concern for a later plan, not a correctness issue here.
- **Node set authority.** Derive tables from `SchemaTablesQuery`, not from "whichever tables appeared in the columns/FK rows" — a table with no columns fetched (should not happen) or no FKs must still become a node, matching today's `getObjects`-derived set.

---

## Critical Files

- [`backend/app/operations/table_structure.py`](backend/app/operations/table_structure.py) — the three per-table queries the structure ones generalize.
- [`backend/app/operations/list_columns.py`](backend/app/operations/list_columns.py) — the per-table columns query; source of the delicate PK/sequence sub-selects.
- [`backend/app/operations/list_dependencies.py`](backend/app/operations/list_dependencies.py) — the schema-scoped-query precedent.
- [`backend/app/main.py:431`](backend/app/main.py#L431) — the `/structure` route; the multi-query-combining route precedent, and the pool-acquire pattern.
- [`backend/app/operations/list_schemas.py`](backend/app/operations/list_schemas.py) — `_SYSTEM_SCHEMAS` and the non-system-schema filter to mirror.
- [`backend/tests/test_table_structure.py`](backend/tests/test_table_structure.py) — the offline `_raw`-setting test style to copy.
- [`frontend/src/SqlAdminController.ts:1525`](frontend/src/SqlAdminController.ts#L1525) — the two consumer methods (`buildSchemaGraphData`, `buildDatabaseGraphData`).
- [`frontend/src/data/buildSchemaDiagram.ts`](frontend/src/data/buildSchemaDiagram.ts), [`frontend/src/data/fkCardinality.ts`](frontend/src/data/fkCardinality.ts), [`frontend/src/data/buildDatabaseDiagram.ts`](frontend/src/data/buildDatabaseDiagram.ts) — the pure builders whose inputs the endpoints must match exactly (unchanged by this plan; read to confirm the returned shape lines up).
- [`frontend/tests/data/api.test.ts`](frontend/tests/data/api.test.ts) — the fetch-mock client-test style to copy.

---

## Non-Goals

- **The ~15s ELK layout.** `DiagramView` runs one global ELK pass over the whole graph after the data lands; this plan cuts fetch time, not layout time. A determinate layout progress indicator would need library support `DiagramView` does not expose today — out of scope.[^layout-note]
- **Progressive / streaming render.** Rejected (see `## Architecture Decisions`); not a follow-up.
- **Converting the diagram panels to any new component style, or changing FK-cardinality / card-mode logic.** The builders are reused verbatim.
- **A backend Pydantic response model.** The existing routes return plain dicts ([`/structure`](backend/app/main.py#L431)); the new ones match. The typed contract lives on the frontend only, as it does today.

---

## Notes

[^why-bulk]: ELK lays out the whole graph in a single global pass, so no good layout exists until every node and edge is present — the diagram must wait for all metadata regardless of how it arrives. Given that, the cheapest correct design is to fetch all the metadata in one request and lay out once. The bulk endpoint removes the browser's 6-connection throttle (the actual bottleneck: 308 requests draining in ~50 waves) and the per-request session/auth overhead, collapsing the fetch to a single round trip.

[^why-not-progressive]: Streaming tables into the diagram as they arrive would force a full ELK re-layout on every batch — layout is global, not incremental — so nodes would jump position on each update, producing exactly the stutter the feature is meant to remove, and running the expensive layout dozens of times instead of once. It also complicates the panel with partial-graph states for no fetch-time win over a single bulk request. Rejected.

[^why-raw]: Two options were weighed: return raw per-table structures + columns (frontend keeps `buildSchemaDiagram` / `annotateFkCardinality` / `buildDatabaseDiagram`), or return the fully-assembled nodes + edges (moving that assembly, FK-cardinality inference, and card-mode port logic to the backend). Raw is lower-risk: the graph-assembly and cardinality code is already written, unit-tested, and pure ([`fkCardinality.ts`](frontend/src/data/fkCardinality.ts) has its own focused tests); re-implementing it in Python would duplicate non-trivial logic (index-definition parsing, crow's-foot mapping) across two languages and two test suites for no user-visible gain. The endpoint's job is to cut round trips, not to relocate rendering logic.

[^why-not-one-megaquery]: A single mega-query joining columns + indexes + constraints + foreign keys per table is possible but would fuse four independently-shaped result sets (different cardinalities, different `ORDER BY`s, array-aggregation to avoid row multiplication) into one hard-to-read, hard-to-test statement — and would break the codebase's established one-facet-per-query pattern that [`/structure`](backend/app/main.py#L431) sets. The five separate schema-wide queries are each a mechanical generalization of an existing, understood query, each offline-testable via `get_result`. The headline win — one **HTTP** round trip for the frontend — is fully delivered by grouping their results in the route; shaving the backend's internal query count from five to one buys nothing the user perceives.

[^layout-note]: The panel already sets a status-bar `"…: loading…"` message while the build runs ([`openAsyncPanel`](frontend/src/SqlAdminController.ts#L2852)) and renders behind the Dock's lazy-panel spinner. After the bulk fetch resolves, that spinner phase is short; the residual wait is ELK inside `DiagramView`, which is not covered by the fetch spinner. Adding a determinate "laying out…" state would require `DiagramView` to report layout start/completion — a library change this plan does not make. Left as-is deliberately.
