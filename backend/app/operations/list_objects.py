"""
ListObjectsQuery — the navigator's table/view/matview/sequence level.

Tables and regular views come from ``information_schema.tables``; materialized
views and sequences (which the SQL-standard ``information_schema`` omits, or
which ``information_schema.sequences`` only exposes subject to its own
privilege-visibility rules) are unioned in from ``pg_catalog.pg_class`` so
every kind surfaces in one round-trip.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from .base import Query

# One SELECT per object kind, UNION ALL'd into the query below. A phase that
# adds a new listed kind (schema-sequence-ddl added the sequence fragment;
# function-type-ddl adds functions/types) appends one element here — a
# distinct, additive line rather than an edit to one shared string, so two
# phases adding kinds in parallel don't collide on the same line.
_OBJECT_SELECTS: tuple[str, ...] = (
    # tables + regular views (information_schema)
    "SELECT table_name AS name, "
    "CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind "
    "FROM information_schema.tables WHERE table_schema = $1",
    # materialized views (pg_class relkind 'm')
    "SELECT c.relname AS name, 'materializedView' AS kind "
    "FROM pg_catalog.pg_class c "
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
    "WHERE c.relkind = 'm' AND n.nspname = $1",
    # sequences (pg_class relkind 'S') — added by schema-sequence-ddl
    "SELECT c.relname AS name, 'sequence' AS kind "
    "FROM pg_catalog.pg_class c "
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
    "WHERE c.relkind = 'S' AND n.nspname = $1",
)


class ListObjectsQuery(Query):
    """
    List the tables, views, materialized views, and sequences in a schema,
    tagged by kind.
    """

    _SQL = " UNION ALL ".join(_OBJECT_SELECTS) + " ORDER BY name"

    def __init__(self, conn: asyncpg.Connection, schema: str) -> None:
        """
        Capture the connection and the schema to list.
        """
        self._conn: asyncpg.Connection = conn
        self._schema: str = schema
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the table/view/matview rows for the schema.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema)

    def get_result(self) -> list[dict]:
        """
        Return one entry per object.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"name": str, "kind": "table" | "view" | "materializedView" |
            "sequence"}]``.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [{"name": r["name"], "kind": r["kind"]} for r in self._raw]
