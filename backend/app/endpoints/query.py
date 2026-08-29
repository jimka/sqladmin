"""
The three routes that take a SQL string in the body and run it on the
session's connection: arbitrary query execution, EXPLAIN, and the single DDL
execute every phase's preview/confirm dialog reuses. ``ddl/execute`` lives
here rather than in ``ddl.py`` because it is connection-scoped, not
database-scoped, like its two neighbours.
"""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends

from ..auth import require_csrf
from ..connections import Session, session_pool_for
from ..operations import ExecuteDdlCommand, ExplainQueryCommand, RunQueryCommand
from .common import CONNECTION_PREFIX

router = APIRouter(prefix=CONNECTION_PREFIX, tags=["query"])


@router.post("/query")
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
        result was capped at ``MAX_ROWS_PER_REQUEST``), or
        ``{"kind": "status", "command", "rowCount"}`` for one that did not
        (INSERT/UPDATE/DDL).
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = RunQueryCommand(c, body.get("sql", ""))
        await op.apply()

        return op.get_result()


@router.post("/explain")
async def explain_query(
    connection_id: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Run EXPLAIN / EXPLAIN ANALYZE for one statement and return its query plan.

    Route: ``POST /api/{connection_id}/explain``.

    Args:
        body: ``{"sql": str, "analyze": bool, "format": "text"|"json", "verbose": bool}``
            — the statement to explain (a ``;``-separated script is rejected by the
            extended query protocol as a 400). ANALYZE executes the statement,
            but the operation rolls the transaction back so no write is committed.
            ``verbose`` adds VERBOSE, which reports each scanned relation's schema
            and alias-qualifies every predicate column; defaults to False.

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
            bool(body.get("verbose", False)),
        )
        await op.apply()

        return op.get_result()


@router.post("/ddl/execute")
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
