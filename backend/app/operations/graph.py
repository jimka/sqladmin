"""
Bulk schema/database ER-diagram metadata: five queries that generalize the
per-table structure/columns queries (``table_structure.py`` / ``list_columns.py``)
by replacing their table filter with a schema/database scope guard, each
returning a flat list of rows tagged with ``schema``/``table``. Two pure
assembly helpers group those flat rows into the frontend's per-table
(schema-graph) / per-schema-then-table (database-graph) shape. Backs the
``/graph`` routes, which fetch a whole diagram's metadata in one round trip
instead of the frontend's previous one-``/structure``-plus-one-``/columns``
request per table.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from ..contract import ColumnMeta, SequenceRef
from ..wire import pg_type_to_wire
from .base import Query
from .table_structure import _CONSTRAINT_TYPES, _FK_ACTIONS

# Excluded from every schema/database-wide query below, mirroring
# list_schemas.py's own copy of this same catalog-scoping constant.
_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema")


class SchemaTablesQuery(Query):
    """
    Base-table names in scope: a concrete schema restricts to it; ``None``
    spans every non-system schema in the database. The authoritative node set
    for both graph endpoints — a table with no columns/indexes/constraints/
    foreign keys still becomes a node.
    """

    _SQL = """
        SELECT table_schema AS schema, table_name AS table
        FROM information_schema.tables
        WHERE table_type <> 'VIEW'
          AND ($1::text IS NULL OR table_schema = $1)
          AND table_schema <> ALL($2::text[])
        ORDER BY table_schema, table_name
    """

    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None:
        """
        Capture the connection and the schema scope (``None`` = whole database).
        """
        self._conn: asyncpg.Connection = conn
        self._schema: str | None = schema
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the base-table rows in scope.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema, list(_SYSTEM_SCHEMAS))

    def get_result(self) -> list[dict]:
        """
        Return one ``{schema, table}`` dict per base table.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"schema": str, "table": str}]`` ordered by schema then table.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [{"schema": r["schema"], "table": r["table"]} for r in self._raw]


class SchemaColumnsQuery(Query):
    """
    Every base table's columns in scope, generalizing ``ListColumnsQuery``.
    The matview fallback there is dropped: ``SchemaTablesQuery`` excludes
    views/matviews, so this only ever needs the ``information_schema`` path.
    """

    # Both the ``pk`` and ``seq`` sub-selects carry (schema, table) throughout
    # — dropped, primary-key/sequence rows would attribute to the wrong table
    # whenever a column name repeats across tables. See ListColumnsQuery's
    # docstring for the seq sub-select's two-arm rationale (OWNED BY vs.
    # DEFAULT nextval()); the arms are unchanged here, just table-qualified.
    _SQL = """
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
         AND t.table_type  <> 'VIEW'
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
    """

    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None:
        """
        Capture the connection and the schema scope (``None`` = whole database).
        """
        self._conn: asyncpg.Connection = conn
        self._schema: str | None = schema
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the column metadata rows in scope.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema, list(_SYSTEM_SCHEMAS))

    def get_result(self) -> list[dict]:
        """
        Return one ``{schema, table, payload}`` dict per column, ``payload``
        the same ``ColumnMeta`` contract shape ``/columns`` emits.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"schema", "table", "payload": <ColumnMeta contract>}]``,
            ordinal-position order preserved within each table.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        result = []

        for r in self._raw:
            meta = ColumnMeta(
                name=r["name"],
                data_type=r["data_type"],
                nullable=r["nullable"],
                is_primary_key=r["is_primary_key"],
                is_generated=r["is_generated"],
                has_default=r["has_default"],
                wire_type=pg_type_to_wire(r["data_type"]),
                sequence=(
                    SequenceRef(schema=r["sequence_schema"], name=r["sequence_name"])
                    if r["sequence_schema"] is not None
                    else None
                ),
            )
            result.append({"schema": r["schema"], "table": r["table"], "payload": meta.to_contract()})

        return result


class SchemaIndexesQuery(Query):
    """
    Every base table's indexes in scope, generalizing ``ListIndexesQuery``.
    """

    # The original's `n.nspname = $1` join predicate is redundant with
    # `i.schemaname = $1` under a single-table filter (both sides always equal
    # the same schema), but scoped to many schemas that redundancy would drop
    # rows outside `$1` even when `$1` is NULL — replaced with `n.nspname =
    # i.schemaname` so the join stays correct across every schema in scope.
    _SQL = """
        SELECT
            i.schemaname AS schema,
            i.tablename  AS table,
            i.indexname   AS name,
            i.indexdef    AS definition,
            ix.indisunique  AS unique,
            ix.indisprimary AS primary
        FROM pg_indexes i
        JOIN pg_class ic     ON ic.relname = i.indexname
        JOIN pg_namespace n  ON n.oid = ic.relnamespace
        JOIN pg_index ix     ON ix.indexrelid = ic.oid
        WHERE n.nspname = i.schemaname
          AND ($1::text IS NULL OR i.schemaname = $1)
          AND i.schemaname <> ALL($2::text[])
        ORDER BY i.schemaname, i.tablename, i.indexname
    """

    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None:
        """
        Capture the connection and the schema scope (``None`` = whole database).
        """
        self._conn: asyncpg.Connection = conn
        self._schema: str | None = schema
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the index metadata rows in scope.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema, list(_SYSTEM_SCHEMAS))

    def get_result(self) -> list[dict]:
        """
        Return one ``{schema, table, payload}`` dict per index.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"schema", "table", "payload": {name, definition, unique, primary}}]``.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [
            {
                "schema": r["schema"],
                "table": r["table"],
                "payload": {
                    "name": r["name"],
                    "definition": r["definition"],
                    "unique": bool(r["unique"]),
                    "primary": bool(r["primary"]),
                },
            }
            for r in self._raw
        ]


