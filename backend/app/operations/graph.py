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

import asyncpg

from .base import CatalogQuery
from .catalog import (
    COLUMN_FROM,
    COLUMN_SELECT,
    CONSTRAINT_FROM,
    CONSTRAINT_SELECT,
    FOREIGN_KEY_FROM,
    FOREIGN_KEY_SELECT,
    INDEX_FROM,
    INDEX_SELECT,
    SYSTEM_SCHEMAS,
    column_meta,
    constraint_payload,
    foreign_key_payload,
    index_payload,
)


class SchemaTablesQuery(CatalogQuery):
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
        super().__init__(conn, schema, list(SYSTEM_SCHEMAS))

    def get_result(self) -> list[dict]:
        """
        Return one ``{schema, table}`` dict per base table.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"schema": str, "table": str}]`` ordered by schema then table.
        """
        return [{"schema": r["schema"], "table": r["table"]} for r in self._rows()]


class SchemaColumnsQuery(CatalogQuery):
    """
    Every base table's columns in scope, generalizing ``ListColumnsQuery``. An
    ``EXISTS`` guard against ``information_schema.tables`` (excluding views)
    keeps this to base tables only — ``SchemaTablesQuery``'s own node set —
    so no matview fallback is needed here.
    """

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

    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None:
        """
        Capture the connection and the schema scope (``None`` = whole database).
        """
        super().__init__(conn, schema, None, list(SYSTEM_SCHEMAS))

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
        return [
            {"schema": r["schema"], "table": r["table"], "payload": column_meta(r).to_contract()}
            for r in self._rows()
        ]


class SchemaIndexesQuery(CatalogQuery):
    """
    Every base table's indexes in scope, generalizing ``ListIndexesQuery``.
    """

    _SQL = (
        f"SELECT i.schemaname AS schema, i.tablename AS table, {INDEX_SELECT} {INDEX_FROM} "
        "AND i.schemaname <> ALL($4::text[]) "
        "ORDER BY i.schemaname, i.tablename, i.indexname"
    )

    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None:
        """
        Capture the connection and the schema scope (``None`` = whole database).
        """
        super().__init__(conn, schema, None, None, list(SYSTEM_SCHEMAS))

    def get_result(self) -> list[dict]:
        """
        Return one ``{schema, table, payload}`` dict per index.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"schema", "table", "payload": {name, definition, unique, primary}}]``.
        """
        return [{"schema": r["schema"], "table": r["table"], "payload": index_payload(r)} for r in self._rows()]


class SchemaConstraintsQuery(CatalogQuery):
    """
    Every base table's non-FK constraints in scope, generalizing
    ``ListConstraintsQuery``.
    """

    _SQL = (
        f"SELECT n.nspname AS schema, c.relname AS table, {CONSTRAINT_SELECT} {CONSTRAINT_FROM} "
        "AND n.nspname <> ALL($3::text[]) "
        "ORDER BY n.nspname, c.relname, con.contype, con.conname"
    )

    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None:
        """
        Capture the connection and the schema scope (``None`` = whole database).
        """
        super().__init__(conn, schema, None, list(SYSTEM_SCHEMAS))

    def get_result(self) -> list[dict]:
        """
        Return one ``{schema, table, payload}`` dict per constraint, mapping
        ``contype`` to the contract's type string.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"schema", "table", "payload": {name, type, columns, definition}}]``.
        """
        return [
            {"schema": r["schema"], "table": r["table"], "payload": constraint_payload(r)}
            for r in self._rows()
        ]


class SchemaForeignKeysQuery(CatalogQuery):
    """
    Every base table's foreign keys in scope, generalizing
    ``ListForeignKeysQuery``.
    """

    _SQL = (
        f"SELECT n.nspname AS schema, c.relname AS table, {FOREIGN_KEY_SELECT} {FOREIGN_KEY_FROM} "
        "AND n.nspname <> ALL($3::text[]) "
        "ORDER BY n.nspname, c.relname, con.conname"
    )

    def __init__(self, conn: asyncpg.Connection, schema: str | None) -> None:
        """
        Capture the connection and the schema scope (``None`` = whole database).
        """
        super().__init__(conn, schema, None, list(SYSTEM_SCHEMAS))

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
        return [
            {"schema": r["schema"], "table": r["table"], "payload": foreign_key_payload(r)}
            for r in self._rows()
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


def flatten_schema_indexes(rows: list[dict]) -> list[dict]:
    """
    Flatten ``SchemaIndexesQuery``'s ``{schema, table, payload}`` rows into the
    navigator's Indexes-category wire shape, backing the schema-wide
    ``/indexes`` route. Reuses ``SchemaIndexesQuery`` rather than a new
    per-list ``Query`` class (see the plan's Architecture Decisions).

    Args:
        rows: ``SchemaIndexesQuery.get_result()``'s rows.

    Returns:
        ``[{name, definition, unique, primary, table}]``, preserving input
        order (``SchemaIndexesQuery`` already orders by schema, table, name).
    """
    return [{**row["payload"], "table": row["table"]} for row in rows]
