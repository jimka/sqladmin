"""
ListSchemasQuery — the navigator's schema level (information_schema.schemata).
"""

from __future__ import annotations

import asyncpg

from .base import CatalogQuery

_SYSTEM_SCHEMAS = ("pg_catalog", "information_schema")


class ListSchemasQuery(CatalogQuery):
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
        super().__init__(conn, list(_SYSTEM_SCHEMAS))
        self._database: str = database  # carried for the multi-DB seam

    def get_result(self) -> list[dict]:
        """
        Return one entry per schema.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"name": str}]``.
        """
        return [{"name": r["name"]} for r in self._rows()]
