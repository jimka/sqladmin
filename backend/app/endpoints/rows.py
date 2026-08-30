"""
Table data CRUD: paginated row reads, insert/update/delete by primary key,
and the row-import preview/commit pair.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Body, Depends, Response

from ..auth import require_csrf, require_session
from ..connections import Session, session_pool_for
from ..contract import TableRef
from ..errors import ValidationError
from ..operations import (
    DeleteRowCommand,
    ImportRowsCommand,
    InsertRowCommand,
    ListRowsQuery,
    PreviewImportRowsQuery,
    UpdateRowCommand,
)
from .common import DATABASE_PREFIX, columns_for

router = APIRouter(prefix=DATABASE_PREFIX, tags=["rows"])

# Default page size when the client omits one (mirrors the proxy's own default).
_DEFAULT_PAGE_SIZE = 100


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


@router.get("/{schema}/{table}/rows")
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

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/{table}/rows``.

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
        cols = await columns_for(c, ref)
        op = ListRowsQuery(
            c, ref, page, pageSize, _parse_json_array(sort), _parse_json_array(filter), cols
        )
        await op.apply()

        return op.get_result()


@router.post("/{schema}/{table}/rows")
async def insert_row(
    connection_id: str, database: str, schema: str, table: str, data: dict = Body(...),
    session: Session = Depends(require_csrf),
) -> dict:
    """
    Insert a row and return the created record.

    Route: ``POST /api/{connection_id}/db/{database}/{schema}/{table}/rows``.

    Args:
        data: the new row as a JSON object; server-managed columns (PK,
            generated) are expected to be omitted by the client writer.

    Returns:
        The created row with wire-mapped scalar values.
    """
    ref = TableRef(database, schema, table)

    async with session_pool_for(session, connection_id).acquire() as c:
        cols = await columns_for(c, ref)
        op = InsertRowCommand(c, ref, data, cols)
        await op.apply()

        return op.get_result()


@router.put("/{schema}/{table}/rows/{row_id}")
async def update_row(
    connection_id: str, database: str, schema: str, table: str, row_id: str,
    data: dict = Body(...), session: Session = Depends(require_csrf),
) -> dict:
    """
    Update a row by primary key and return the updated record.

    Route: ``PUT /api/{connection_id}/db/{database}/{schema}/{table}/rows/{row_id}``.

    Args:
        row_id: the primary-key value, matched as text.
        data: the row's column values as a JSON object (the PK is ignored).

    Returns:
        The updated row with wire-mapped scalar values.
    """
    ref = TableRef(database, schema, table)

    async with session_pool_for(session, connection_id).acquire() as c:
        cols = await columns_for(c, ref)
        op = UpdateRowCommand(c, ref, row_id, data, cols)
        await op.apply()

        return op.get_result()


@router.delete("/{schema}/{table}/rows/{row_id}", status_code=204)
async def delete_row(
    connection_id: str, database: str, schema: str, table: str, row_id: str,
    session: Session = Depends(require_csrf),
) -> Response:
    """
    Delete a row by primary key.

    Route: ``DELETE /api/{connection_id}/db/{database}/{schema}/{table}/rows/{row_id}``.

    Args:
        row_id: the primary-key value, matched as text.

    Returns:
        An empty ``204 No Content`` response.
    """
    ref = TableRef(database, schema, table)

    async with session_pool_for(session, connection_id).acquire() as c:
        cols = await columns_for(c, ref)
        op = DeleteRowCommand(c, ref, row_id, cols)
        await op.apply()

        return Response(status_code=204)


@router.post("/{schema}/{table}/rows/import/preview")
async def preview_import_rows(
    connection_id: str, database: str, schema: str, table: str, data: dict = Body(...),
    session: Session = Depends(require_csrf),
) -> dict:
    """
    Validate every row of a proposed import without writing anything.

    Route: ``POST /api/{connection_id}/db/{database}/{schema}/{table}/rows/import/preview``.

    Args:
        data: ``{"rows": [...]}`` — the file's parsed rows, as plain JSON
            objects keyed by column name.

    Returns:
        ``{"rows": [...], "totalRows": int, "errorRows": int}`` — one
        ``{rowNumber, ok, values | error}`` entry per row.
    """
    ref = TableRef(database, schema, table)

    async with session_pool_for(session, connection_id).acquire() as c:
        cols = await columns_for(c, ref)
        op = PreviewImportRowsQuery(ref, data.get("rows", []), cols)
        await op.apply()

        return op.get_result()


@router.post("/{schema}/{table}/rows/import")
async def import_rows(
    connection_id: str, database: str, schema: str, table: str, data: dict = Body(...),
    session: Session = Depends(require_csrf),
) -> dict:
    """
    Insert every row of a validated import in one all-or-nothing transaction.

    Route: ``POST /api/{connection_id}/db/{database}/{schema}/{table}/rows/import``.

    Args:
        data: ``{"rows": [...]}`` — the same shape ``preview_import_rows`` takes.

    Returns:
        ``{"insertedCount": int}``.
    """
    ref = TableRef(database, schema, table)

    async with session_pool_for(session, connection_id).acquire() as c:
        cols = await columns_for(c, ref)
        op = ImportRowsCommand(c, ref, data.get("rows", []), cols)
        await op.apply()

        return op.get_result()
