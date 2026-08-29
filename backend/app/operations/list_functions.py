"""
ListFunctionsQuery — the navigator's Functions category: the functions and
procedures in a schema, from ``pg_proc`` (not ``pg_class``/``ListObjectsQuery``
— a routine's identity-argument signature has no home in that flat
``{name, kind}`` shape; see ``plans/implemented/function-type-ddl.md``'s
listing decision).

``prokind`` is filtered to plain functions (``'f'``) and procedures (``'p'``)
only, excluding aggregates and window functions (out of scope — see the
plan's Non-Goals).
"""

from __future__ import annotations

import asyncpg

from .base import CatalogQuery


class ListFunctionsQuery(CatalogQuery):
    """
    List the functions and procedures in a schema, each carrying its
    identity-argument signature so an overload can be opened/edited/dropped
    unambiguously.
    """

    _SQL = (
        "SELECT p.proname AS name, "
        "pg_get_function_identity_arguments(p.oid) AS signature, "
        "p.prokind = 'p' AS is_procedure "
        "FROM pg_catalog.pg_proc p "
        "JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace "
        "WHERE n.nspname = $1 AND p.prokind IN ('f', 'p') "
        "ORDER BY p.proname, signature"
    )

    def __init__(self, conn: asyncpg.Connection, schema: str) -> None:
        """
        Capture the connection and the schema to list.
        """
        super().__init__(conn, schema)

    def get_result(self) -> list[dict]:
        """
        Return one entry per function/procedure.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"name": str, "signature": str, "isProcedure": bool}]``, name/
            signature ordered.
        """
        return [
            {"name": r["name"], "signature": r["signature"], "isProcedure": r["is_procedure"]}
            for r in self._rows()
        ]
