"""
Full-table streaming export: stream a table/view's full contents as CSV or
JSON, with the connection kept alive for the streaming lifetime.
"""

from __future__ import annotations

from typing import AsyncIterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..auth import require_session
from ..connections import Session, session_pool_for
from ..contract import TableRef
from ..export_format import EXPORT_MEDIA, content_disposition
from ..operations import ExportRowsQuery
from .common import DATABASE_PREFIX, columns_for

router = APIRouter(prefix=DATABASE_PREFIX, tags=["export"])


@router.get("/{schema}/{table}/export")
async def export_rows(
    connection_id: str, database: str, schema: str, table: str, format: str = "csv",
    session: Session = Depends(require_session),
) -> StreamingResponse:
    """
    Stream a table/view's full contents as CSV or JSON (attachment download).

    Route: ``GET /api/{connection_id}/db/{database}/{schema}/{table}/export``.

    The connection is acquired for the streaming lifetime (a server-side cursor
    needs its connection alive across the response) and released in the body
    generator's ``finally`` — the one place a connection outlives the
    ``async with acquire()`` sugar. A relation that does not exist is a 404 (the
    ``columns_for`` gate); an unsupported ``format`` is a 422 (the operation's
    constructor validation), with the connection released before re-raising.

    Args:
        format: the export format, "csv" (default) or "json".

    Returns:
        A ``StreamingResponse`` whose ``Content-Disposition`` marks it an
        attachment named ``<schema>.<table>.<ext>``; the schema/table
        identifiers are sanitized before reaching the header, since a Postgres
        identifier may hold a double quote, a CR/LF, or any Unicode character.
    """
    ref = TableRef(database, schema, table)
    pool = session_pool_for(session, connection_id)
    conn = await pool.acquire()

    try:
        cols = await columns_for(conn, ref)
        op = ExportRowsQuery(conn, ref, format, cols)
    except BaseException:
        # Release before propagating so a 404/422 never leaks the connection.
        await pool.release(conn)
        raise

    # Safe to index unguarded: ExportRowsQuery's constructor (above) validates
    # `format` against the keys of this very map.
    media, ext = EXPORT_MEDIA[format]

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
        headers={"Content-Disposition": content_disposition(schema, table, ext)},
    )
