"""
ListInheritanceQuery — table inheritance/partitioning edges for a schema
(``pg_inherits``/``pg_class``): parent -> child, covering both classic
inheritance and declarative partitioning.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from .base import Query

# pg_class.relkind -> the contract DbObjectKind. Partitioned ('p') and foreign
# ('f') tables collapse to "table"; fixed by the catalog format.
_RELKIND_KIND: dict[str, str] = {"r": "table", "p": "table", "f": "table", "v": "view", "m": "materializedView"}


class ListInheritanceQuery(Query):
    """
    Parent -> child inheritance/partition edges for a schema (``pg_inherits``
    joined to ``pg_class``). Schema-scoped on the parent's namespace; a child
    living in a different schema than its parent is still discovered (only the
    parent's schema gates the query).
    """

    _SQL = """
        SELECT
            pn.nspname AS parent_schema, p.relname AS parent_name, p.relkind::text AS parent_kind,
            cn.nspname AS child_schema,  c.relname  AS child_name,  c.relkind::text AS child_kind
        FROM pg_inherits i
        JOIN pg_class p      ON p.oid = i.inhparent
        JOIN pg_class c      ON c.oid = i.inhrelid
        JOIN pg_namespace pn ON pn.oid = p.relnamespace
        JOIN pg_namespace cn ON cn.oid = c.relnamespace
        WHERE pn.nspname = $1
        ORDER BY parent_name, child_name
    """

    def __init__(self, conn: asyncpg.Connection, schema: str) -> None:
        """
        Capture the connection and the schema to introspect.
        """
        self._conn: asyncpg.Connection = conn
        self._schema: str = schema
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the inheritance edge rows for the schema.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema)

    def get_result(self) -> list[dict]:
        """
        Return one directed edge dict per inheritance relationship, mapping
        relkind to the contract kind.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"source": {schema, name, kind}, "target": {schema, name, kind}}]``
            where source is the parent and target is the child.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [
            {
                "source": {
                    "schema": r["parent_schema"],
                    "name": r["parent_name"],
                    "kind": _RELKIND_KIND[r["parent_kind"]],
                },
                "target": {
                    "schema": r["child_schema"],
                    "name": r["child_name"],
                    "kind": _RELKIND_KIND[r["child_kind"]],
                },
            }
            for r in self._raw
        ]
