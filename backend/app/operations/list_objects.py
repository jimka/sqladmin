"""
ListObjectsQuery — the navigator's table/view/matview level.

Tables and regular views come from ``information_schema.tables``; materialized
views (which the SQL-standard ``information_schema`` omits) are unioned in from
``pg_catalog.pg_class`` so all three kinds surface in one round-trip.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from .base import Query


class ListObjectsQuery(Query):
    """
    List the tables, views, and materialized views in a schema, tagged by kind.
    """

    _SQL = (
        "SELECT table_name AS name, "
        "CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind "
        "FROM information_schema.tables WHERE table_schema = $1 "
        "UNION ALL "
        "SELECT c.relname AS name, 'materializedView' AS kind "
        "FROM pg_catalog.pg_class c "
        "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
        "WHERE c.relkind = 'm' AND n.nspname = $1 "
        "ORDER BY name"
    )

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
            ``[{"name": str, "kind": "table" | "view" | "materializedView"}]``.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [{"name": r["name"], "kind": r["kind"]} for r in self._raw]
