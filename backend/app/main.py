"""
FastAPI app assembly: lifespan (start/stop the idle-session sweep), the two
exception handlers mapping the typed taxonomy (and driver errors) to
``(status, {detail})``, the four auth/config routes, the router includes, and
the static mount.

Authenticated routes are namespaced ``/api/{connection_id}/...``, and every
database-scoped route sits under ``/api/{connection_id}/db/{database}/...`` so
``{database}`` can never occupy the same path position as a literal segment
like ``roles`` (see ``endpoints/common.py``). The routes themselves live in
``app/endpoints/`` — one ``APIRouter`` per resource.

The pool is resolved from the request's **session cookie** (see ``auth.py`` /
``connections.py``), not from the ``connection_id`` path segment — that segment is
only validated against the session's own label. Every POST/PUT/DELETE route
depends on ``require_csrf``, the non-mutating DDL preview POSTs included, since
the spec they read travels in the body; every other route depends on
``require_session``. ``GET /api/config`` is deliberately unauthenticated (it
feeds the login screen). The app boots with zero pools; a pool exists only for
the lifetime of a logged-in session.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import AsyncIterator

import asyncpg
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .auth import log_dial_policy, login, logout, whoami
from .config import app_config, enable_docs
from .connections import SWEEP_INTERVAL_SECONDS, close_all_sessions, sweep_idle_sessions
from .endpoints import ROUTERS
from .errors import DomainError
from .static import mount_static


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


# Registration order decides nothing: no two routes can claim the same concrete
# path (see tests/test_routes.py), so this loop follows the tuple's own order.
for _router in ROUTERS:
    app.include_router(_router)


# Must stay the last statement in this file: it registers a catch-all
# `GET /{full_path:path}` route, and FastAPI matches routes in registration
# order. Any route added below this line would be unreachable.
mount_static(app)
