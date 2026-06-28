"""
connectionId -> asyncpg.Pool registry.

The multi-DB seam: routes are namespaced ``/api/{connectionId}/...`` and look up a
pool by id. Phase 0-1 seed exactly one entry ("default") from ``DATABASE_URL``.
The pools are owned by the FastAPI ``lifespan`` (see ``main.py``), opened on
startup and closed on shutdown; each request ``acquire()``s a connection.
"""

from __future__ import annotations

import json
import os

import asyncpg

from .errors import NotFound

pools: dict[str, asyncpg.Pool] = {}


def connection_dsns() -> dict[str, str]:
    """
    Resolve the connectionId -> DSN map.

    Phase 0-1 seed a single ``"default"`` entry from ``DATABASE_URL``.

    Raises:
        RuntimeError: if ``DATABASE_URL`` is not set.

    Returns:
        A mapping of connectionId to DSN.
    """
    dsn = os.environ.get("DATABASE_URL")

    if not dsn:
        raise RuntimeError("DATABASE_URL is not set")

    return {"default": dsn}


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


async def open_pools() -> None:
    """
    Open one pool per registered connection (called from the lifespan startup).
    """
    for conn_id, dsn in connection_dsns().items():
        pools[conn_id] = await asyncpg.create_pool(dsn, init=_init_connection)


async def close_pools() -> None:
    """
    Close every open pool (called from the lifespan shutdown).
    """
    for pool in pools.values():
        await pool.close()

    pools.clear()


def get_pool(connection_id: str) -> asyncpg.Pool:
    """
    Look up an open pool by connectionId.

    Raises:
        NotFound: if no pool is registered for ``connection_id``.

    Returns:
        The open ``asyncpg.Pool`` for that connection.
    """
    pool = pools.get(connection_id)

    if pool is None:
        raise NotFound(f"Unknown connection '{connection_id}'")

    return pool
