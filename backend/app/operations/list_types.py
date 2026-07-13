"""
ListTypesQuery — the navigator's Types category: the standalone enum and
composite types in a schema, from ``pg_type`` (not ``pg_class``/
``ListObjectsQuery``; see ``plans/implemented/function-type-ddl.md``'s
listing decision).

Excludes array types (their ``typtype`` is ``'b'``, not ``'e'``/``'c'``, so
they never match the filter below) and table/view row types (a composite
``typtype`` whose ``typrelid`` points to a ``pg_class`` row that is a real
relation, not a type-only composite — gated by joining ``pg_class`` and
requiring ``relkind = 'c'``, or no backing relation at all for an enum).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from .base import Query


class ListTypesQuery(Query):
    """
    List the standalone enum and composite types in a schema.
    """

    _SQL = (
        "SELECT t.typname AS name "
        "FROM pg_catalog.pg_type t "
        "JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace "
        "LEFT JOIN pg_catalog.pg_class c ON c.oid = t.typrelid "
        "WHERE n.nspname = $1 "
        "AND t.typtype IN ('e', 'c') "
        "AND (t.typrelid = 0 OR c.relkind = 'c') "
        "ORDER BY t.typname"
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
        Fetch the type rows for the schema.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema)

    def get_result(self) -> list[dict]:
        """
        Return one entry per type.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"name": str}]``, name-ordered.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [{"name": r["name"]} for r in self._raw]
