"""
FastAPI app: lifespan (start/stop the idle-session sweep), the exception handler
mapping the typed taxonomy to ``(status, {detail})``, the auth/config routes, and
the thin per-object routes (resolve the session's pool -> acquire -> construct
op -> apply -> get_result).

Authenticated routes are namespaced ``/api/{connection_id}/...``. The pool is
resolved from the request's **session cookie** (see ``auth.py`` /
``connections.py``), not from the ``connection_id`` path segment — that segment is
only validated against the session's own label. Read routes depend on
``require_session``; mutating routes depend on ``require_csrf``. ``GET /api/config``
is deliberately unauthenticated (it feeds the login screen). The app boots with
zero pools; a pool exists only for the lifetime of a logged-in session.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from typing import AsyncIterator

import asyncpg
from fastapi import Body, Depends, FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .auth import log_dial_policy, login, logout, require_csrf, require_session, whoami
from .config import app_config, enable_docs
from .connections import (
    SWEEP_INTERVAL_SECONDS,
    Session,
    close_all_sessions,
    session_pool_for,
    sweep_idle_sessions,
)
from .contract import ColumnMeta, TableRef
from .errors import DomainError, NotFound, ValidationError
from .operations import (
    AlterTypeAddValuePreview,
    CreateCompositeTypePreview,
    CreateEnumTypePreview,
    CreateFunctionPreview,
    CreateMaterializedViewPreview,
    CreateViewPreview,
    DeleteRowCommand,
    DropFunctionPreview,
    DropMaterializedViewPreview,
    DropTypePreview,
    DropViewPreview,
    ExecuteDdlCommand,
    ExplainQueryCommand,
    ExportRowsQuery,
    FunctionDefinitionQuery,
    InsertRowCommand,
    ListColumnsQuery,
    ListConstraintsQuery,
    ListDatabasesQuery,
    ListDependenciesQuery,
    ListForeignKeysQuery,
    ListFunctionsQuery,
    ListIndexesQuery,
    ListInheritanceQuery,
    ListObjectsQuery,
    ListRolesQuery,
    ListRowsQuery,
    ListSchemasQuery,
    ListTypesQuery,
    PreviewAlterTable,
    PreviewConstraint,
    PreviewCreateTable,
    PreviewDropTable,
    PreviewIndex,
    RefreshMaterializedViewPreview,
    ReplaceMaterializedViewPreview,
    RoleAttributesQuery,
    RoleMembershipsQuery,
    RolePrivilegesQuery,
    RunQueryCommand,
    SchemaCreatePreview,
    SchemaDropPreview,
    SchemaRenamePreview,
    SequenceAlterPreview,
    SequenceCreatePreview,
    SequenceDetailQuery,
    SequenceDropPreview,
    SequenceOwnerPreview,
    TablePrivilegesQuery,
    TypeDefinitionQuery,
    UpdateRowCommand,
    ViewDefinitionQuery,
)
from .static import mount_static

# Default page size when the client omits one (mirrors the proxy's own default).
_DEFAULT_PAGE_SIZE = 100


async def _sweep_loop() -> None:
    """
    Periodically evict idle sessions until cancelled (owned by the lifespan). A
    sweep error is logged and swallowed so one bad pass never kills the loop and
    silently disables idle eviction for the rest of the process.
    """
    while True:
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)

        try:
            await sweep_idle_sessions()
        except Exception:
            logging.getLogger(__name__).exception("Idle-session sweep failed")


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """
    Start the idle-session sweep on startup; cancel it and close every session
    pool on shutdown. The app boots with **zero** pools — they are created only
    by a successful login.
    """
    log_dial_policy()

    sweep_task = asyncio.create_task(_sweep_loop())

    try:
        yield
    finally:
        sweep_task.cancel()

        with contextlib.suppress(asyncio.CancelledError):
            await sweep_task

        await close_all_sessions()


# The interactive docs publish the whole API surface with no authentication,
# so they are off unless SQLADMIN_ENABLE_DOCS opts them back in.
_docs_on = enable_docs()

app = FastAPI(
    title="SQLAdmin",
    lifespan=lifespan,
    docs_url="/docs" if _docs_on else None,
    redoc_url="/redoc" if _docs_on else None,
    openapi_url="/openapi.json" if _docs_on else None,
)

# Auth routes plus the pre-auth config route (handlers live in auth.py/config.py).
# GET /api/config takes no session dependency — it populates the login screen.
app.post("/api/login")(login)
app.post("/api/logout")(logout)
app.get("/api/whoami")(whoami)
app.get("/api/config")(app_config)


@app.exception_handler(DomainError)
async def _domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
    """
    Map a typed domain error to its HTTP status with a ``{detail}`` body.
    """
    return JSONResponse(
        status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers
    )


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
async def databases(
    connection_id: str, session: Session = Depends(require_session)
) -> list[dict]:
    """
    List the databases available on a connection.

    Route: ``GET /api/{connection_id}/databases``.

    Returns:
        ``[{"name": str}]`` — one entry per non-template, connectable database.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListDatabasesQuery(c)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/schemas")
