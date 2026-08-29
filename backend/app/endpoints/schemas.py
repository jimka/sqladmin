"""
Schema-level introspection: the navigator's schema list, each schema's
category listings (objects, functions, types, indexes, dependencies,
inheritance), and the schema/database ER-diagram reads.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import require_session
from ..connections import Session, session_pool_for
from ..operations import (
    ListDependenciesQuery,
    ListFunctionsQuery,
    ListInheritanceQuery,
    ListObjectsQuery,
    ListSchemasQuery,
    ListTypesQuery,
    SchemaColumnsQuery,
    SchemaConstraintsQuery,
    SchemaForeignKeysQuery,
    SchemaIndexesQuery,
    SchemaTablesQuery,
    assemble_database_graph,
    assemble_schema_graph,
    flatten_schema_indexes,
)
from .common import DATABASE_PREFIX

router = APIRouter(prefix=DATABASE_PREFIX, tags=["schemas"])


@router.get("/schemas")
async def schemas(
    connection_id: str, database: str, session: Session = Depends(require_session)
) -> list[dict]:
    """
    List the non-system schemas in a database.

    Route: ``GET /api/{connection_id}/db/{database}/schemas``.

    Returns:
        ``[{"name": str}]`` — one entry per schema.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListSchemasQuery(c, database)
        await op.apply()

        return op.get_result()


@router.get("/graph")
async def database_graph(
    connection_id: str, database: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Fetch every non-system schema's tables and structures for the whole-
    database ER diagram in one round trip, replacing the frontend's previous
    ``O(schemas x tables)`` fan-out. Structure-only (no columns) — the
    database diagram never renders column rows, and a whole-database column
    dump could be large.

    Route: ``GET /api/{connection_id}/db/{database}/graph``.

    Returns:
        ``{"schemas": [{"schema", "tables": [{"name", "structure"}]}]}``,
        grouped by schema then table, both sorted by name.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        tables = SchemaTablesQuery(c, None)
        indexes = SchemaIndexesQuery(c, None)
        constraints = SchemaConstraintsQuery(c, None)
        foreign_keys = SchemaForeignKeysQuery(c, None)

        await tables.apply()
        await indexes.apply()
        await constraints.apply()
        await foreign_keys.apply()

        return {
            "schemas": assemble_database_graph(
                tables.get_result(),
                indexes.get_result(),
                constraints.get_result(),
                foreign_keys.get_result(),
            ),
        }


@router.get("/{schema}/objects")
async def objects(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the tables, views, materialized views, and sequences in a schema.

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/objects``.

    Returns:
        ``[{"name": str, "kind": "table" | "view" | "materializedView" |
        "sequence"}]``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListObjectsQuery(c, schema)
        await op.apply()

        return op.get_result()


@router.get("/{schema}/functions")
async def functions(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the functions and procedures in a schema.

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/functions``.

    Returns:
        ``[{"name": str, "signature": str, "isProcedure": bool}]``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListFunctionsQuery(c, schema)
        await op.apply()

        return op.get_result()


@router.get("/{schema}/types")
async def types(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the standalone enum and composite types in a schema.

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/types``.

    Returns:
        ``[{"name": str}]``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListTypesQuery(c, schema)
        await op.apply()

        return op.get_result()


@router.get("/{schema}/indexes")
async def indexes(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List every index in a schema, spanning every table — the navigator's flat,
    schema-wide Indexes category. Reuses ``SchemaIndexesQuery`` (already built
    for the ``/graph`` routes) rather than a new per-list query.

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/indexes``.

    Returns:
        ``[{name, definition, unique, primary, table}]``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = SchemaIndexesQuery(c, schema)
        await op.apply()

        return flatten_schema_indexes(op.get_result())


@router.get("/{schema}/dependencies")
async def dependencies(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the view/matview dependency edges in a schema (what each view reads).

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/dependencies``.

    Returns:
        ``[{"source": RelationNodeRef, "target": RelationNodeRef}]`` — source is
        the dependent view/matview, target is the underlying relation it reads.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListDependenciesQuery(c, schema)
        await op.apply()

        return op.get_result()


@router.get("/{schema}/inheritance")
async def inheritance(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the table inheritance/partitioning edges in a schema.

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/inheritance``.

    Returns:
        ``[{"source": RelationNodeRef, "target": RelationNodeRef}]`` — source is
        the parent relation, target is the child (partition or inheriting table).
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListInheritanceQuery(c, schema)
        await op.apply()

        return op.get_result()


@router.get("/{schema}/graph")
async def schema_graph(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Fetch a whole schema's ER-diagram metadata — every base table's structure
    and columns — in one round trip, replacing the frontend's previous one-
    ``/structure``-plus-one-``/columns`` fetch per table.

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/graph``.

    Returns:
        ``{"tables": [{"name", "structure": {...}, "columns": [...]}]}``, one
        entry per base table in the schema, sorted by name.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        tables = SchemaTablesQuery(c, schema)
        columns = SchemaColumnsQuery(c, schema)
        indexes = SchemaIndexesQuery(c, schema)
        constraints = SchemaConstraintsQuery(c, schema)
        foreign_keys = SchemaForeignKeysQuery(c, schema)

        await tables.apply()
        await columns.apply()
        await indexes.apply()
        await constraints.apply()
        await foreign_keys.apply()

        return {
            "tables": assemble_schema_graph(
                tables.get_result(),
                columns.get_result(),
                indexes.get_result(),
                constraints.get_result(),
                foreign_keys.get_result(),
            ),
        }
