"""
Per-table structure queries over ``pg_catalog`` — a table's indexes, its non-FK
constraints (primary key / unique / check), and its foreign keys with their
referenced relation and referential actions. Read-only; together they back the
combined ``/structure`` endpoint. The schema and table are always bound as query
parameters (``$1``/``$2``), never interpolated, so no identifier quoting is
needed and injection is impossible — the same discipline as ``role_detail``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from ..contract import TableRef
from .base import Query

# Map the single-char referential-action codes Postgres stores in
# ``pg_constraint.confupdtype``/``confdeltype`` to the SQL clause they render as.
# These four codes are fixed by the catalog format, not tunable.
_FK_ACTIONS: dict[str, str] = {
    "a": "NO ACTION",
    "r": "RESTRICT",
    "c": "CASCADE",
    "n": "SET NULL",
    "d": "SET DEFAULT",
}

# Map the ``pg_constraint.contype`` code for the non-FK constraint kinds this
# module surfaces to the contract's constraint-type string. Fixed by the catalog.
_CONSTRAINT_TYPES: dict[str, str] = {
    "p": "primaryKey",
    "u": "unique",
    "c": "check",
}


class ListIndexesQuery(Query):
    """
    The indexes on one table, each with its full ``CREATE INDEX`` text and the
    unique/primary flags (from ``pg_indexes`` joined to ``pg_index``).
    """

    _SQL = """
        SELECT
            i.indexname   AS name,
            i.indexdef    AS definition,
            ix.indisunique  AS unique,
            ix.indisprimary AS primary
        FROM pg_indexes i
        JOIN pg_class ic     ON ic.relname = i.indexname
        JOIN pg_namespace n  ON n.oid = ic.relnamespace
        JOIN pg_index ix     ON ix.indexrelid = ic.oid
        WHERE i.schemaname = $1 AND i.tablename = $2 AND n.nspname = $1
        ORDER BY i.indexname
    """

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the table to introspect.
        """
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the index metadata rows for the table.
        """
        self._raw = await self._conn.fetch(self._SQL, self._table.schema, self._table.name)

    def get_result(self) -> list[dict]:
        """
        Return one contract dict per index.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{name, definition, unique, primary}]`` ordered by index name.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [
            {
                "name": r["name"],
                "definition": r["definition"],
                "unique": bool(r["unique"]),
                "primary": bool(r["primary"]),
            }
            for r in self._raw
        ]


class ListConstraintsQuery(Query):
    """
    One table's non-FK constraints — primary key (``p``), unique (``u``), and
    check (``c``) — with the reconstructed clause from ``pg_get_constraintdef``.
    Foreign keys are excluded here; they get their own richer query.
    """

    _SQL = """
        SELECT
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
        WHERE con.contype IN ('p', 'u', 'c') AND n.nspname = $1 AND c.relname = $2
        ORDER BY con.contype, con.conname
    """

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the table to introspect.
        """
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the non-FK constraint rows for the table.
        """
        self._raw = await self._conn.fetch(self._SQL, self._table.schema, self._table.name)

    def get_result(self) -> list[dict]:
        """
        Return one contract dict per constraint.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{name, type, columns, definition}]`` where ``type`` is the mapped
            ``primaryKey``/``unique``/``check`` string.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [
            {
                "name": r["name"],
                "type": _CONSTRAINT_TYPES[r["contype"]],
                "columns": list(r["columns"]),
                "definition": r["definition"],
            }
            for r in self._raw
        ]


class ListForeignKeysQuery(Query):
    """
    One table's foreign keys, each with its local columns, referenced
    schema/table/columns, and the update/delete referential actions
    (``pg_constraint`` where ``contype='f'``).
    """

    _SQL = """
        SELECT
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
        WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
        ORDER BY con.conname
    """

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the table to introspect.
        """
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the foreign-key constraint rows for the table.
        """
        self._raw = await self._conn.fetch(self._SQL, self._table.schema, self._table.name)

    def get_result(self) -> list[dict]:
        """
        Return one contract dict per foreign key, mapping the action codes.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{name, columns, refSchema, refTable, refColumns, onUpdate,
            onDelete}]`` ordered by constraint name.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [
            {
                "name": r["name"],
                "columns": list(r["columns"]),
                "refSchema": r["ref_schema"],
                "refTable": r["ref_table"],
                "refColumns": list(r["ref_columns"]),
                "onUpdate": _FK_ACTIONS[r["on_update"]],
                "onDelete": _FK_ACTIONS[r["on_delete"]],
            }
            for r in self._raw
        ]
