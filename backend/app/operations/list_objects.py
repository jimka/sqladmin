"""
ListObjectsQuery — the navigator's table/view level (information_schema.tables).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from .base import Query


class ListObjectsQuery(Query):
    """
    List the tables and views in a schema, tagged by kind.
    """

    _SQL = (
        "SELECT table_name AS name, "
        "CASE table_type WHEN 'VIEW' THEN 'view' ELSE 'table' END AS kind "
        "FROM information_schema.tables WHERE table_schema = $1 "
        "ORDER BY table_name"
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
        Fetch the table/view rows for the schema.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema)

    def get_result(self) -> list[dict]:
        """
        Return one entry per object.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"name": str, "kind": "table" | "view"}]``.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [{"name": r["name"], "kind": r["kind"]} for r in self._raw]
