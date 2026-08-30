"""
ViewDefinitionQuery — the reconstructed ``SELECT`` behind a regular or
materialized view, via ``pg_get_viewdef``.

The relation is located by schema + name in ``pg_catalog`` and gated to view
kinds (``relkind IN ('v', 'm')``) so a table by the same name never leaks its
(nonexistent) definition. Both identifiers are bound as query parameters
(``$1``/``$2``), never interpolated, so no identifier quoting is needed.
"""

from __future__ import annotations

import asyncpg

from ..contract import TableRef
from ..errors import NotFound
from .base import CatalogQuery


class ViewDefinitionQuery(CatalogQuery):
    """
    Fetch a view/matview's ``pg_get_viewdef`` definition SQL.
    """

    _SQL = (
        "SELECT pg_get_viewdef(c.oid, true) AS definition "
        "FROM pg_catalog.pg_class c "
        "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('v', 'm')"
    )

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the (materialized) view to introspect.
        """
        super().__init__(conn, table.schema, table.name)
        self._table: TableRef = table

    def get_result(self) -> dict:
        """
        Return the view's definition SQL.

        Raises:
            RuntimeError: if called before ``apply()``.
            NotFound: if no view/matview by that name exists.

        Returns:
            ``{"definition": str}`` — the reconstructed ``SELECT``.
        """
        rows = self._rows()

        if not rows:
            raise NotFound(f"View '{self._table.schema}.{self._table.name}' not found")

        return {"definition": rows[0]["definition"]}
