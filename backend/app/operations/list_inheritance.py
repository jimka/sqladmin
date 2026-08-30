"""
ListInheritanceQuery — table inheritance/partitioning edges for a schema
(``pg_inherits``/``pg_class``): parent -> child, covering both classic
inheritance and declarative partitioning.
"""

from __future__ import annotations

import asyncpg

from .base import CatalogQuery
from .catalog import RELKIND_CODES, edge_rows


class ListInheritanceQuery(CatalogQuery):
    """
    Parent -> child inheritance/partition edges for a schema (``pg_inherits``
    joined to ``pg_class``). Schema-scoped on the parent's namespace; a child
    living in a different schema than its parent is still discovered (only the
    parent's schema gates the query). Filters out any endpoint whose relkind is
    not in ``RELKIND_CODES`` (e.g. a partitioned index's own child index,
    codes ``I``/``i``) both in SQL and again in ``edge_rows()`` — see the
    plan's "Unknown relkinds are dropped in SQL and again in the shaper".
    """

    _SQL = """
        SELECT
            pn.nspname AS source_schema, p.relname AS source_name, p.relkind::text AS source_kind,
            cn.nspname AS target_schema, c.relname  AS target_name, c.relkind::text AS target_kind
        FROM pg_inherits i
        JOIN pg_class p      ON p.oid = i.inhparent
        JOIN pg_class c      ON c.oid = i.inhrelid
        JOIN pg_namespace pn ON pn.oid = p.relnamespace
        JOIN pg_namespace cn ON cn.oid = c.relnamespace
        WHERE pn.nspname = $1
          AND p.relkind = ANY($2::text[])
          AND c.relkind = ANY($2::text[])
        ORDER BY source_name, target_name
    """

    def __init__(self, conn: asyncpg.Connection, schema: str) -> None:
        """
        Capture the connection and the schema to introspect.
        """
        super().__init__(conn, schema, list(RELKIND_CODES))

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
        return edge_rows(self._rows())