class SchemaConstraintsQuery(Query):
    """
    Every base table's non-FK constraints in scope, generalizing
    ``ListConstraintsQuery``.
    """

    _SQL = """
        SELECT
            n.nspname AS schema,
            c.relname AS table,
            con.conname AS name,
            con.contype::text AS contype,
            pg_get_constraintdef(con.oid) AS definition,
            ARRAY(
                SELECT a.attname
                FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                ORDER BY k.ord
            ) AS columns
        FROM pg_constraint con
        JOIN pg_class c     ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype IN ('p', 'u', 'c')
          AND ($1::text IS NULL OR n.nspname = $1)
          AND n.nspname <> ALL($2::text[])
        ORDER BY n.nspname, c.relname, con.contype, con.conname
    """

    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None:
        """
        Capture the connection and the schema scope (``None`` = whole database).
        """
        self._conn: asyncpg.Connection = conn
        self._schema: str | None = schema
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the non-FK constraint rows in scope.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema, list(_SYSTEM_SCHEMAS))

    def get_result(self) -> list[dict]:
        """
        Return one ``{schema, table, payload}`` dict per constraint, mapping
        ``contype`` to the contract's type string.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"schema", "table", "payload": {name, type, columns, definition}}]``.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [
            {
                "schema": r["schema"],
                "table": r["table"],
                "payload": {
                    "name": r["name"],
                    "type": _CONSTRAINT_TYPES[r["contype"]],
                    "columns": list(r["columns"]),
                    "definition": r["definition"],
                },
            }
            for r in self._raw
        ]


class SchemaForeignKeysQuery(Query):
    """
    Every base table's foreign keys in scope, generalizing
    ``ListForeignKeysQuery``.
    """

    _SQL = """
        SELECT
            n.nspname AS schema,
            c.relname AS table,
            con.conname AS name,
            con.confupdtype::text AS on_update,
            con.confdeltype::text AS on_delete,
            nr.nspname AS ref_schema,
            cr.relname AS ref_table,
            ARRAY(
                SELECT a.attname
                FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                ORDER BY k.ord
            ) AS columns,
            ARRAY(
                SELECT a.attname
                FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                ORDER BY k.ord
            ) AS ref_columns
        FROM pg_constraint con
        JOIN pg_class c      ON c.oid = con.conrelid
        JOIN pg_namespace n  ON n.oid = c.relnamespace
        JOIN pg_class cr     ON cr.oid = con.confrelid
        JOIN pg_namespace nr ON nr.oid = cr.relnamespace
        WHERE con.contype = 'f'
          AND ($1::text IS NULL OR n.nspname = $1)
          AND n.nspname <> ALL($2::text[])
        ORDER BY n.nspname, c.relname, con.conname
    """

    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None:
        """
        Capture the connection and the schema scope (``None`` = whole database).
        """
        self._conn: asyncpg.Connection = conn
        self._schema: str | None = schema
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the foreign-key constraint rows in scope.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema, list(_SYSTEM_SCHEMAS))

    def get_result(self) -> list[dict]:
        """
        Return one ``{schema, table, payload}`` dict per foreign key, mapping
        the action codes.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"schema", "table", "payload": {name, columns, refSchema,
            refTable, refColumns, onUpdate, onDelete}}]``.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [
            {
                "schema": r["schema"],
                "table": r["table"],
                "payload": {
                    "name": r["name"],
                    "columns": list(r["columns"]),
                    "refSchema": r["ref_schema"],
                    "refTable": r["ref_table"],
                    "refColumns": list(r["ref_columns"]),
                    "onUpdate": _FK_ACTIONS[r["on_update"]],
                    "onDelete": _FK_ACTIONS[r["on_delete"]],
                },
            }
            for r in self._raw
        ]


