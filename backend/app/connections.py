"""
Per-session ``asyncpg.Pool`` store — one authenticated session owns one pool.

A user logs in with full connection details; ``create_session`` opens a pool for
that Postgres role, validates the credentials by forcing a real connection, and
records an opaque server-side ``Session`` keyed by a random cookie token. Routes
namespaced ``/api/{connectionId}/...`` resolve their pool from the request's
session (the cookie), not from a global registry — the ``connection_id`` path
segment is only validated against the session's own label.

The app now boots with **zero** pools (there is no ``DATABASE_URL``); pools exist
only for the lifetime of a logged-in session and are closed on logout, on idle
eviction (``sweep_idle_sessions``), and on shutdown (``close_all_sessions``).
"""

from __future__ import annotations

import json
import secrets
import time
from dataclasses import dataclass

import asyncpg

from .errors import NotFound, Unauthorized

# Per-session pool bound so N concurrent sessions cannot exhaust Postgres
# ``max_connections``; a session rarely needs more than a few connections.
SESSION_POOL_MAX_SIZE = 5

# A session whose last request is older than this is evicted by the sweep and
# its pool closed (30 minutes).
SESSION_IDLE_TIMEOUT_SECONDS = 1800

# How often the background sweep wakes to evict idle sessions (60 seconds).
SWEEP_INTERVAL_SECONDS = 60

# Byte-entropy of the opaque session and CSRF tokens (256 bits via urlsafe b64).
_TOKEN_BYTES = 32


@dataclass(frozen=True)
class ConnParts:
    """
    The connection details a login supplies (the password included, used once to
    open the pool and never stored on the ``Session``).
    """

    host: str
    port: int
    database: str
    username: str
    password: str
    connection_id: str


@dataclass
class Session:
    """
    One authenticated login: its pool plus the labels routes and the frontend
    need. The plaintext password is **not** a field — it is used once by
    ``create_session`` and dropped.
    """

    id: str  # opaque cookie token; never returned in a response body
    connection_id: str  # stable client-facing label, echoed in URLs
    csrf_token: str  # synchronizer token, returned in JSON bodies
    pool: asyncpg.Pool
    username: str  # for whoami display; NOT the password
    host: str
    database: str
    last_seen: float  # monotonic seconds, bumped per request


# Module-global registry: cookie token -> Session.
_sessions: dict[str, Session] = {}


async def _init_connection(conn: asyncpg.Connection) -> None:
    """
    Per-connection setup: decode json/jsonb to Python objects.

    asyncpg returns json/jsonb as raw text otherwise, so registering this codec
    lets ``WireType.JSON`` values pass through already-parsed.
    """
    for typename in ("json", "jsonb"):
        await conn.set_type_codec(
            typename, encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
        )


async def create_session(parts: ConnParts) -> Session:
    """
    Open a pool for the supplied credentials, validate them, and register a
    session.

    The pool is created with ``min_size=0`` (so idle sessions hold no
    connections), which means ``create_pool`` does **not** dial Postgres by
    itself and would not surface bad credentials. So this forces one real
    connection (``SELECT 1``) to validate the credentials, reachability, and the
    target database; on any failure it closes the pool and re-raises so the
    ``login`` handler can map the driver error to a 401.

    Args:
        parts: the login's connection details (password used once, not stored).

    Returns:
        The registered ``Session`` (its ``id`` is the cookie token).
    """
    pool = await asyncpg.create_pool(
        host=parts.host,
        port=parts.port,
        user=parts.username,
        password=parts.password,
        database=parts.database,
        min_size=0,
        max_size=SESSION_POOL_MAX_SIZE,
        init=_init_connection,
    )

    try:
        async with pool.acquire() as conn:
            await conn.execute("SELECT 1")
    except BaseException:
        # Release the pool before propagating so a failed login leaks nothing.
        await pool.close()
        raise

    session = Session(
        id=secrets.token_urlsafe(_TOKEN_BYTES),
        connection_id=parts.connection_id,
        csrf_token=secrets.token_urlsafe(_TOKEN_BYTES),
        pool=pool,
        username=parts.username,
        host=parts.host,
        database=parts.database,
        last_seen=time.monotonic(),
    )
    _sessions[session.id] = session

    return session


def get_session(session_id: str | None) -> Session:
    """
    Look up a live session by its cookie token.

    Raises:
        Unauthorized: if the token is absent or unknown (forged/expired).

    Returns:
        The registered ``Session``.
    """
    session = _sessions.get(session_id) if session_id else None

    if session is None:
        raise Unauthorized("Not authenticated")

    return session


async def close_session(session_id: str | None) -> None:
    """
    Drop a session and close its pool (logout / instant revoke). A no-op for an
    unknown token.
    """
    if not session_id:
        return

    session = _sessions.pop(session_id, None)

    if session is not None:
        await session.pool.close()


async def sweep_idle_sessions() -> None:
    """
    Close and drop every session idle longer than the timeout (one sweep pass).
    """
    now = time.monotonic()
    expired = [
        sid
        for sid, s in _sessions.items()
        if now - s.last_seen > SESSION_IDLE_TIMEOUT_SECONDS
    ]

    for sid in expired:
        session = _sessions.pop(sid, None)

        if session is not None:
            await session.pool.close()


async def close_all_sessions() -> None:
    """
    Close every open pool and clear the registry (lifespan shutdown).
    """
    for session in _sessions.values():
        await session.pool.close()

    _sessions.clear()


def session_pool_for(session: Session, connection_id: str) -> asyncpg.Pool:
    """
    Resolve a session's pool, guarding the path ``connection_id`` against the
    session's own label so a stale URL from another login can't reach this pool.

    Raises:
        NotFound: if ``connection_id`` does not match ``session.connection_id``.

    Returns:
        The session's ``asyncpg.Pool``.
    """
    if connection_id != session.connection_id:
        raise NotFound(f"Unknown connection '{connection_id}'")

    return session.pool
