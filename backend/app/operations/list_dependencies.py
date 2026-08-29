"""
ListDependenciesQuery — view/materialized-view dependency edges for a schema
(``pg_depend`` -> ``pg_rewrite`` -> ``pg_class``): "what does this view read?".
"""

from __future__ import annotations

import asyncpg

from .base import CatalogQuery
from .catalog import RELKIND_CODES, edge_rows


class ListDependenciesQuery(CatalogQuery):
    """
    View/matview dependency edges for a schema: source = the dependent view,
    target = the underlying relation it reads (``pg_depend``/``pg_rewrite``/
    ``pg_class``). Schema-scoped on the dependent's namespace; a dependent view
    living in a different schema than the table it reads is not discovered.
    Filters the target's relkind against ``RELKIND_CODES`` both in SQL and
    again in ``edge_rows()`` (the dependent side stays a fixed ``'v', 'm'`` —
    only a view/matview can depend on anything at all) — see the plan's
    "Unknown relkinds are dropped in SQL and again in the shaper".
    """

    _SQL = """
        SELECT DISTINCT
            dn.nspname       AS source_schema,
            dc.relname       AS source_name,
            dc.relkind::text AS source_kind,
            sn.nspname       AS target_schema,
            sc.relname       AS target_name,
            sc.relkind::text AS target_kind
        FROM pg_depend d
        JOIN pg_rewrite r    ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
        JOIN pg_class dc     ON dc.oid = r.ev_class
        JOIN pg_namespace dn ON dn.oid = dc.relnamespace
        JOIN pg_class sc     ON sc.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
        JOIN pg_namespace sn ON sn.oid = sc.relnamespace
        WHERE dn.nspname = $1
          AND dc.oid <> sc.oid
          AND dc.relkind IN ('v', 'm')
          AND sc.relkind = ANY($2::text[])
        ORDER BY source_name, target_name
    """

    def __init__(self, conn: asyncpg.Connection, schema: str) -> None:
        """
        Capture the connection and the schema to introspect.
        """
        super().__init__(conn, schema, list(RELKIND_CODES))

    def get_result(self) -> list[dict]:
        """
        Return one directed edge dict per dependency, mapping relkind to the
        contract kind.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{"source": {schema, name, kind}, "target": {schema, name, kind}}]``
            where source is the dependent view and target is the relation it reads.
        """
        return edge_rows(self._rows())
