"""
ListDependenciesQuery — view/materialized-view dependency edges for a schema
(``pg_depend`` -> ``pg_rewrite`` -> ``pg_class``): "what does this view read?".
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from .base import Query

# pg_class.relkind -> the contract DbObjectKind. Partitioned ('p') and foreign
# ('f') tables collapse to "table"; fixed by the catalog format.
_RELKIND_KIND: dict[str, str] = {"r": "table", "p": "table", "f": "table", "v": "view", "m": "materializedView"}


class ListDependenciesQuery(Query):
    """
    View/matview dependency edges for a schema: source = the dependent view,
    target = the underlying relation it reads (``pg_depend``/``pg_rewrite``/
    ``pg_class``). Schema-scoped on the dependent's namespace; a dependent view
    living in a different schema than the table it reads is not discovered.
    """

    _SQL = """
        SELECT DISTINCT
            dn.nspname       AS dependent_schema,
            dc.relname       AS dependent_name,
            dc.relkind::text AS dependent_kind,
            sn.nspname       AS source_schema,
            sc.relname       AS source_name,
            sc.relkind::text AS source_kind
        FROM pg_depend d
        JOIN pg_rewrite r    ON r.oid = d.objid AND d.classid = 'pg_rewrite'::regclass
        JOIN pg_class dc     ON dc.oid = r.ev_class
        JOIN pg_namespace dn ON dn.oid = dc.relnamespace
        JOIN pg_class sc     ON sc.oid = d.refobjid AND d.refclassid = 'pg_class'::regclass
        JOIN pg_namespace sn ON sn.oid = sc.relnamespace
        WHERE dn.nspname = $1
          AND dc.oid <> sc.oid
          AND dc.relkind IN ('v', 'm')
          AND sc.relkind IN ('r', 'v', 'm', 'p', 'f')
        ORDER BY dependent_name, source_name
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
        Fetch the dependency edge rows for the schema.
        """
        self._raw = await self._conn.fetch(self._SQL, self._schema)

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
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [
            {
                "source": {
                    "schema": r["dependent_schema"],
                    "name": r["dependent_name"],
                    "kind": _RELKIND_KIND[r["dependent_kind"]],
                },
                "target": {
                    "schema": r["source_schema"],
                    "name": r["source_name"],
                    "kind": _RELKIND_KIND[r["source_kind"]],
                },
            }
            for r in self._raw
        ]
