"""
ListSchemasQuery — the navigator's schema level (information_schema.schemata).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from .base import Query

_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema")


class ListSchemasQuery(Query):
    """
    List the non-system schemas in a database.
    """

    _SQL = (
        "SELECT schema_name AS name FROM information_schema.schemata "
        "WHERE schema_name <> ALL($1::text[]) "
        "AND schema_name NOT LIKE 'pg_temp%' AND schema_name NOT LIKE 'pg_toast%' "
        "ORDER BY schema_name"
    )

    def __init__(self, conn: asyncpg.Connection, database: str) -> None:
        """
        Capture the connection and the (multi-DB seam) database name.
        """
        self._conn: asyncpg.Connection = conn
        self._database: str = database  # carried for the multi-DB seam
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the schema rows, excluding system schemas.
        """
        self._raw = await self._conn.fetch(self._SQL, list(_SYSTEM_SCHEMAS))

    def get_result(self) -> list[dict]:
        """
        Return one entry per schema.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"name": str}]``.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [{"name": r["name"]} for r in self._raw]
