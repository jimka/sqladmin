"""
ListDatabasesQuery — the navigator's database level (pg_database).
"""

from __future__ import annotations

import asyncpg

from .base import CatalogQuery


class ListDatabasesQuery(CatalogQuery):
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
        super().__init__(conn)

    def get_result(self) -> list[dict]:
        """
        Return one entry per database.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"name": str}]``.
        """
        return [{"name": r["name"]} for r in self._rows()]
