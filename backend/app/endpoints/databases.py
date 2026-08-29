"""
The connection's database list — the navigator's top level.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import require_session
from ..connections import Session, session_pool_for
from ..operations import ListDatabasesQuery
from .common import CONNECTION_PREFIX

router = APIRouter(prefix=CONNECTION_PREFIX, tags=["databases"])


@router.get("/databases")
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
