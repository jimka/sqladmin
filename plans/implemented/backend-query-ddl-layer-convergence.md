---
touches-shared:
  - backend/app/operations/
  - backend/app/sql/ddl.py
  - backend/app/main.py
  - backend/README.md
  - frontend/src/contract.ts
---

# Backend query/DDL layer convergence — Implementation Plan

## Overview

The backend's CQRS read handlers (`backend/app/operations/`) carry several copies of the same catalog query, the same row-shaping block, and the same `get_result()` guard. One of those copies has already drifted into a live bug: [`ListInheritanceQuery`](backend/app/operations/list_inheritance.py#L29) selects `pg_inherits` rows with no relkind filter and then looks the relkind up in a five-entry map ([`list_inheritance.py:18`](backend/app/operations/list_inheritance.py#L18)) that does not cover the `I`/`i` codes Postgres 11+ records there for partitioned indexes. The lookup raises `KeyError`, which neither exception handler in [`main.py:167-185`](backend/app/main.py#L167) catches, so `GET /{schema}/inheritance` returns HTTP 500 for any schema containing a partitioned index. Its sibling [`ListDependenciesQuery`](backend/app/operations/list_dependencies.py#L44) escapes the same failure only because it filters relkinds in SQL — the two modules hold byte-identical copies of the map and of the edge-shaping comprehension, and only one copy grew the guard.

This plan removes the duplication that produced that bug and the neighbouring duplication in the same layer: a shared `CatalogQuery` base carrying `_conn`/`_raw`/the guard, a new `backend/app/operations/catalog.py` holding the catalog-code maps, the shared SQL fragments, and the pure row-to-payload mappers that [`graph.py`](backend/app/operations/graph.py) and [`table_structure.py`](backend/app/operations/table_structure.py) currently write twice each, one `require_field` replacing four byte-identical `_require` copies across the DDL preview modules, and one `_drop_statement()` behind the eight `DROP` builders in [`sql/ddl.py`](backend/app/sql/ddl.py).

It also removes two dead exports (`rename_view`, `rename_materialized_view`), removes `operations/__init__.py`'s unused `Operation`/`Query`/`Command` re-export, corrects four stale docstrings, and fills the gaps in [`backend/README.md`](backend/README.md#L50)'s Layout section.

---

## Architecture Decisions

### One `CatalogQuery` base for every catalog read

`backend/app/operations/base.py` gains `CatalogQuery(Query)`, holding `_conn`, `_raw`, a default `apply()` that runs one `fetch` of `_SQL`, and a `_rows()` accessor carrying the before-`apply()` guard. 27 read handlers across 18 modules move onto it; `Query` and `Command` stay bare contract markers.[^why-subclass]