async def schemas(
    connection_id: str, database: str, session: Session = Depends(require_session)
) -> list[dict]:
    """
    List the non-system schemas in a database.

    Route: ``GET /api/{connection_id}/{database}/schemas``.

    Returns:
        ``[{"name": str}]`` — one entry per schema.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListSchemasQuery(c, database)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/objects")
async def objects(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the tables, views, and materialized views in a schema.

    Route: ``GET /api/{connection_id}/{database}/{schema}/objects``.

    Returns:
        ``[{"name": str, "kind": "table" | "view" | "materializedView"}]``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListObjectsQuery(c, schema)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/functions")
async def functions(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the functions and procedures in a schema.

    Route: ``GET /api/{connection_id}/{database}/{schema}/functions``.

    Returns:
        ``[{"name": str, "signature": str, "isProcedure": bool}]``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListFunctionsQuery(c, schema)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/types")
async def types(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the standalone enum and composite types in a schema.

    Route: ``GET /api/{connection_id}/{database}/{schema}/types``.

    Returns:
        ``[{"name": str}]``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListTypesQuery(c, schema)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/dependencies")
async def dependencies(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the view/matview dependency edges in a schema (what each view reads).

    Route: ``GET /api/{connection_id}/{database}/{schema}/dependencies``.

    Returns:
        ``[{"source": RelationNodeRef, "target": RelationNodeRef}]`` — source is
        the dependent view/matview, target is the underlying relation it reads.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListDependenciesQuery(c, schema)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/inheritance")
async def inheritance(
    connection_id: str, database: str, schema: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    List the table inheritance/partitioning edges in a schema.

    Route: ``GET /api/{connection_id}/{database}/{schema}/inheritance``.

    Returns:
        ``[{"source": RelationNodeRef, "target": RelationNodeRef}]`` — source is
        the parent relation, target is the child (partition or inheriting table).
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListInheritanceQuery(c, schema)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/{table}/columns")
async def columns(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> list[dict]:
    """
    Introspect a table's columns.

    Route: ``GET /api/{connection_id}/{database}/{schema}/{table}/columns``.

    Returns:
        ``[ColumnMeta]`` as contract JSON (name, dataType, nullable,
        isPrimaryKey, isGenerated, wireType) — one entry per column.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListColumnsQuery(c, TableRef(database, schema, table))
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/{table}/privileges")
async def table_privileges(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Report the connected user's effective rights on a table.

    Route: ``GET /api/{connection_id}/{database}/{schema}/{table}/privileges``.

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


@app.get("/api/{connection_id}/{database}/{schema}/{table}/definition")
async def view_definition(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Return a (materialized) view's reconstructed ``SELECT`` (pg_get_viewdef).

    Route: ``GET /api/{connection_id}/{database}/{schema}/{table}/definition``.

    Raises:
        NotFound: if no view/matview by that name exists (mapped to 404).

    Returns:
        ``{"definition": str}`` — the pretty-printed view definition SQL.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ViewDefinitionQuery(c, TableRef(database, schema, table))
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/{database}/{schema}/{table}/structure")
async def structure(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Introspect a table's indexes, non-FK constraints, and foreign keys in one
    round trip (mirroring the combined ``/roles/{role}`` detail endpoint).

    Route: ``GET /api/{connection_id}/{database}/{schema}/{table}/structure``.

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


@app.get("/api/{connection_id}/{database}/{schema}/{table}/sequence")
async def sequence_detail(
    connection_id: str, database: str, schema: str, table: str,
    session: Session = Depends(require_session),
) -> dict:
    """
    Report a sequence's current state and parameters (pg_sequences).

    Route: ``GET /api/{connection_id}/{database}/{schema}/{table}/sequence``.
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


# --- Role introspection ---------------------------------------------------


@app.get("/api/{connection_id}/roles")
async def roles(
    connection_id: str, session: Session = Depends(require_session)
) -> list[dict]:
    """
    List the roles (users and groups) on a connection with their attributes.

    Route: ``GET /api/{connection_id}/roles``.

    Returns:
        ``[RoleSummary]`` as contract JSON — one entry per role, name-ordered.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListRolesQuery(c)
        await op.apply()

        return op.get_result()


@app.get("/api/{connection_id}/roles/{role}")
async def role_detail(
    connection_id: str, role: str, session: Session = Depends(require_session)
) -> dict:
    """
    One role's attributes plus the roles it belongs to and the table grants it
    holds.

    Route: ``GET /api/{connection_id}/roles/{role}``.

    Raises:
        NotFound: if no role by that name exists (mapped to 404).

    Returns:
        The ``RoleDetail`` contract shape ``{role, memberOf, privileges}``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
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
    session: Session = Depends(require_session),
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

    async with session_pool_for(session, connection_id).acquire() as c:
        cols = await _columns_for(c, ref)
        op = ListRowsQuery(
            c, ref, page, pageSize, _parse_json_array(sort), _parse_json_array(filter), cols
        )
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/{schema}/{table}/rows")
async def insert_row(
    connection_id: str, database: str, schema: str, table: str, data: dict = Body(...),
    session: Session = Depends(require_csrf),
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

    async with session_pool_for(session, connection_id).acquire() as c:
        cols = await _columns_for(c, ref)
        op = InsertRowCommand(c, ref, data, cols)
        await op.apply()

        return op.get_result()


@app.put("/api/{connection_id}/{database}/{schema}/{table}/rows/{row_id}")
async def update_row(
    connection_id: str, database: str, schema: str, table: str, row_id: str,
    data: dict = Body(...), session: Session = Depends(require_csrf),
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

    async with session_pool_for(session, connection_id).acquire() as c:
        cols = await _columns_for(c, ref)
        op = UpdateRowCommand(c, ref, row_id, data, cols)
        await op.apply()

        return op.get_result()


@app.delete("/api/{connection_id}/{database}/{schema}/{table}/rows/{row_id}", status_code=204)
async def delete_row(
    connection_id: str, database: str, schema: str, table: str, row_id: str,
    session: Session = Depends(require_csrf),
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

    async with session_pool_for(session, connection_id).acquire() as c:
        cols = await _columns_for(c, ref)
        op = DeleteRowCommand(c, ref, row_id, cols)
        await op.apply()

        return Response(status_code=204)


# --- Arbitrary SQL --------------------------------------------------------


@app.post("/api/{connection_id}/query")
async def run_query(
    connection_id: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Run one arbitrary SQL statement and return its result.

    Route: ``POST /api/{connection_id}/query``.

    Args:
        body: ``{"sql": str}`` — exactly one statement (a ``;``-separated script
            is rejected by the extended query protocol as a 400).

    Returns:
        ``{"kind": "rows", "columns", "rows", "rowCount", "truncated"}`` for a
        statement that returned a result set (``truncated`` is ``True`` when the
        result was capped at ``MAX_RESULT_ROWS``), or
        ``{"kind": "status", "command", "rowCount"}`` for one that did not
        (INSERT/UPDATE/DDL).
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = RunQueryCommand(c, body.get("sql", ""))
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/explain")
async def explain_query(
    connection_id: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Run EXPLAIN / EXPLAIN ANALYZE for one statement and return its query plan.

    Route: ``POST /api/{connection_id}/explain``.

    Args:
        body: ``{"sql": str, "analyze": bool, "format": "text"|"json"}`` — the
            statement to explain (a ``;``-separated script is rejected by the
            extended query protocol as a 400). ANALYZE executes the statement,
            but the operation rolls the transaction back so no write is committed.

    Returns:
        ``{"kind": "explain", "format", "analyze", "plan"}`` — the joined plan
        text for FORMAT TEXT, plus a ``planJson`` tree for FORMAT JSON.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ExplainQueryCommand(
            c,
            body.get("sql", ""),
            bool(body.get("analyze", False)),
            str(body.get("format", "text")),
        )
        await op.apply()

        return op.get_result()


# --- DDL --------------------------------------------------------------------


@app.post("/api/{connection_id}/ddl/execute")
async def execute_ddl(
    connection_id: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Run one final (possibly user-edited) DDL statement and return its status.

    Route: ``POST /api/{connection_id}/ddl/execute``. The single execute
    endpoint every DDL phase's preview/confirm dialog reuses — the previewed
    SQL string (edited or not) is authoritative; nothing is re-derived from a
    structured spec at execute time.

    Args:
        body: ``{"sql": str}`` — exactly one DDL statement.

    Returns:
        ``{"kind": "status", "command", "rowCount"}`` — the same status
        envelope ``RunQueryCommand`` emits for a non-row statement.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ExecuteDdlCommand(c, body.get("sql", ""))
        await op.apply()

        return op.get_result()


# --- Table DDL --------------------------------------------------------------


@app.post("/api/{connection_id}/{database}/ddl/table/create")
async def preview_create_table(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a CREATE TABLE statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/table/create``.

    Args:
        body: the ``CreateTableSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = PreviewCreateTable(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/table/drop")
async def preview_drop_table(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a DROP TABLE statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/table/drop``.

    Args:
        body: the ``DropTableSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = PreviewDropTable(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/table/alter")
async def preview_alter_table(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview one ALTER TABLE column/table-rename statement, dispatched on the
    spec's ``action`` field.

    Route: ``POST /api/{connection_id}/{database}/ddl/table/alter``.

    Args:
        body: the ``AlterTableSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = PreviewAlterTable(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/table/constraint")
async def preview_constraint(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview one constraint add/drop statement, dispatched on the spec's
    ``action`` field.

    Route: ``POST /api/{connection_id}/{database}/ddl/table/constraint``.

    Args:
        body: the ``ConstraintSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = PreviewConstraint(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/table/index")
async def preview_index(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview one index create/drop statement, dispatched on the spec's
    ``action`` field.

    Route: ``POST /api/{connection_id}/{database}/ddl/table/index``.

    Args:
        body: the ``IndexSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = PreviewIndex(c, body)
        await op.apply()

        return op.get_result()


# --- View / matview DDL -------------------------------------------------------


@app.post("/api/{connection_id}/{database}/ddl/create-view")
async def preview_create_view(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a CREATE [OR REPLACE] VIEW statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/create-view``.

    Args:
        body: the ``CreateViewSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = CreateViewPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/drop-view")
async def preview_drop_view(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a DROP VIEW statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/drop-view``.

    Args:
        body: the ``DropSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = DropViewPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/create-matview")
async def preview_create_matview(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a CREATE MATERIALIZED VIEW statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/create-matview``.

    Args:
        body: the ``CreateMatviewSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = CreateMaterializedViewPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/drop-matview")
async def preview_drop_matview(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a DROP MATERIALIZED VIEW statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/drop-matview``.

    Args:
        body: the ``DropSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = DropMaterializedViewPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/refresh-matview")
async def preview_refresh_matview(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a REFRESH MATERIALIZED VIEW statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/refresh-matview``.

    Args:
        body: the ``RefreshMatviewSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = RefreshMaterializedViewPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/replace-matview")
async def preview_replace_matview(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview the DROP; CREATE pair that edits a materialized view's body.

    Route: ``POST /api/{connection_id}/{database}/ddl/replace-matview``.

    Args:
        body: the ``ReplaceMatviewSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated ``;``-joined statement, for the
        editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ReplaceMaterializedViewPreview(c, body)
        await op.apply()

        return op.get_result()


# --- DDL: schemas & sequences -------------------------------------------------


@app.post("/api/{connection_id}/{database}/ddl/create-schema")
async def preview_create_schema(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a CREATE SCHEMA statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/create-schema``.

    Args:
        body: the ``CreateSchemaSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = SchemaCreatePreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/drop-schema")
async def preview_drop_schema(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a DROP SCHEMA statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/drop-schema``.

    Args:
        body: the ``DropSchemaSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = SchemaDropPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/rename-schema")
async def preview_rename_schema(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview an ALTER SCHEMA ... RENAME TO statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/rename-schema``.

    Args:
        body: the ``RenameSchemaSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = SchemaRenamePreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/create-sequence")
async def preview_create_sequence(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a CREATE SEQUENCE statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/create-sequence``.

    Args:
        body: the ``CreateSequenceSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = SequenceCreatePreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/alter-sequence")
async def preview_alter_sequence(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview an ALTER SEQUENCE parameter-form statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/alter-sequence``.

    Args:
        body: the ``AlterSequenceSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = SequenceAlterPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/sequence-owner")
async def preview_sequence_owner(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a sequence OWNER TO statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/sequence-owner``.

    Args:
        body: the ``SequenceOwnerSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = SequenceOwnerPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/drop-sequence")
async def preview_drop_sequence(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a DROP SEQUENCE statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/drop-sequence``.

    Args:
        body: the ``DropSequenceSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = SequenceDropPreview(c, body)
        await op.apply()

        return op.get_result()


# --- DDL: functions & types ---------------------------------------------------


@app.post("/api/{connection_id}/{database}/ddl/function-definition")
async def function_definition(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Fetch a function/procedure's definition SQL for the edit-prefill flow.

    Route: ``POST /api/{connection_id}/{database}/ddl/function-definition``.
    POST+CSRF for symmetry with the other DDL routes, even though this reads
    rather than mutates — the routine's identity signature lives in the body.

    Args:
        body: ``{schema, name, signature}`` — the routine's identity-argument
            signature disambiguates overloads.

    Returns:
        ``{"definition", "isProcedure", "signature", "language"}``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = FunctionDefinitionQuery(c, body.get("schema", ""), body.get("name", ""), body.get("signature", ""))
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/type-definition")
async def type_definition(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Introspect an enum or composite type for the edit-prefill flow.

    Route: ``POST /api/{connection_id}/{database}/ddl/type-definition``.

    Args:
        body: ``{schema, name}``.

    Returns:
        ``{"category", "labels", "attributes"}``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = TypeDefinitionQuery(c, body.get("schema", ""), body.get("name", ""))
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/create-function")
async def preview_create_function(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a CREATE [OR REPLACE] FUNCTION|PROCEDURE statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/create-function``.

    Args:
        body: the ``CreateFunctionSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = CreateFunctionPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/drop-function")
async def preview_drop_function(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a DROP FUNCTION|PROCEDURE statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/drop-function``.

    Args:
        body: the ``DropFunctionSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = DropFunctionPreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/create-enum-type")
async def preview_create_enum_type(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a CREATE TYPE ... AS ENUM statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/create-enum-type``.

    Args:
        body: the ``CreateEnumTypeSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = CreateEnumTypePreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/create-composite-type")
async def preview_create_composite_type(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a CREATE TYPE ... AS (...) composite-type statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/create-composite-type``.

    Args:
        body: the ``CreateCompositeTypeSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = CreateCompositeTypePreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/drop-type")
async def preview_drop_type(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview a DROP TYPE statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/drop-type``.

    Args:
        body: the ``DropTypeSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = DropTypePreview(c, body)
        await op.apply()

        return op.get_result()


@app.post("/api/{connection_id}/{database}/ddl/alter-type-add-value")
async def preview_alter_type_add_value(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Preview an ALTER TYPE ... ADD VALUE statement.

    Route: ``POST /api/{connection_id}/{database}/ddl/alter-type-add-value``.

    Args:
        body: the ``AlterTypeAddValueSpec`` wire payload.

    Returns:
        ``{"sql": str}`` — the generated statement, for the editable preview.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = AlterTypeAddValuePreview(c, body)
        await op.apply()

        return op.get_result()


# --- Full-table streaming export ------------------------------------------


# The content type and file extension per export format.
_EXPORT_MEDIA = {"csv": ("text/csv", "csv"), "json": ("application/json", "json")}


@app.get("/api/{connection_id}/{database}/{schema}/{table}/export")
async def export_rows(
    connection_id: str, database: str, schema: str, table: str, format: str = "csv",
    session: Session = Depends(require_session),
) -> StreamingResponse:
    """
    Stream a table/view's full contents as CSV or JSON (attachment download).

    Route: ``GET /api/{connection_id}/{database}/{schema}/{table}/export``.

    The connection is acquired for the streaming lifetime (a server-side cursor
    needs its connection alive across the response) and released in the body
    generator's ``finally`` — the one place a connection outlives the
    ``async with acquire()`` sugar. A relation that does not exist is a 404 (the
    ``_columns_for`` gate); an unsupported ``format`` is a 422 (the operation's
    constructor validation), with the connection released before re-raising.

    Args:
        format: the export format, "csv" (default) or "json".

    Returns:
        A ``StreamingResponse`` whose ``Content-Disposition`` marks it an
        attachment named ``<schema>.<table>.<ext>``.
    """
    ref = TableRef(database, schema, table)
    pool = session_pool_for(session, connection_id)
    conn = await pool.acquire()

    try:
        cols = await _columns_for(conn, ref)
        op = ExportRowsQuery(conn, ref, format, cols)
    except BaseException:
        # Release before propagating so a 404/422 never leaks the connection.
        await pool.release(conn)
        raise

    media, ext = _EXPORT_MEDIA[format]

    async def body() -> AsyncIterator[str]:
        """
        Stream the export chunks, releasing the connection when exhausted or on a
        client-aborted download (the generator's ``finally`` runs on close/GC).
        """
        try:
            async for chunk in op.stream():
                yield chunk
        finally:
            await pool.release(conn)

    return StreamingResponse(
        body(),
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{schema}.{table}.{ext}"'},
    )


# Must stay the last statement in this file: it registers a catch-all
# `GET /{full_path:path}` route, and FastAPI matches routes in registration
# order. Any @app.get(...) added below this line would be unreachable.
mount_static(app)
