"""
Table-level (and sequence/index-detail) introspection: columns, privileges,
view definitions, structure (indexes/constraints/foreign keys), sequence
detail, and index detail.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import require_session
from ..connections import Session, session_pool_for
from ..contract import TableRef
from ..operations import (
    IndexDetailQuery,
    ListColumnsQuery,
    ListConstraintsQuery,
    ListForeignKeysQuery,
    ListIndexesQuery,
    SequenceDetailQuery,
    TablePrivilegesQuery,
    ViewDefinitionQuery,
)
from .common import DATABASE_PREFIX

router = APIRouter(prefix=DATABASE_PREFIX, tags=["tables"])


@router.get("/{schema}/{table}/columns")
async def columns(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    Introspect a table's columns.

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/{table}/columns``.

    Returns:
        ``[ColumnMeta]`` as contract JSON (name, dataType, nullable,
        isPrimaryKey, isGenerated, wireType) — one entry per column.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListColumnsQuery(c, TableRef(database, schema, table))
        await op.apply()

        return op.get_result()


@router.get("/{schema}/{table}/privileges")
async def table_privileges(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Report the connected user's effective rights on a table.

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/{table}/privileges``.

    Returns:
        ``{"select", "insert", "update", "delete"}`` booleans — what this login
        may do on the table (``has_table_privilege``, membership-aware). The
        frontend gates the editor's Add/Delete/Save actions and cell editing on
        these.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = TablePrivilegesQuery(c, TableRef(database, schema, table))
        await op.apply()

        return op.get_result()


@router.get("/{schema}/{table}/definition")
async def view_definition(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Return a (materialized) view's reconstructed ``SELECT`` (pg_get_viewdef).

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/{table}/definition``.

    Raises:
        NotFound: if no view/matview by that name exists (mapped to 404).

    Returns:
        ``{"definition": str}`` — the pretty-printed view definition SQL.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ViewDefinitionQuery(c, TableRef(database, schema, table))
        await op.apply()

        return op.get_result()


@router.get("/{schema}/{table}/structure")
async def structure(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Introspect a table's indexes, non-FK constraints, and foreign keys in one
    round trip (mirroring the combined ``/roles/{role}`` detail endpoint).

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/{table}/structure``.

    Returns:
        ``{"indexes": [...], "constraints": [...], "foreignKeys": [...]}`` — a
        table with none of a given facet returns an empty list for it, so the
        read-only inspector renders every section regardless.
    """
    ref = TableRef(database, schema, table)

    async with session_pool_for(session, connection_id).acquire() as c:
        indexes = ListIndexesQuery(c, ref)
        await indexes.apply()

        constraints = ListConstraintsQuery(c, ref)
        await constraints.apply()

        foreign_keys = ListForeignKeysQuery(c, ref)
        await foreign_keys.apply()

        return {
            "indexes": indexes.get_result(),
            "constraints": constraints.get_result(),
            "foreignKeys": foreign_keys.get_result(),
        }


@router.get("/{schema}/{table}/sequence")
async def sequence_detail(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Report a sequence's current state and parameters (pg_sequences).

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/{table}/sequence``.
    The ``{table}`` path segment carries the sequence name (the per-object
    route namespace is generic).

    Raises:
        NotFound: if no sequence by that name exists (mapped to 404).

    Returns:
        ``{lastValue, startValue, minValue, maxValue, increment, cacheSize,
        cycle, dataType, owner}`` — see ``SequenceDetailQuery.get_result``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = SequenceDetailQuery(c, TableRef(database, schema, table))
        await op.apply()

        return op.get_result()


@router.get("/{schema}/{name}/index")
async def index_detail(
    connection_id: str, database: str, schema: str, name: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Report one index's full definition, unique/primary flags, and owning
    table (pg_indexes/pg_index), for the Indexes-category info tab.

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/{name}/index``.
    The ``{name}`` path segment carries the index name (the per-object route
    namespace is generic — see ``sequence_detail``).

    Raises:
        NotFound: if no index by that name exists (mapped to 404).

    Returns:
        ``{name, definition, unique, primary, table}`` — see
        ``IndexDetailQuery.get_result``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = IndexDetailQuery(c, TableRef(database, schema, name))
        await op.apply()

        return op.get_result()
