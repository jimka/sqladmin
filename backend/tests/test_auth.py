"""
Tests for ``app.auth``: the host allowlist, ``session_pool_for``, and the
login/CSRF/session route behaviour. The route paths under test reject **before or
without** dialing Postgres, so no real database is needed.
"""

from __future__ import annotations

import time
from typing import cast

import asyncpg
import pytest
from httpx import ASGITransport, AsyncClient

from app import connections
from app.auth import is_host_allowed, require_session
from app.connections import Session, session_pool_for, sweep_idle_sessions
from app.errors import NotFound
from app.main import app


# --- pure logic ----------------------------------------------------------


def test_is_host_allowed_exact_and_host_port(monkeypatch) -> None:
    monkeypatch.setenv("SQLADMIN_ALLOWED_HOSTS", "db.internal, localhost:5432")

    assert is_host_allowed("db.internal", 5432) is True   # bare host, any port
    assert is_host_allowed("db.internal", 9999) is True
    assert is_host_allowed("localhost", 5432) is True     # exact host:port
    assert is_host_allowed("localhost", 5433) is False    # wrong port, not bare
    assert is_host_allowed("other", 5432) is False


def test_is_host_allowed_case_insensitive(monkeypatch) -> None:
    monkeypatch.setenv("SQLADMIN_ALLOWED_HOSTS", "LocalHost")

    assert is_host_allowed("localhost", 5432) is True
    assert is_host_allowed("LOCALHOST", 5432) is True


def test_is_host_allowed_empty_denies(monkeypatch) -> None:
    monkeypatch.delenv("SQLADMIN_ALLOWED_HOSTS", raising=False)

    assert is_host_allowed("localhost", 5432) is False


def _fake_session(csrf: str = "tok") -> Session:
    """A ``Session`` with a stand-in pool for logic tests that never dial."""
    return Session(
        id="sid",
        connection_id="default",
        csrf_token=csrf,
        pool=cast(asyncpg.Pool, object()),
        username="u",
        host="h",
        database="d",
        last_seen=time.monotonic(),
    )


def test_session_pool_for_matches() -> None:
    session = _fake_session()

    assert session_pool_for(session, "default") is session.pool


def test_session_pool_for_mismatch_raises() -> None:
    session = _fake_session()

    with pytest.raises(NotFound):
        session_pool_for(session, "other")


# --- routes (ASGITransport, no real Postgres) ----------------------------


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_login_host_not_allowed_is_403(monkeypatch) -> None:
    monkeypatch.setenv("SQLADMIN_ALLOWED_HOSTS", "allowed.host")

    async with _client() as client:
        resp = await client.post(
            "/api/login",
            json={"host": "evil.host", "port": 5432, "database": "d",
                  "username": "u", "password": "p"},
        )

    assert resp.status_code == 403
    assert "set-cookie" not in resp.headers


async def test_login_empty_allowlist_is_403(monkeypatch) -> None:
    monkeypatch.delenv("SQLADMIN_ALLOWED_HOSTS", raising=False)

    async with _client() as client:
        resp = await client.post(
            "/api/login",
            json={"host": "localhost", "port": 5432, "database": "d",
                  "username": "u", "password": "p"},
        )

    assert resp.status_code == 403


async def test_login_unreachable_host_is_401(monkeypatch) -> None:
    # An allowed host:port that nothing listens on -> connection refused (OSError)
    # surfaced by the SELECT 1 probe -> a generic 401, no cookie, no password leak.
    monkeypatch.setenv("SQLADMIN_ALLOWED_HOSTS", "127.0.0.1:1")

    async with _client() as client:
        resp = await client.post(
            "/api/login",
            json={"host": "127.0.0.1", "port": 1, "database": "d",
                  "username": "u", "password": "supersecret"},
        )

    assert resp.status_code == 401
    assert "supersecret" not in resp.text
    assert "set-cookie" not in resp.headers


async def test_protected_route_without_cookie_is_401() -> None:
    async with _client() as client:
        resp = await client.get("/api/default/databases")

    assert resp.status_code == 401


async def test_mutating_route_missing_csrf_is_403() -> None:
    # A valid session (overridden) but no X-CSRF-Token header -> 403, before any
    # pool use.
    app.dependency_overrides[require_session] = lambda: _fake_session(csrf="tok")

    try:
        async with _client() as client:
            resp = await client.post("/api/default/query", json={"sql": "SELECT 1"})
    finally:
        app.dependency_overrides.clear()

    assert resp.status_code == 403


async def test_sweep_evicts_idle_session() -> None:
    class _DummyPool:
        def __init__(self) -> None:
            self.closed = False

        async def close(self) -> None:
            self.closed = True

    pool = _DummyPool()
    session = Session(
        id="old",
        connection_id="default",
        csrf_token="t",
        pool=cast(asyncpg.Pool, pool),
        username="u",
        host="h",
        database="d",
        last_seen=time.monotonic() - connections.SESSION_IDLE_TIMEOUT_SECONDS - 1,
    )
    connections._sessions[session.id] = session

    try:
        await sweep_idle_sessions()

        assert "old" not in connections._sessions
        assert pool.closed is True
    finally:
        connections._sessions.pop("old", None)
