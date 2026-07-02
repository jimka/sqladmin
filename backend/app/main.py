"""
FastAPI app: lifespan (open/close pools), the exception handler mapping the
typed taxonomy to ``(status, {detail})``, CORS for the Vite dev origin, and the
thin routes (acquire -> construct op -> apply -> get_result).

All routes are namespaced ``/api/{connection_id}/...``. ``connection_id`` is an
opaque key into the pool registry (see ``connections.py``) — the multi-database
seam; Phase 0-1 ship a single ``"default"`` connection, so every URL begins
``/api/default/``. The remaining path segments (``{database}``, ``{schema}``,
``{table}``) identify the object the route acts on.
"""

from __future__ import annotations

import contextlib
import json
from typing import AsyncIterator

import asyncpg
from fastapi import Body, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .connections import close_pools, get_pool, open_pools
from .contract import ColumnMeta, TableRef
from .errors import DomainError, NotFound, ValidationError
from .operations import (
    DeleteRowCommand,
    InsertRowCommand,
    ListColumnsQuery,
    ListDatabasesQuery,
    ListObjectsQuery,
    ListRolesQuery,
    ListRowsQuery,
    ListSchemasQuery,
    RoleAttributesQuery,
    RoleMembershipsQuery,
    RolePrivilegesQuery,
    RunQueryCommand,
    UpdateRowCommand,
    ViewDefinitionQuery,
)

# The Vite dev server and the library gallery dev server.
_DEV_ORIGINS = ["http://localhost:5173", "http://localhost:8015"]