This mirrors [`DdlPreview`](backend/app/operations/ddl.py#L25), which already does exactly this one layer over: a base holding the shared field, a default `apply()`, and a `get_result()` that owns the guard, with subclasses supplying only their own step.

### A new `operations/catalog.py` for shared catalog SQL and row mappers

The relkind/contype/referential-action maps, the SQL fragments both the per-object and the schema-wide queries select, and the pure row-to-payload mappers built on them live in one new module, `backend/app/operations/catalog.py`.[^why-not-common]

The precedent is [`roles.py:18-45`](backend/app/operations/roles.py#L18): a shared SQL-column constant (`_ROLE_COLUMNS`) plus a shared row mapper (`summary_from_row`), both imported by the sibling module that runs the narrower query ([`role_detail.py:18`](backend/app/operations/role_detail.py#L18)). This plan generalizes that arrangement from one pair of modules to four families of query.

### Every shared SQL fragment binds `$1` = schema and `$2` = relation name

A shared fragment cannot hardcode a scope, and it cannot renumber its parameters per caller. So each fragment ends with a `WHERE` clause whose scope predicates are `NULL`-guarded, and each calling class appends `AND …` and binds `NULL` for the parts it does not scope by. `$1` is always the schema (or `NULL` for "every schema"), `$2` always the relation name (or `NULL` for "every relation"); a fragment that needs a third key defines it, and each class may add further parameters after the fragment's own.

| Query | `_SQL` appends | Bound arguments |
|---|---|---|
| `ListIndexesQuery` | `ORDER BY i.indexname` | `(schema, table, None)` |
| `IndexDetailQuery` | *(nothing)* | `(schema, None, index_name)` |
| `SchemaIndexesQuery` | `AND i.schemaname <> ALL($4::text[]) ORDER BY i.schemaname, i.tablename, i.indexname` | `(schema_or_None, None, None, list(SYSTEM_SCHEMAS))` |

Every resulting statement is logically identical to the one it replaces.[^scope-equivalence]

### Unknown relkinds are dropped in SQL and again in the shaper

Both edge queries filter `relkind` against the shared map's own key set in SQL, and the shared `edge_rows()` shaper drops any row whose either endpoint carries a relkind outside the map. Neither layer is redundant: the SQL filter keeps the two queries from fetching rows nothing can use, and the shaper's skip is what a database-free unit test can pin.[^two-layer-guard]

| `source_kind` | `target_kind` | `edge_rows()` output |
|---|---|---|
| `p` | `r` | one edge, both sides `"table"` |
| `v` | `m` | one edge, `"view"` → `"materializedView"` |
| `I` | `i` | *(row dropped)* |

### The two edge queries adopt one `source_*`/`target_*` column vocabulary

`ListInheritanceQuery` renames its `parent_*`/`child_*` output aliases and `ListDependenciesQuery` its `dependent_*`/`source_*` aliases, so both feed one shaper that takes no per-caller prefixes.[^why-rename]

| Query | Old alias | New alias |
|---|---|---|
| `ListInheritanceQuery` | `parent_schema` / `parent_name` / `parent_kind` | `source_schema` / `source_name` / `source_kind` |
| `ListInheritanceQuery` | `child_schema` / `child_name` / `child_kind` | `target_schema` / `target_name` / `target_kind` |
| `ListDependenciesQuery` | `dependent_schema` / `dependent_name` / `dependent_kind` | `source_schema` / `source_name` / `source_kind` |
| `ListDependenciesQuery` | `source_schema` / `source_name` / `source_kind` | `target_schema` / `target_name` / `target_kind` |

`ListDependenciesQuery`'s rename swaps the meaning of the `source_*` prefix. Its old `source_*` columns describe the relation the view *reads*, which the contract calls the edge's **target**.

### Identifier validation keeps both layers; only its implementation is shared

`sql/ddl.py`'s `_require_ident` becomes the public `require_text(value, label)` — one implementation of "required, non-blank string". `operations/ddl.py` gains `require_field(spec, key)`, a one-line mapping adapter over it, replacing the four byte-identical `_require` copies. The builder-level `require_text` calls inside `sql/ddl.py` stay where they are.[^keep-builder-checks]

### One `_drop_statement()` behind the eight DROP builders, with `if_exists` completed

`sql/ddl.py` gains a private `_drop_statement(keyword, target, *, cascade, if_exists)` that all eight `DROP` builders call, and `_add_key_constraint()` that `add_primary_key`/`add_unique` call. `drop_view` and `drop_materialized_view` gain the `if_exists` parameter their six siblings already have, `drop_routine`'s `cascade`/`if_exists` become keyword-only, and the two view-drop preview ops read `ifExists` off their spec the way the six sibling drop previews already do.[^ifexists-end-to-end]

`_constraint_prefix` ([`sql/ddl.py:382`](backend/app/sql/ddl.py#L382)) is the precedent: one private helper owning a clause every builder in a family emits.

---

## Public API

### `backend/app/operations/base.py`

```python
class CatalogQuery(Query):
    _SQL: ClassVar[str] = ""

    def __init__(self, conn: asyncpg.Connection, *args: Any) -> None: ...
    async def apply(self) -> None: ...
    def _rows(self) -> Sequence[Mapping[str, Any]]: ...
```

`*args` are bound to `_SQL`'s `$1`, `$2`, … in order. `_rows()` raises `RuntimeError("get_result() called before apply()")` when `apply()` has not run. A subclass whose read is not one statement overrides `apply()` and still stores into `self._raw`.

### `backend/app/operations/catalog.py` (new)

```python
SYSTEM_SCHEMAS: tuple[str, ...]
RELKIND_KIND: dict[str, str]
RELKIND_CODES: tuple[str, ...]
FK_ACTIONS: dict[str, str]
CONSTRAINT_TYPES: dict[str, str]

INDEX_SELECT: str
INDEX_FROM: str
CONSTRAINT_SELECT: str
CONSTRAINT_FROM: str
FOREIGN_KEY_SELECT: str
FOREIGN_KEY_FROM: str
COLUMN_SELECT: str
COLUMN_FROM: str

def edge_rows(rows: Sequence[Mapping[str, Any]]) -> list[dict]: ...
def index_payload(row: Mapping[str, Any]) -> dict: ...
def constraint_payload(row: Mapping[str, Any]) -> dict: ...
def foreign_key_payload(row: Mapping[str, Any]) -> dict: ...
def column_meta(row: Mapping[str, Any]) -> ColumnMeta: ...
```

`RELKIND_CODES` is `tuple(RELKIND_KIND)` — the map's own keys, bound as a query parameter so the SQL filter can never fall out of step with the map.

### `backend/app/operations/ddl.py`

```python
def require_field(spec: Mapping[str, Any], key: str) -> str: ...
```

### `backend/app/sql/ddl.py`

```python
def require_text(value: object, label: str) -> str: ...   # was the private _require_ident
def drop_view(schema: str, name: str, *, cascade: bool = False, if_exists: bool = False) -> str: ...
def drop_materialized_view(schema: str, name: str, *, cascade: bool = False, if_exists: bool = False) -> str: ...
def drop_routine(schema: str, name: str, kind: str, signature: str, *, cascade: bool = False, if_exists: bool = False) -> str: ...
```

Removed: `rename_view`, `rename_materialized_view` (and their `__all__` entries).

### `frontend/src/contract.ts`

```ts
export interface DropSpec {
    schema: string;
    name: string;
    cascade: boolean;
    ifExists?: boolean;
}
```

---

## Internal Structure

### The shared SQL fragments

Each `*_FROM` fragment ends with an open `WHERE`; each calling class appends `AND …` and its own `ORDER BY`. Every fragment body is moved verbatim from an existing query — only the `WHERE` is new.

**Indexes** — body from [`table_structure.py:47-59`](backend/app/operations/table_structure.py#L47), with `graph.py`'s corrected join predicate:

```python
INDEX_SELECT = """
    i.indexname     AS name,
    i.indexdef      AS definition,
    ix.indisunique  AS unique,
    ix.indisprimary AS primary
"""

INDEX_FROM = """
    FROM pg_indexes i
    JOIN pg_class ic     ON ic.relname = i.indexname
    JOIN pg_namespace n  ON n.oid = ic.relnamespace
    JOIN pg_index ix     ON ix.indexrelid = ic.oid
    WHERE n.nspname = i.schemaname
      AND ($1::text IS NULL OR i.schemaname = $1)
      AND ($2::text IS NULL OR i.tablename  = $2)
      AND ($3::text IS NULL OR i.indexname  = $3)
"""
```

**Constraints** — `CONSTRAINT_SELECT` is [`table_structure.py:178-186`](backend/app/operations/table_structure.py#L178) verbatim (`name`, `contype`, `definition`, the `columns` array sub-select); `CONSTRAINT_FROM` is its three-line `FROM`/`JOIN` block followed by:

```sql
    WHERE con.contype IN ('p', 'u', 'c')
      AND ($1::text IS NULL OR n.nspname = $1)
      AND ($2::text IS NULL OR c.relname = $2)
```

**Foreign keys** — `FOREIGN_KEY_SELECT` is [`table_structure.py:241-258`](backend/app/operations/table_structure.py#L241) verbatim; `FOREIGN_KEY_FROM` is its five-line `FROM`/`JOIN` block followed by the same two scope predicates under `WHERE con.contype = 'f'`.

**Columns** — `COLUMN_SELECT` is [`list_columns.py:40-54`](backend/app/operations/list_columns.py#L40) verbatim (including `full_type` and `default_expr`). `COLUMN_FROM` is `FROM information_schema.columns c` plus the three `LEFT JOIN` sub-selects, each carrying the scope predicates and joined on `(schema, table, column)`:

```sql
    FROM information_schema.columns c
    LEFT JOIN (
        SELECT tc.table_schema, tc.table_name, kcu.column_name, true AS is_pk
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema    = tc.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND ($1::text IS NULL OR tc.table_schema = $1)
          AND ($2::text IS NULL OR tc.table_name   = $2)
    ) pk ON pk.table_schema = c.table_schema
        AND pk.table_name   = c.table_name
        AND pk.column_name  = c.column_name
    LEFT JOIN (
        SELECT an.nspname AS ref_schema,
               ac.relname AS ref_table,
               a.attname  AS column_name,
               format_type(a.atttypid, a.atttypmod) AS full_type
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class ac     ON ac.oid = a.attrelid
        JOIN pg_catalog.pg_namespace an ON an.oid = ac.relnamespace
        WHERE a.attnum > 0 AND NOT a.attisdropped
          AND ($1::text IS NULL OR an.nspname = $1)
          AND ($2::text IS NULL OR ac.relname = $2)
    ) att ON att.ref_schema  = c.table_schema
         AND att.ref_table   = c.table_name
         AND att.column_name = c.column_name
    LEFT JOIN (
        SELECT DISTINCT ON (rn.nspname, rc.relname, l.attnum)
               rn.nspname AS ref_schema,
               rc.relname AS ref_table,
               a.attname  AS column_name,
               sn.nspname AS sequence_schema,
               s.relname  AS sequence_name
        FROM ( <the two UNION ALL arms, verbatim from list_columns.py:84-98> ) l
        JOIN pg_catalog.pg_class s      ON s.oid = l.seqid AND s.relkind = 'S'
        JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
        JOIN pg_catalog.pg_class rc     ON rc.oid = l.attrelid
        JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
        JOIN pg_catalog.pg_attribute a  ON a.attrelid = l.attrelid AND a.attnum = l.attnum
        WHERE ($1::text IS NULL OR rn.nspname = $1)
          AND ($2::text IS NULL OR rc.relname = $2)
        ORDER BY rn.nspname, rc.relname, l.attnum, l.arm DESC, sn.nspname, s.relname
    ) seq ON seq.ref_schema  = c.table_schema
         AND seq.ref_table   = c.table_name
         AND seq.column_name = c.column_name
    WHERE ($1::text IS NULL OR c.table_schema = $1)
      AND ($2::text IS NULL OR c.table_name   = $2)
"""
```

Carry every explanatory comment from `list_columns.py:27-37`, `:65-69`, `:84`, `:92`, `:100-103`, and `:110-113` across into `catalog.py` — they document why the two arms have opposite join orientations and why `relkind = 'S'` is load-bearing.

### The shared edge shaper

```python
def edge_rows(rows: Sequence[Mapping[str, Any]]) -> list[dict]:
    return [
        {"source": _endpoint(r, "source"), "target": _endpoint(r, "target")}
        for r in rows
        if r["source_kind"] in RELKIND_KIND and r["target_kind"] in RELKIND_KIND
    ]


def _endpoint(row: Mapping[str, Any], side: str) -> dict:
    return {
        "schema": row[f"{side}_schema"],
        "name": row[f"{side}_name"],
        "kind": RELKIND_KIND[row[f"{side}_kind"]],
    }
```

### A migrated handler, end to end

```python
class ListInheritanceQuery(CatalogQuery):
    _SQL = """ … """

    def __init__(self, conn: asyncpg.Connection, schema: str) -> None:
        """
        Capture the connection and the schema to introspect.
        """
        super().__init__(conn, schema, list(RELKIND_CODES))

    def get_result(self) -> list[dict]:
        """
        …
        """
        return edge_rows(self._rows())
```

---

## Ordered Implementation Steps

### Phase 1 — the `CatalogQuery` base

1. **`backend/app/operations/base.py`** — add `CatalogQuery(Query)` per `## Public API`. Import `asyncpg`, `Mapping`/`Sequence` from `collections.abc`, and `Any`/`ClassVar` from `typing`. Extend the module docstring with one sentence naming `CatalogQuery` as the base a catalog read subclasses.

2. **Migrate the 27 read handlers.** For each row below: change the base class to `CatalogQuery`, replace the `__init__` body with `super().__init__(conn, …)` plus only the fields still read elsewhere, delete `apply()` unless the row says "keeps `apply()`", and replace `get_result()`'s guard-plus-`self._raw` with `self._rows()`. Leave `_SQL` and every result transform exactly as they are; the arguments below are today's `fetch` arguments, and phases 2-4 change some of them along with the SQL.

   | Module | Class | `super().__init__` arguments | Fields to keep | Notes |
   |---|---|---|---|---|
   | `list_databases.py` | `ListDatabasesQuery` | `(conn)` | — | |
   | `list_schemas.py` | `ListSchemasQuery` | `(conn, list(_SYSTEM_SCHEMAS))` | `_database` | |
   | `list_objects.py` | `ListObjectsQuery` | `(conn, schema)` | — | |
   | `list_functions.py` | `ListFunctionsQuery` | `(conn, schema)` | — | |
   | `list_types.py` | `ListTypesQuery` | `(conn, schema)` | — | |
   | `list_dependencies.py` | `ListDependenciesQuery` | `(conn, schema)` | — | |
   | `list_inheritance.py` | `ListInheritanceQuery` | `(conn, schema)` | — | |
   | `list_columns.py` | `ListColumnsQuery` | `(conn, table.schema, table.name)` | `_table` | keeps `apply()` (matview fallback); `get_columns_result()` uses `_rows()` |
   | `list_rows.py` | `ListRowsQuery` | `(conn)` | all existing except `_conn`/`_raw` | keeps `apply()` (SQL built per call) |
   | `roles.py` | `ListRolesQuery` | `(conn)` | — | |
   | `role_detail.py` | `RoleAttributesQuery` | `(conn, role)` | — | |
   | `role_detail.py` | `RoleMembershipsQuery` | `(conn, role)` | — | |
   | `role_detail.py` | `RolePrivilegesQuery` | `(conn, role)` | — | |
   | `table_privileges.py` | `TablePrivilegesQuery` | `(conn, table.schema, table.name)` | — | |
   | `table_structure.py` | `ListIndexesQuery` | `(conn, table.schema, table.name)` | — | |
   | `table_structure.py` | `IndexDetailQuery` | `(conn, index.schema, index.name)` | `_index` | `NotFound` message reads it |
   | `table_structure.py` | `ListConstraintsQuery` | `(conn, table.schema, table.name)` | — | |
   | `table_structure.py` | `ListForeignKeysQuery` | `(conn, table.schema, table.name)` | — | |
   | `graph.py` | `SchemaTablesQuery` | `(conn, schema, list(_SYSTEM_SCHEMAS))` | — | |
   | `graph.py` | `SchemaColumnsQuery` | `(conn, schema, list(_SYSTEM_SCHEMAS))` | — | |
   | `graph.py` | `SchemaIndexesQuery` | `(conn, schema, list(_SYSTEM_SCHEMAS))` | — | |
   | `graph.py` | `SchemaConstraintsQuery` | `(conn, schema, list(_SYSTEM_SCHEMAS))` | — | |
   | `graph.py` | `SchemaForeignKeysQuery` | `(conn, schema, list(_SYSTEM_SCHEMAS))` | — | |
   | `view_definition.py` | `ViewDefinitionQuery` | `(conn, table.schema, table.name)` | `_table` | |
   | `sequence_detail.py` | `SequenceDetailQuery` | `(conn, table.schema, table.name)` | `_table` | |
   | `function_definition.py` | `FunctionDefinitionQuery` | `(conn, schema, name, signature)` | `_schema`, `_name`, `_signature` | |
   | `type_definition.py` | `TypeDefinitionQuery` | `(conn)` | `_schema`, `_name`, `_category`, `_owner` | keeps `apply()` (two-step read) |

3. **Drop the now-unused imports.** Each migrated module that no longer names `Mapping`/`Sequence`/`Any` drops those imports; every migrated module imports `CatalogQuery` from `.base` in place of `Query`. Check: `poetry run pytest` from `backend/` — the whole suite must pass with no test edits in this phase.

4. **Checkpoint.** `grep -rln "get_result() called before apply()" backend/app/operations/` — expect exactly six files: `explain_query.py`, `update_row.py`, `insert_row.py`, `run_query.py`, `import_rows.py`, `ddl.py`.

### Phase 2 — the relkind map and edge shaping (fixes the live bug)

5. **Create `backend/app/operations/catalog.py`** with the module docstring, `SYSTEM_SCHEMAS`, `RELKIND_KIND`, `RELKIND_CODES`, `edge_rows()`, and `_endpoint()` per `## Public API` and `## Internal Structure`. Move `RELKIND_KIND`'s existing comment across; extend it to say the codes it omits (`I`/`i`, index partitions) are filtered out rather than mapped.

6. **`list_schemas.py`, `graph.py`** — delete both `_SYSTEM_SCHEMAS` definitions and import `SYSTEM_SCHEMAS` from `.catalog`; rename it in the one `super().__init__` call in `list_schemas.py` and the five in `graph.py`.

7. **`list_inheritance.py`** — delete `_RELKIND_KIND`; rename the `_SQL` output aliases per the rename table in `## Architecture Decisions`; add `AND p.relkind = ANY($2::text[])` and `AND c.relkind = ANY($2::text[])` to the `WHERE`; change `ORDER BY` to `source_name, target_name`; change `super().__init__` to `(conn, schema, list(RELKIND_CODES))`; make `get_result()` `return edge_rows(self._rows())`.

8. **`list_dependencies.py`** — delete `_RELKIND_KIND`; rename the `_SQL` output aliases per the same table (note the `source_*` → `target_*` swap); replace `AND sc.relkind IN ('r', 'v', 'm', 'p', 'f')` with `AND sc.relkind = ANY($2::text[])`, leaving `AND dc.relkind IN ('v', 'm')` alone; change `ORDER BY` to `source_name, target_name`; change `super().__init__` to `(conn, schema, list(RELKIND_CODES))`; make `get_result()` `return edge_rows(self._rows())`.

9. **`backend/tests/test_list_inheritance.py`, `backend/tests/test_list_dependencies.py`** — rewrite every hand-set `_raw` row to the new column names. Add to `test_list_inheritance.py`: a test that a row with `source_kind="I"`/`target_kind="i"` yields `[]`, and a test that a mixed list keeps only the mappable edge. Add to both: a test asserting the constructor binds the relkind codes, e.g. `assert ListInheritanceQuery(NO_CONN, "public")._args == ("public", ["r", "p", "f", "v", "m"])`.

10. **Checkpoint.** `grep -rn "_RELKIND_KIND" backend/` — expect zero matches. `poetry run pytest`.

### Phase 3 — index, constraint, and foreign-key query convergence

11. **`catalog.py`** — add `FK_ACTIONS` and `CONSTRAINT_TYPES` (moved from `table_structure.py:24` and `:34`, dropping the underscore prefix). Fix `FK_ACTIONS`' comment: it says "these four codes" above five entries — write "these five codes". Add `INDEX_SELECT`/`INDEX_FROM`, `CONSTRAINT_SELECT`/`CONSTRAINT_FROM`, `FOREIGN_KEY_SELECT`/`FOREIGN_KEY_FROM` and the three payload mappers `index_payload`, `constraint_payload`, `foreign_key_payload` per `## Internal Structure`. Each mapper is the body of the corresponding `get_result()` comprehension in `table_structure.py` for one row.

12. **`table_structure.py`** — delete `_FK_ACTIONS`, `_CONSTRAINT_TYPES`, and the three duplicated `_SQL` bodies. Rebuild each `_SQL` as an f-string over the fragments, and each `get_result()` as a comprehension over `self._rows()` calling the shared mapper:

    - `ListIndexesQuery._SQL = f"SELECT {INDEX_SELECT} {INDEX_FROM} ORDER BY i.indexname"`, `super().__init__(conn, table.schema, table.name, None)`.
    - `IndexDetailQuery._SQL = f"SELECT {INDEX_SELECT}, i.tablename AS table_name {INDEX_FROM}"`, `super().__init__(conn, index.schema, None, index.name)`. Its `get_result()` keeps the `NotFound` branch and builds `{**index_payload(row), "table": row["table_name"]}`.
    - `ListConstraintsQuery._SQL = f"SELECT {CONSTRAINT_SELECT} {CONSTRAINT_FROM} ORDER BY con.contype, con.conname"`, `super().__init__(conn, table.schema, table.name)`.
    - `ListForeignKeysQuery._SQL = f"SELECT {FOREIGN_KEY_SELECT} {FOREIGN_KEY_FROM} ORDER BY con.conname"`, `super().__init__(conn, table.schema, table.name)`.

    Update the module docstring: it currently says the schema and table bind as `$1`/`$2`; say instead that the shared fragments bind them, and drop the now-moved `_FK_ACTIONS` comment.

13. **`graph.py`** — delete the `from .table_structure import _CONSTRAINT_TYPES, _FK_ACTIONS` line, the three duplicated `_SQL` bodies, and the `graph.py:208-212` comment about the fixed join predicate (the predicate now lives once, in `INDEX_FROM`). Rebuild:

    - `SchemaIndexesQuery._SQL = f"SELECT i.schemaname AS schema, i.tablename AS table, {INDEX_SELECT} {INDEX_FROM} AND i.schemaname <> ALL($4::text[]) ORDER BY i.schemaname, i.tablename, i.indexname"`, `super().__init__(conn, schema, None, None, list(SYSTEM_SCHEMAS))`.
    - `SchemaConstraintsQuery._SQL = f"SELECT n.nspname AS schema, c.relname AS table, {CONSTRAINT_SELECT} {CONSTRAINT_FROM} AND n.nspname <> ALL($3::text[]) ORDER BY n.nspname, c.relname, con.contype, con.conname"`, `super().__init__(conn, schema, None, list(SYSTEM_SCHEMAS))`.
    - `SchemaForeignKeysQuery._SQL = f"SELECT n.nspname AS schema, c.relname AS table, {FOREIGN_KEY_SELECT} {FOREIGN_KEY_FROM} AND n.nspname <> ALL($3::text[]) ORDER BY n.nspname, c.relname, con.conname"`, `super().__init__(conn, schema, None, list(SYSTEM_SCHEMAS))`.

    Each `get_result()` becomes `[{"schema": r["schema"], "table": r["table"], "payload": <mapper>(r)} for r in self._rows()]`.

14. **Checkpoint.** `poetry run pytest` — `test_table_structure.py` and `test_graph.py` must pass unedited (their `_raw` column names are unchanged).

### Phase 4 — the columns query

15. **`catalog.py`** — add `COLUMN_SELECT`, `COLUMN_FROM`, and `column_meta(row)` per `## Internal Structure`. `column_meta` is `ListColumnsQuery.get_columns_result()`'s per-row `ColumnMeta(...)` construction, moved verbatim.

16. **`list_columns.py`** — replace `_SQL` with `f"SELECT {COLUMN_SELECT} {COLUMN_FROM} ORDER BY c.ordinal_position"`; delete the `seq`/`att`/`pk` sub-select comments now living in `catalog.py`, leaving the module docstring. `get_columns_result()` becomes `[column_meta(r) for r in self._rows()]`. `_MATVIEW_SQL` and the `apply()` fallback stay.

17. **`graph.py`** — `SchemaColumnsQuery._SQL` becomes:

    ```python
    _SQL = f"""
        SELECT c.table_schema AS schema, c.table_name AS table, {COLUMN_SELECT}
        {COLUMN_FROM}
          AND c.table_schema <> ALL($3::text[])
          AND EXISTS (
              SELECT 1 FROM information_schema.tables t
              WHERE t.table_schema = c.table_schema
                AND t.table_name   = c.table_name
                AND t.table_type  <> 'VIEW'
          )
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
    """
    ```

    with `super().__init__(conn, schema, None, list(SYSTEM_SCHEMAS))`. Its `get_result()` becomes `[{"schema": r["schema"], "table": r["table"], "payload": column_meta(r).to_contract()} for r in self._rows()]`. Replace the class docstring's sentence about dropping the matview fallback with one naming the `EXISTS` base-tables-only guard, and delete the sub-select comment block at `graph.py:84-88`.

18. **`backend/tests/test_graph.py`** — add `"full_type"` and `"default_expr"` keys to `test_columns_wraps_column_meta_as_payload`'s hand-set rows, update the expected `fullType`/`defaultExpr` values, and delete the comment claiming the op produces neither. Add one case where `full_type` differs from `data_type` (e.g. `"character varying"` / `"character varying(60)"`).

19. **Checkpoint.** `poetry run pytest`.

### Phase 5 — `_require` / `_require_ident` convergence

20. **`backend/app/sql/ddl.py`** — rename `_require_ident` to `require_text`, move it up to the shared-primitives area just after `quote_literal` (line 90-106), widen its first parameter to `value: object`, and add the `isinstance(value, str)` check to its condition. Add `"require_text"` to `__all__`. Update all 13+ call sites' name.

21. **`backend/app/operations/ddl.py`** — add `require_field(spec, key)` returning `require_text(spec.get(key), key)`, importing `require_text` from `..sql.ddl`.

22. **`ddl_table.py`, `ddl_view.py`, `ddl_schema_sequence.py`, `ddl_function_type.py`** — delete each module's `_require`, import `require_field` from `.ddl`, and rename every call. `ddl_table.py`'s `_field` (the non-string analogue) stays; update its docstring's reference from `_require` to `require_field`.

23. **Checkpoint.** `grep -rn "def _require(\|_require_ident" backend/` — expect zero matches. `poetry run pytest`.

### Phase 6 — the `sql/ddl.py` DROP builders

24. **`backend/app/sql/ddl.py`** — add `_drop_statement(keyword, target, *, cascade, if_exists)` next to `require_text` in the primitives area, and `_add_key_constraint(schema, name, columns, keyword, *, constraint_name)` next to `_constraint_prefix` (line 382). Rewrite the eight drop builders and the two add-key builders to call them:

    | Builder | `_drop_statement` call |
    |---|---|
    | `drop_table` | `("TABLE", qualify(schema, name), …)` |
    | `drop_index` | `("INDEX", qualify(schema, index_name), …)` |
    | `drop_view` | `("VIEW", qualify(schema, name), …)` |
    | `drop_materialized_view` | `("MATERIALIZED VIEW", qualify(schema, name), …)` |
    | `schema_drop` | `("SCHEMA", quote_ident(name), …)` |
    | `sequence_drop` | `("SEQUENCE", qualify(schema, name), …)` |
    | `drop_routine` | `(keyword, f"{qualify(schema, name)}({signature})", …)` |
    | `drop_type` | `("TYPE", qualify(schema, name), …)` |

    Each builder keeps its own docstring and its own `require_text` calls. `_add_key_constraint` raises `ValidationError(f"{keyword} requires at least one column")`, so `add_primary_key` and `add_unique` keep their exact current messages.

25. **`drop_view`/`drop_materialized_view`** — add `if_exists: bool = False` after `cascade`, and document it in each docstring's `Args:` and `Returns:` the way `drop_table` does.

26. **`drop_routine`** — move `cascade`/`if_exists` behind a `*`.

27. **`backend/app/operations/ddl_view.py`** — `DropViewPreview.build()` and `DropMaterializedViewPreview.build()` pass `if_exists=bool(self._spec.get("ifExists", False))`; both class docstrings' `Spec:` lines become `{schema, name, cascade?, ifExists?}`.

28. **`frontend/src/contract.ts`** — add `ifExists?: boolean;` to `DropSpec` (line 235), with the same one-line comment style as its siblings.

29. **Remove the dead renames.** Delete `rename_view` and `rename_materialized_view` from `sql/ddl.py` and from `__all__`; delete `test_rename_view` and `test_rename_materialized_view` (and their section banners) from `backend/tests/test_view_matview_ddl_sql.py`.

30. **`backend/tests/test_view_matview_ddl_sql.py`, `backend/tests/test_view_matview_ddl_ops.py`** — add the `if_exists` cases from `## Expected Behaviour`. **`backend/tests/test_ddl_function_type_sql.py`** — add the positional-`cascade` `TypeError` case.

31. **Checkpoint.** `grep -rn "rename_view\|rename_materialized_view" backend/ frontend/src/` — expect zero matches. `poetry run pytest`.

### Phase 7 — dead re-export and stale documentation

32. **`backend/app/operations/__init__.py`** — delete the `from .base import Command, Operation, Query` line and the `"Operation"`, `"Query"`, `"Command"` entries from `__all__`.

33. **`backend/app/operations/ddl.py`** — `ExecuteDdlCommand`'s docstrings claim exactly one statement (module docstring line 11, class docstring line 73, `sql` parameter line 85). Rewrite them to say it runs one previewed DDL script, which is normally a single statement but may be the `DROP;\nCREATE` pair `replace_materialized_view` builds; the transaction wrap is what makes the pair atomic.

34. **`backend/app/operations/list_objects.py`** — the `_OBJECT_SELECTS` comment (lines 20-24) says the function-type-ddl phase adds function and type fragments here. It never did: `list_functions.py` and `list_types.py` read `pg_proc`/`pg_type` in their own modules and say so in their docstrings. Cut that clause, keeping the "one additive line per kind" rationale and the schema-sequence-ddl example. Also add sequences to `apply()`'s docstring (line 61), which still says "table/view/matview rows".

35. **`backend/app/main.py`** — the `/objects` route docstring (lines 279 and 284) omits sequences. Summary line: "List the tables, views, materialized views, and sequences in a schema." `Returns:`: `[{"name": str, "kind": "table" | "view" | "materializedView" | "sequence"}]`.

36. **`backend/README.md`** — extend the Layout section (lines 50-59) with `app/contract.py`, `app/sql/ddl.py`, `app/export_format.py`, `app/static.py`, and `app/dev.py`, each one line, in the same style as the existing entries. Add `app/operations/base.py` + `catalog.py` to the `app/operations/` line so the new shared module is discoverable.

37. **Final checkpoint.** `poetry run pytest` from `backend/`; type-check with pyright against `backend/pyproject.toml`'s config; run the manual checks in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `backend/app/operations/catalog.py` |
| Modify | `backend/app/operations/base.py` |
| Modify | `backend/app/operations/__init__.py` |
| Modify | `backend/app/operations/ddl.py` |
| Modify | `backend/app/operations/ddl_table.py` |
| Modify | `backend/app/operations/ddl_view.py` |
| Modify | `backend/app/operations/ddl_schema_sequence.py` |
| Modify | `backend/app/operations/ddl_function_type.py` |
| Modify | `backend/app/operations/function_definition.py` |
| Modify | `backend/app/operations/graph.py` |
| Modify | `backend/app/operations/list_columns.py` |
| Modify | `backend/app/operations/list_databases.py` |
| Modify | `backend/app/operations/list_dependencies.py` |
| Modify | `backend/app/operations/list_functions.py` |
| Modify | `backend/app/operations/list_inheritance.py` |
| Modify | `backend/app/operations/list_objects.py` |
| Modify | `backend/app/operations/list_rows.py` |
| Modify | `backend/app/operations/list_schemas.py` |
| Modify | `backend/app/operations/list_types.py` |
| Modify | `backend/app/operations/role_detail.py` |
| Modify | `backend/app/operations/roles.py` |
| Modify | `backend/app/operations/sequence_detail.py` |
| Modify | `backend/app/operations/table_privileges.py` |
| Modify | `backend/app/operations/table_structure.py` |
| Modify | `backend/app/operations/type_definition.py` |
| Modify | `backend/app/operations/view_definition.py` |
| Modify | `backend/app/sql/ddl.py` |
| Modify | `backend/app/main.py` |
| Modify | `backend/README.md` |
| Modify | `frontend/src/contract.ts` |
| Modify | `backend/tests/test_list_inheritance.py` |
| Modify | `backend/tests/test_list_dependencies.py` |
| Modify | `backend/tests/test_graph.py` |
| Modify | `backend/tests/test_view_matview_ddl_sql.py` |
| Modify | `backend/tests/test_view_matview_ddl_ops.py` |
| Modify | `backend/tests/test_ddl_function_type_sql.py` |

---

## Expected Behaviour

Every case below is unit-testable offline in the repo's existing style (`_raw` set by hand against `NO_CONN`, per [`backend/tests/conftest.py:19`](backend/tests/conftest.py#L19)) unless marked **manual**.

### Inheritance and dependency edges

1. `ListInheritanceQuery.get_result()` over `_raw = [{"source_*": …, "source_kind": "I", "target_*": …, "target_kind": "i"}]` returns `[]` — no `KeyError`.
2. Over a two-row `_raw` holding one `p` → `r` row and one `I` → `i` row, it returns exactly one edge, the `p` → `r` one, with both sides `"kind": "table"`.
3. Over a `p` → `r` row it returns `{"source": {schema, name, "kind": "table"}, "target": {schema, name, "kind": "table"}}` — the parent is the source.
4. Over `v` → `m`, `ListDependenciesQuery` returns `"view"` → `"materializedView"`; the dependent view is the source and the relation it reads is the target.
5. `ListInheritanceQuery(NO_CONN, "public")._args == ("public", ["r", "p", "f", "v", "m"])`, and the same for `ListDependenciesQuery` — the relkind filter is bound from the map's own keys.
6. Both return `[]` for `_raw = []`, and raise `RuntimeError` from `get_result()` before `apply()`.
7. **Manual.** Against a running database, `CREATE TABLE t (id int, d date) PARTITION BY RANGE (d); CREATE TABLE t_2024 PARTITION OF t FOR VALUES FROM ('2024-01-01') TO ('2025-01-01'); CREATE INDEX t_d_idx ON t (d);` then open that schema's Inheritance diagram. Before this change the request 500s; after it, the response is 200 and holds exactly the `t` → `t_2024` edge, with no node for `t_d_idx`.

### Index, constraint, and foreign-key queries

8. `ListIndexesQuery(NO_CONN, TableRef("sqladmin", "public", "customers"))._args == ("public", "customers", None)`.
9. `IndexDetailQuery(NO_CONN, TableRef("sqladmin", "public", "customers_pkey"))._args == ("public", None, "customers_pkey")`.
10. `SchemaIndexesQuery(NO_CONN, "public")._args == ("public", None, None, ["pg_catalog", "information_schema"])`; `SchemaIndexesQuery(NO_CONN, None)._args[0] is None`.
11. Every existing `get_result()` mapping in `test_table_structure.py` and `test_graph.py` is unchanged — same keys, same values, same order.
12. **Manual.** With two schemas each holding an index of the same name, each table's Structure tab lists only its own index, and the schema-wide Indexes category lists each once.

### Columns

13. `SchemaColumnsQuery.get_result()` over a row carrying `full_type = "character varying(60)"` and `default_expr = "'x'::text"` emits `"fullType": "character varying(60)"` and `"defaultExpr": "'x'::text"` in its payload — not `""` and `None`.
14. `ListColumnsQuery.get_columns_result()` produces the same `ColumnMeta` list it does today for both the `information_schema` rows and the `_MATVIEW_SQL` rows.
15. **Manual.** `GET /api/{connection}/{db}/{schema}/graph` returns a non-empty `fullType` for a `varchar(n)` column, and the schema diagram still renders.

### The shared guard

16. Each of the 27 migrated classes raises `RuntimeError` from `get_result()` (or `get_columns_result()`) when called before `apply()` — the 24 existing `test_*_before_apply_raises` tests must keep passing untouched.

### DDL builders

17. `drop_view("public", "v", cascade=True, if_exists=True)` == `DROP VIEW IF EXISTS "public"."v" CASCADE`.
18. `drop_materialized_view("public", "mv", if_exists=True)` == `DROP MATERIALIZED VIEW IF EXISTS "public"."mv"`.
19. `drop_view("public", "v")` and `drop_materialized_view("public", "mv")` are byte-identical to today's output.
20. All six other drop builders produce byte-identical output to today for every combination of `cascade`/`if_exists`.
21. `DropViewPreview(NO_CONN, {"schema": "public", "name": "v", "ifExists": True})`, after `build()`, has `get_result() == {"sql": 'DROP VIEW IF EXISTS "public"."v"'}`; the same spec without `ifExists` yields today's statement. Same for `DropMaterializedViewPreview`.
22. `drop_routine("public", "add", "function", "", True, False)` raises `TypeError` — `cascade`/`if_exists` are keyword-only.
23. `add_primary_key("public", "t", [])` raises `ValidationError("PRIMARY KEY requires at least one column")`; `add_unique("public", "t", [])` raises `ValidationError("UNIQUE requires at least one column")`.
24. `require_text("", "name")` and `require_text("   ", "name")` raise `ValidationError("'name' is required")`; `require_text(" x ", "name")` returns `" x "` unchanged.
25. `require_field({}, "name")`, `require_field({"name": ""}, "name")`, and `require_field({"name": 42}, "name")` each raise `ValidationError("'name' is required")`; `require_field({"name": "t"}, "name")` returns `"t"`.

---

## Verification

Run from `backend/` unless noted.

- `poetry run pytest` — the whole suite, after every phase.
- Type-check with pyright using `backend/pyproject.toml`'s `[tool.pyright]` config (`include = ["app", "tests"]`, standard mode).
- `cd frontend && npm run typecheck` — the only frontend change is the optional `DropSpec.ifExists` field.
- `grep -rln "get_result() called before apply()" backend/app/operations/` — exactly six files: `explain_query.py`, `insert_row.py`, `update_row.py`, `run_query.py`, `import_rows.py`, `ddl.py`.
- `grep -rn "_RELKIND_KIND\|_require_ident\|def _require(" backend/` — zero matches.
- `grep -rn "rename_view\|rename_materialized_view" backend/ frontend/src/` — zero matches.
- `grep -rn "_SYSTEM_SCHEMAS" backend/app/` — zero matches (replaced by `catalog.SYSTEM_SCHEMAS`).
- `grep -n "Operation" backend/app/operations/__init__.py` — zero matches.

Manual smoke tests, against `docker compose up -d db` plus a locally run backend and `npm run dev`:

- **The bug fix.** Run the partitioned-table SQL from `## Expected Behaviour` case 7 in the Query panel, refresh the navigator, then open the schema's Inheritance diagram. Expect a 200 with a single parent→child edge and no index nodes. Repeat the schema's Dependencies diagram to confirm it is unchanged.
- **Structure and diagrams.** Open a table's Structure tab (indexes, constraints, foreign keys all populated), the schema diagram, the database diagram, and the navigator's Indexes category. All four read the converged queries.
- **Columns.** Open a table's Structure tab and confirm the Type and Default columns still show `character varying(60)`-style values, then open the schema diagram and confirm the cards render.
- **Drop flows.** Drop a view and a materialized view through their dialogs; the previewed SQL must match today's (the UI never sets `ifExists`).

---

## Documentation Impact

The backend has no generated API docs; [`backend/README.md`](backend/README.md#L50)'s Layout section is its architecture map and is updated in step 36. `frontend/src/contract.ts` is the wire contract's own documentation — the new `DropSpec.ifExists` field carries a one-line comment there. No other doc page names the removed `rename_view`/`rename_materialized_view` or the removed `operations/__init__.py` re-export.

---

## Potential Challenges

- **`ListDependenciesQuery`'s alias swap.** Its old `source_*` columns become `target_*`. Follow the rename table in `## Architecture Decisions` literally when editing both the SQL and `tests/test_list_dependencies.py`; a silent swap would invert every dependency edge.
- **Parameter renumbering.** Phases 3 and 4 shift each schema-wide query's system-schema array from `$2` to `$3` or `$4`. The unit tests set `_raw` by hand and will not catch a wrong `$n`; the manual diagram checks are what catch it.
- **`SELECT DISTINCT` with the renamed `ORDER BY`.** `ListDependenciesQuery` orders by output aliases; after the rename the `ORDER BY` must read `source_name, target_name` or Postgres rejects the statement. This surfaces only against a real database.
- **f-string SQL assembly.** The fragments must be spliced with whitespace on both sides — `f"SELECT {INDEX_SELECT} {INDEX_FROM} ORDER BY …"` — or clauses run together. Keep each fragment a triple-quoted block that starts and ends with a newline.
- **`information_schema` cost on the per-table path.** The shared column sub-selects carry `$1`/`$2` scope predicates precisely so `/columns` keeps filtering early; dropping those predicates would make every table-open scan the whole catalog.

---

## Critical Files

- [`backend/app/operations/ddl.py:25-68`](backend/app/operations/ddl.py#L25) — `DdlPreview`, the base-with-default-`apply()`-and-guard pattern `CatalogQuery` mirrors.
- [`backend/app/operations/roles.py:18-45`](backend/app/operations/roles.py#L18) and [`role_detail.py:18-26`](backend/app/operations/role_detail.py#L18) — the shared-SQL-constant plus shared-row-mapper precedent `catalog.py` generalizes.
- [`backend/app/operations/base.py`](backend/app/operations/base.py) — the three-phase contract every migrated class still honours.
- [`backend/app/operations/common.py`](backend/app/operations/common.py) — the existing shared-helper module, scoped to the row operations.
- [`backend/app/sql/ddl.py:382-397`](backend/app/sql/ddl.py#L382) — `_constraint_prefix`, the private clause-helper precedent for `_drop_statement`.
- [`backend/app/operations/list_columns.py:27-118`](backend/app/operations/list_columns.py#L27) — the columns query and the comments explaining its two-arm `pg_depend` sub-select.
- [`plans/implemented/diagram-bulk-metadata.md:146-200`](plans/implemented/diagram-bulk-metadata.md#L146) — the worked transform that produced `graph.py`'s copies, and the reason the columns generalization is the delicate one.
- [`backend/tests/conftest.py:19`](backend/tests/conftest.py#L19) — `NO_CONN`, the offline test style every new test follows.
- [`backend/tests/test_table_structure.py`](backend/tests/test_table_structure.py) and [`test_graph.py`](backend/tests/test_graph.py) — the `_raw`-setting tests that must keep passing.
- `~/.claude/CODE_CONVENTIONS.md` — the Python docstring and typing rules every new function follows.

---

## Non-Goals

- **Migrating the write and no-I/O handlers onto a shared base.** The stored raw results of `InsertRowCommand`, `UpdateRowCommand`, `RunQueryCommand`, `ExplainQueryCommand`, `ImportRowsCommand`, `ExecuteDdlCommand`, and `PreviewImportRowsQuery` are heterogeneous — a single record, a command-status tag, a list of validated rows, an already-assembled dict — so one typed `_raw` field would not fit them without weakening the types. Their seven hand-written guards stay.
- **Collapsing `main.py`'s route table.** The audit's separate finding that ~24 preview routes share one body is a change to how routes are declared and discovered, and is called out there as needing its own design pass.
- **Surfacing IF EXISTS in the drop-view UI.** The backend accepts `ifExists` exactly as the six sibling drop flows do; no drop dialog offers the option today, and adding one is a product decision.
- **Adding builder-level validation to the table and view builders in `sql/ddl.py`.** The module's own section comment (lines 847-857) explains why only the schema/sequence/routine/type builders validate: the others have free-form expression slots reviewed in the editable preview instead.
- **The remaining Priority 1 and Priority 3 audit items** — the two boolean env-var parsers, login error handling, route registration order, `errors.ConflictError`, `Session.host`. They live in `config.py`, `auth.py`, `connections.py`, and `errors.py`, outside this plan's files.
- **Moving `ListColumnsQuery`'s materialized-view fallback into `catalog.py`.** It has exactly one caller and no twin to converge with.

---

## Implementation Notes

- **The Phase 1 checkpoint's "exactly six files" grep now matches seven.** Step 4 expected `grep -rln "get_result() called before apply()" backend/app/operations/` to list only the six hand-guarded write/no-I/O ops (`explain_query.py`, `update_row.py`, `insert_row.py`, `run_query.py`, `import_rows.py`, `ddl.py`). Centralizing the guard in `CatalogQuery._rows()` (`base.py`) means that literal string now also lives in `base.py` itself, so the same grep returns seven files. The check's intent — no module outside the sanctioned seven hand-rolls its own before-`apply()` guard — still holds; the plan's checkpoint text just predates the base class that now owns the message.
- **Four test files outside the plan's "Files to Modify" table were touched.** `test_table_structure.py` (Expected Behaviour items 8-9: `ListIndexesQuery`/`IndexDetailQuery` `_args` bind-position assertions), `test_ddl_sql.py` (item 24: `require_text`), and `test_execute_ddl.py` (item 25: `require_field`) each gained new test functions pinning testable behaviour this plan introduced, with no other listed file to put them in; none of those three files' pre-existing tests were edited. `test_ddl_table_sql.py` is also outside the table, and unlike the other three its *pre-existing* `test_add_primary_key_empty_columns_raises`/`test_add_unique_empty_columns_raises` were edited (adding `match=` to pin item 23's exact messages, caught by this loop's own audit round 1). `test_graph.py` *is* in the Files to Modify table (step 18's columns test) and its `test_columns_wraps_column_meta_as_payload` was edited exactly as that step specifies; it also gained two new tests beyond step 18, pinning item 10's `SchemaIndexesQuery` bind positions the same way as the four files above.

---

## Notes

[^why-subclass]: `CatalogQuery` is a new subclass rather than an extension of `Query` itself because three `Query` subclasses do not fetch rows at all and would silently inherit a broken default. `DdlPreview` and its 18 preview subclasses build SQL with no I/O, `ExportRowsQuery` streams through a server-side cursor and has no `_raw`, and `PreviewImportRowsQuery` validates in memory and stores a `_result` dict. Giving `Query` a default `apply()` that reads `self._SQL`/`self._args` would replace their clear `NotImplementedError` with an `AttributeError`. Keeping `Query` and `Command` as bare markers also preserves `base.py`'s documented role as the contract, with the machinery one level down.

[^why-not-common]: `common.py`'s own docstring scopes it to "the row operations" — `qualified()`, `single_pk()`, and `is_required_column()` all serve the insert/update/delete/import write path. The new material is read-path catalog introspection: ~250 lines of SQL fragments, catalog-code maps, and row mappers. Folding it into `common.py` would quintuple that module and fuse two unrelated concerns; one module per concern is the shape the rest of `operations/` already has.

[^scope-equivalence]: Each rewritten `WHERE` is logically identical to the one it replaces. For the per-table index queries, `i.schemaname = $1 AND n.nspname = $1` becomes `n.nspname = i.schemaname AND i.schemaname = $1` — given `i.schemaname = $1`, the two forms constrain `n.nspname` to the same value, so the old predicate at [`table_structure.py:57`](backend/app/operations/table_structure.py#L57) and [`:122`](backend/app/operations/table_structure.py#L122) was redundant rather than wrong, and the audit's suspicion of a second live bug there does not hold. The `n.nspname = ic.relnamespace` join still needs *some* schema disambiguation, because `JOIN pg_class ic ON ic.relname = i.indexname` matches by name across every schema. For the schema-wide queries, the added `($2::text IS NULL OR …)` predicates are bound `NULL` and evaluate true. For the columns query, moving the `pk`/`att` sub-selects from a column-name-only join to a `(schema, table, column)` join cannot change the result under a single-table filter, and is what makes them correct under a schema-wide one.

[^two-layer-guard]: The SQL filter alone cannot be unit-tested: the whole backend test suite is database-free and exercises `get_result()` by setting `_raw` by hand, so a test can only reach the shaper. The shaper's skip alone would leave both queries fetching rows they discard, and would leave `ListDependenciesQuery`'s existing SQL filter looking accidental. Two layers cost one `if` clause and make the fix both cheap at runtime and pinned by a test.

[^why-rename]: The alternative was a shaper taking source and target prefixes — `edge_rows(rows, "dependent", "source")` — which keeps the existing tests untouched. It was rejected because it preserves the exact naming collision that made this pair hard to read: `ListDependenciesQuery`'s `source_*` columns hold the edge's *target*, and every call site would have to restate that mapping correctly. Restating a mapping at each call site is how the relkind map drifted in the first place.

[^keep-builder-checks]: The audit calls `sql/ddl.py`'s `_require_ident` a redundant second validation, which is true of the *call* but not of the code. Removing the builder-level calls would contradict the module's own section comment ([`sql/ddl.py:847-857`](backend/app/sql/ddl.py#L847)), which states that schema and sequence builders validate in the builder because they have no editable-preview review step to lean on. That reasoning still holds and covers the routine and type builders too. The duplication worth removing is the five copies of the rule's implementation, not the defence in depth.

[^ifexists-end-to-end]: Adding `if_exists` to the two view builders without wiring it would create exactly the dead export this plan removes elsewhere. The six sibling drop previews all read `ifExists` off their spec while no dialog sets it — [`SchemaDdlForms.ts:92`](frontend/src/dock/SchemaDdlForms.ts#L92) records that as deliberate — so wiring the two view previews the same way makes the family uniform for one optional wire field and no UI change.
