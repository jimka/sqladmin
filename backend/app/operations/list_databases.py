"""
ListDatabasesQuery — the navigator's database level (pg_database).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from .base import Query


class ListDatabasesQuery(Query):
    """
    List the connection's non-template, connectable databases.
    """

    _SQL = (
        "SELECT datname AS name FROM pg_database "
        "WHERE datistemplate = false AND datallowconn = true "
        "ORDER BY datname"
    )

    def __init__(self, conn: asyncpg.Connection) -> None:
        """
        Capture the connection; no inputs to validate.
        """
        self._conn: asyncpg.Connection = conn
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the database rows.
        """
        self._raw = await self._conn.fetch(self._SQL)

    def get_result(self) -> list[dict]:
        """
        Return one entry per database.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"name": str}]``.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [{"name": r["name"]} for r in self._raw]