# Default page size when the client omits one (mirrors the proxy's own default).
_DEFAULT_PAGE_SIZE = 100


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    Open the connection pools on startup; close them on shutdown.
    """
    await open_pools()

    yield

    await close_pools()


app = FastAPI(title="SQLAdmin", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_DEV_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(DomainError)
async def _domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
    """
    Map a typed domain error to its HTTP status with a ``{detail}`` body.
    """
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


@app.exception_handler(asyncpg.PostgresError)
async def _pg_error_handler(request: Request, exc: asyncpg.PostgresError) -> JSONResponse:
    """
    Map a driver error to a status: integrity/unique -> 409, else -> 400.
    """
    if isinstance(exc, asyncpg.exceptions.IntegrityConstraintViolationError):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    return JSONResponse(status_code=400, content={"detail": str(exc)})


def _parse_json_array(raw: str | None) -> list:
    """
    Parse a ``sort``/``filter`` query param (a JSON array).

    Raises:
        ValidationError: if the value is not valid JSON or not a JSON array.

    Returns:
        The parsed list, or ``[]`` when the param is absent.
    """
    if not raw:
        return []

    try:
        value = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValidationError(f"Invalid JSON in query parameter: {e}")

    if not isinstance(value, list):
        raise ValidationError("Expected a JSON array")

    return value


async def _columns_for(conn: asyncpg.Connection, table: TableRef) -> list[ColumnMeta]:
    """
    Introspect a table's columns.

    Raises:
        NotFound: if the table has no columns (treated as non-existent).

    Returns:
        The table's columns as typed ``ColumnMeta``.
    """
    op = ListColumnsQuery(conn, table)
    await op.apply()
    columns = op.get_columns_result()

    if not columns:
        raise NotFound(f"Table '{table.schema}.{table.name}' not found")

    return columns


# --- Schema introspection -------------------------------------------------


@app.get("/api/{connection_id}/databases")
async def databases(connection_id: str) -> list[dict]:
    """
    List the databases available on a connection.

    Route: ``GET /api/{connection_id}/databases``.

    Returns:
        ``[{"name": str}]`` — one entry per non-template, connectable database.
    """
    async with get_pool(connection_id).acquire() as c:
        op = ListDatabasesQuery(c)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/schemas")
async def schemas(connection_id: str, database: str) -> list[dict]:
    """
    List the non-system schemas in a database.

    Route: ``GET /api/{connection_id}/{database}/schemas``.

    Returns:
        ``[{"name": str}]`` — one entry per schema.
    """
    async with get_pool(connection_id).acquire() as c:
        op = ListSchemasQuery(c, database)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/objects")
async def objects(connection_id: str, database: str, schema: str) -> list[dict]:
    """
    List the tables and views in a schema.

    Route: ``GET /api/{connection_id}/{database}/{schema}/objects``.

    Returns:
        ``[{"name": str, "kind": "table" | "view"}]``.
    """
    async with get_pool(connection_id).acquire() as c:
        op = ListObjectsQuery(c, schema)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/{table}/columns")
async def columns(connection_id: str, database: str, schema: str, table: str) -> list[dict]:
    """
    Introspect a table's columns.

    Route: ``GET /api/{connection_id}/{database}/{schema}/{table}/columns``.

    Returns:
        ``[ColumnMeta]`` as contract JSON (name, dataType, nullable,
        isPrimaryKey, isGenerated, wireType) — one entry per column.
    """
    async with get_pool(connection_id).acquire() as c:
        op = ListColumnsQuery(c, TableRef(database, schema, table))
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/{table}/definition")
async def view_definition(connection_id: str, database: str, schema: str, table: str) -> dict:
    """
    Return a (materialized) view's reconstructed ``SELECT`` (pg_get_viewdef).

    Route: ``GET /api/{connection_id}/{database}/{schema}/{table}/definition``.

    Raises:
        NotFound: if no view/matview by that name exists (mapped to 404).

    Returns:
        ``{"definition": str}`` — the pretty-printed view definition SQL.
    """
    async with get_pool(connection_id).acquire() as c:
        op = ViewDefinitionQuery(c, TableRef(database, schema, table))
        await op.apply()

        return op.get_result()


# --- Role introspection ---------------------------------------------------


@app.get("/api/{connection_id}/roles")
async def roles(connection_id: str) -> list[dict]:
    """
    List the roles (users and groups) on a connection with their attributes.

    Route: ``GET /api/{connection_id}/roles``.

    Returns:
        ``[RoleSummary]`` as contract JSON — one entry per role, name-ordered.
    """
    async with get_pool(connection_id).acquire() as c:
        op = ListRolesQuery(c)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/roles/{role}")
async def role_detail(connection_id: str, role: str) -> dict:
    """
    One role's attributes plus the roles it belongs to and the table grants it
    holds.

    Route: ``GET /api/{connection_id}/roles/{role}``.

    Raises:
        NotFound: if no role by that name exists (mapped to 404).

    Returns:
        The ``RoleDetail`` contract shape ``{role, memberOf, privileges}``.
    """
    async with get_pool(connection_id).acquire() as c:
        attrs = RoleAttributesQuery(c, role)
        await attrs.apply()
        summary = attrs.get_result()

        if summary is None:
            raise NotFound(f"Role '{role}' not found")

        memberships = RoleMembershipsQuery(c, role)
        await memberships.apply()

        privileges = RolePrivilegesQuery(c, role)
        await privileges.apply()

        return {
            "role": summary,
            "memberOf": memberships.get_result(),
            "privileges": privileges.get_result(),
        }


# --- Table data CRUD ------------------------------------------------------


@app.get("/api/{connection_id}/{database}/{schema}/{table}/rows")
async def list_rows(
    connection_id: str,
    database: str,
    schema: str,
    table: str,
    page: int = 1,
    pageSize: int = _DEFAULT_PAGE_SIZE,
    sort: str | None = None,
    filter: str | None = None,
) -> dict:
    """
    Read one page of a table's rows, honoring sort/filter from the proxy.

    Route: ``GET /api/{connection_id}/{database}/{schema}/{table}/rows``.

    Args:
        page: 1-based page number.
        pageSize: rows per page (capped server-side).
        sort: JSON-encoded ``SortDescriptor[]`` (the proxy's ``sort=`` param).
        filter: JSON-encoded ``FilterDescriptor[]`` (the proxy's ``filter=`` param).

    Returns:
        ``{"rows": [...], "totalCount": int}`` with wire-mapped scalar values.
    """
    ref = TableRef(database, schema, table)

    async with get_pool(connection_id).acquire() as c:
        cols = await _columns_for(c, ref)
        op = ListRowsQuery(
            c, ref, page, pageSize, _parse_json_array(sort), _parse_json_array(filter), cols
        )
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/{schema}/{table}/rows")
async def insert_row(
    connection_id: str, database: str, schema: str, table: str, data: dict = Body(...)
) -> dict:
    """
    Insert a row and return the created record.

    Route: ``POST /api/{connection_id}/{database}/{schema}/{table}/rows``.

    Args:
        data: the new row as a JSON object; server-managed columns (PK,
            generated) are expected to be omitted by the client writer.

    Returns:
        The created row with wire-mapped scalar values.
    """
    ref = TableRef(database, schema, table)

    async with get_pool(connection_id).acquire() as c:
        cols = await _columns_for(c, ref)
        op = InsertRowCommand(c, ref, data, cols)
        await op.apply()

        return op.get_result()


@app.put("/api/{connection_id}/{database}/{schema}/{table}/rows/{row_id}")
async def update_row(
    connection_id: str, database: str, schema: str, table: str, row_id: str, data: dict = Body(...)
) -> dict:
    """
    Update a row by primary key and return the updated record.

    Route: ``PUT /api/{connection_id}/{database}/{schema}/{table}/rows/{row_id}``.

    Args:
        row_id: the primary-key value, matched as text.
        data: the row's column values as a JSON object (the PK is ignored).

    Returns:
        The updated row with wire-mapped scalar values.
    """
    ref = TableRef(database, schema, table)

    async with get_pool(connection_id).acquire() as c:
        cols = await _columns_for(c, ref)
        op = UpdateRowCommand(c, ref, row_id, data, cols)
        await op.apply()

        return op.get_result()


@app.delete("/api/{connection_id}/{database}/{schema}/{table}/rows/{row_id}", status_code=204)
async def delete_row(
    connection_id: str, database: str, schema: str, table: str, row_id: str
) -> Response:
    """
    Delete a row by primary key.

    Route: ``DELETE /api/{connection_id}/{database}/{schema}/{table}/rows/{row_id}``.

    Args:
        row_id: the primary-key value, matched as text.

    Returns:
        An empty ``204 No Content`` response.
    """
    ref = TableRef(database, schema, table)

    async with get_pool(connection_id).acquire() as c:
        cols = await _columns_for(c, ref)
        op = DeleteRowCommand(c, ref, row_id, cols)
        await op.apply()

        return Response(status_code=204)


# --- Arbitrary SQL --------------------------------------------------------


@app.post("/api/{connection_id}/query")
async def run_query(connection_id: str, body: dict = Body(...)) -> dict:
    """
    Run one arbitrary SQL statement and return its result.

    Route: ``POST /api/{connection_id}/query``.

    Args:
        body: ``{"sql": str}`` — exactly one statement (a ``;``-separated script
            is rejected by the extended query protocol as a 400).

    Returns:
        ``{"kind": "rows", "columns", "rows", "rowCount"}`` for a statement that
        returned a result set, or ``{"kind": "status", "command", "rowCount"}``
        for one that did not (INSERT/UPDATE/DDL).
    """
    async with get_pool(connection_id).acquire() as c:
        op = RunQueryCommand(c, body.get("sql", ""))
        await op.apply()

        return op.get_result()