def _group_payloads_by_table(rows: list[dict]) -> dict[str, list[dict]]:
    """
    Bucket a facet's rows by table name, unwrapping each to its bare payload.

    Args:
        rows: rows shaped ``{"schema", "table", "payload"}`` from one of the
            five queries above.

    Returns:
        ``{table: [payload, ...]}``, preserving each row's input order.
    """
    grouped: dict[str, list[dict]] = {}

    for row in rows:
        grouped.setdefault(row["table"], []).append(row["payload"])

    return grouped


def _group_payloads_by_schema_table(rows: list[dict]) -> dict[tuple[str, str], list[dict]]:
    """
    Bucket a facet's rows by ``(schema, table)``, unwrapping each to its bare
    payload — the database-graph counterpart of ``_group_payloads_by_table``,
    needed because two schemas can share a table name.

    Args:
        rows: rows shaped ``{"schema", "table", "payload"}`` from one of the
            four structure queries above.

    Returns:
        ``{(schema, table): [payload, ...]}``, preserving each row's input order.
    """
    grouped: dict[tuple[str, str], list[dict]] = {}

    for row in rows:
        grouped.setdefault((row["schema"], row["table"]), []).append(row["payload"])

    return grouped


def assemble_schema_graph(
    tables: list[dict],
    columns: list[dict],
    indexes: list[dict],
    constraints: list[dict],
    foreign_keys: list[dict],
) -> list[dict]:
    """
    Assemble one schema's ER-graph metadata from its flat per-facet query
    results — the ``SchemaGraph`` contract's ``tables`` array.

    Args:
        tables: the authoritative node set, ``[{"schema", "table"}]`` from
            ``SchemaTablesQuery``.
        columns: ``SchemaColumnsQuery`` rows.
        indexes: ``SchemaIndexesQuery`` rows.
        constraints: ``SchemaConstraintsQuery`` rows.
        foreign_keys: ``SchemaForeignKeysQuery`` rows.

    Returns:
        ``[{"name", "structure": {"indexes", "constraints", "foreignKeys"},
        "columns"}]``, one entry per table in ``tables``, sorted by name. A
        table with no rows in a given facet gets an empty list for it.
    """
    columns_by_table     = _group_payloads_by_table(columns)
    indexes_by_table     = _group_payloads_by_table(indexes)
    constraints_by_table = _group_payloads_by_table(constraints)
    fks_by_table         = _group_payloads_by_table(foreign_keys)

    return [
        {
            "name": t["table"],
            "structure": {
                "indexes": indexes_by_table.get(t["table"], []),
                "constraints": constraints_by_table.get(t["table"], []),
                "foreignKeys": fks_by_table.get(t["table"], []),
            },
            "columns": columns_by_table.get(t["table"], []),
        }
        for t in sorted(tables, key=lambda t: t["table"])
    ]


def assemble_database_graph(
    tables: list[dict],
    indexes: list[dict],
    constraints: list[dict],
    foreign_keys: list[dict],
) -> list[dict]:
    """
    Assemble a whole database's ER-graph metadata from its flat per-facet
    query results — the ``DatabaseGraph`` contract's ``schemas`` array.
    Structure-only (no columns): a whole-database column dump could be large,
    and the database diagram never renders column rows.

    Args:
        tables: the authoritative node set, ``[{"schema", "table"}]`` from
            ``SchemaTablesQuery`` run with ``schema=None``.
        indexes: ``SchemaIndexesQuery`` rows.
        constraints: ``SchemaConstraintsQuery`` rows.
        foreign_keys: ``SchemaForeignKeysQuery`` rows.

    Returns:
        ``[{"schema", "tables": [{"name", "structure"}]}]``, grouped by schema
        then table (each sorted by name), every schema present even when one
        of its tables has zero foreign keys. Same-named tables in different
        schemas stay distinct — the grouping key is ``(schema, table)``.
    """
    indexes_by_table     = _group_payloads_by_schema_table(indexes)
    constraints_by_table = _group_payloads_by_schema_table(constraints)
    fks_by_table         = _group_payloads_by_schema_table(foreign_keys)

    tables_by_schema: dict[str, list[dict]] = {}

    for t in sorted(tables, key=lambda t: (t["schema"], t["table"])):
        key = (t["schema"], t["table"])
        tables_by_schema.setdefault(t["schema"], []).append({
            "name": t["table"],
            "structure": {
                "indexes": indexes_by_table.get(key, []),
                "constraints": constraints_by_table.get(key, []),
                "foreignKeys": fks_by_table.get(key, []),
            },
        })

    return [{"schema": schema, "tables": tables_by_schema[schema]} for schema in sorted(tables_by_schema)]
