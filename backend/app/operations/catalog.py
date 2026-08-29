"""
Shared catalog SQL fragments, catalog-code maps, and pure row-to-payload
mappers used by several catalog-read query families (edges, indexes,
constraints, foreign keys, columns) instead of each family carrying its own
copy — see the plan's Architecture Decisions for why this lives in its own
module rather than ``common.py`` (scoped to the row-write path).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

# Excluded from every schema/database-wide query (graph.py's five queries)
# and from ListSchemasQuery's own listing. Shared by every module that used
# to keep its own copy of this same catalog-scoping constant (list_schemas.py,
# graph.py) — the edge queries (list_inheritance.py, list_dependencies.py)
# are schema-scoped, not schema/database-wide, and do not reference it.
SYSTEM_SCHEMAS: tuple[str, ...] = ("pg_catalog", "information_schema")

# pg_class.relkind -> the contract DbObjectKind. Partitioned ('p') and foreign
# ('f') tables collapse to "table"; fixed by the catalog format. Deliberately
# omits 'I'/'i' (partitioned index / index) — an edge whose endpoint carries
# either code is dropped by edge_rows() rather than mapped, since a diagram
# has no node kind for an index.
RELKIND_KIND: dict[str, str] = {"r": "table", "p": "table", "f": "table", "v": "view", "m": "materializedView"}

# The map's own keys, bound as a query parameter so the SQL filter that keeps
# an edge query from fetching an unmappable relkind can never fall out of step
# with the map edge_rows() shapes against.
RELKIND_CODES: tuple[str, ...] = tuple(RELKIND_KIND)


def _endpoint(row: Mapping[str, Any], side: str) -> dict:
    """
    Build one edge endpoint (``source`` or ``target``) from a row carrying
    ``{side}_schema``/``{side}_name``/``{side}_kind`` columns.

    Args:
        row: one edge row, source/target-prefixed.
        side: ``"source"`` or ``"target"``.

    Returns:
        ``{"schema": str, "name": str, "kind": str}``, ``kind`` mapped through
        ``RELKIND_KIND``.
    """
    return {
        "schema": row[f"{side}_schema"],
        "name": row[f"{side}_name"],
        "kind": RELKIND_KIND[row[f"{side}_kind"]],
    }


def edge_rows(rows: Sequence[Mapping[str, Any]]) -> list[dict]:
    """
    Shape a set of source/target-prefixed edge rows into the contract's
    directed-edge list, dropping any row whose either endpoint carries a
    relkind outside ``RELKIND_KIND`` (e.g. a partitioned index's own child
    index, code ``I``/``i``) instead of raising ``KeyError``.

    Args:
        rows: rows carrying ``source_schema``/``source_name``/``source_kind``
            and the ``target_*`` equivalents.

    Returns:
        ``[{"source": {schema, name, kind}, "target": {schema, name, kind}}]``,
        one entry per row whose relkinds both map.
    """
    return [
        {"source": _endpoint(r, "source"), "target": _endpoint(r, "target")}
        for r in rows
        if r["source_kind"] in RELKIND_KIND and r["target_kind"] in RELKIND_KIND
    ]
