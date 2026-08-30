"""
Tests for ``app.connections``: the per-session ``asyncpg.Pool`` store —
``create_session``'s probe-then-register flow, ``get_session``/``close_session``
lookups, and shutdown (``close_all_sessions``). ``sweep_idle_sessions`` stays
covered in ``test_auth.py`` (``test_sweep_evicts_idle_session``), not here.
``asyncpg.create_pool`` is patched per test (see ``_patch_create_pool``) so
nothing here dials a real Postgres.
"""

from __future__ import annotations

import pytest

from app import connections
from app.connections import ConnParts, close_all_sessions, close_session, create_session, get_session
from app.errors import Unauthorized

_PARTS = ConnParts(
    host="db.internal",
    port=5432,
    database="sqladmin",
    username="ada",
    password="hunter2",
    connection_id="default",
)


class _FakeConn:
    """A stand-in connection recording the probe statement ``create_session`` runs."""

    def __init__(self, fail: BaseException | None = None) -> None:
        self.fail: BaseException | None = fail
        self.executed: list[str] = []

    async def execute(self, sql: str) -> None:
        self.executed.append(sql)

        if self.fail is not None:
            raise self.fail


class _FakeAcquire:
    """The async context manager ``pool.acquire()`` returns."""

    def __init__(self, conn: _FakeConn) -> None:
        self._conn: _FakeConn = conn

    async def __aenter__(self) -> _FakeConn:
        return self._conn

    async def __aexit__(self, *exc: object) -> bool:
        return False


class _FakePool:
    """A stand-in ``asyncpg.Pool`` recording its close and the args it was built with."""

    def __init__(self, conn: _FakeConn | None = None) -> None:
        self.conn: _FakeConn = conn or _FakeConn()
        self.closed: bool = False
        self.kwargs: dict[str, object] = {}

    def acquire(self) -> _FakeAcquire:
        return _FakeAcquire(self.conn)

    async def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _reset_sessions():
    """
    Empty the session registry before and after every test in this module, so a
    leaked session cannot reach ``close_all_sessions`` in a later test.
    """
    connections._sessions.clear()

    yield

    connections._sessions.clear()


def _patch_create_pool(monkeypatch, pool: _FakePool) -> _FakePool:
    """
    Make ``create_session`` hand back ``pool`` instead of dialing Postgres.
    """
    async def _create_pool(**kwargs: object) -> _FakePool:
        pool.kwargs = kwargs

        return pool

    monkeypatch.setattr("app.connections.asyncpg.create_pool", _create_pool)

    return pool


# --- create_session ----------------------------------------------------


async def test_create_session_registers_session_echoing_conn_parts(monkeypatch) -> None:
    _patch_create_pool(monkeypatch, _FakePool())

    session = await create_session(_PARTS)

    assert connections._sessions[session.id] is session
    assert session.connection_id == _PARTS.connection_id
    assert session.username == _PARTS.username
    assert session.database == _PARTS.database


async def test_create_session_runs_exactly_one_select_1_probe(monkeypatch) -> None:
    pool = _patch_create_pool(monkeypatch, _FakePool())

    await create_session(_PARTS)

    assert pool.conn.executed == ["SELECT 1"]


async def test_create_session_id_and_csrf_token_are_distinct_and_unrelated(monkeypatch) -> None:
    _patch_create_pool(monkeypatch, _FakePool())

    session = await create_session(_PARTS)

    assert session.id != session.csrf_token

    supplied = {_PARTS.host, str(_PARTS.port), _PARTS.database, _PARTS.username, _PARTS.password}
    assert session.id not in supplied
    assert session.csrf_token not in supplied


async def test_create_session_never_carries_the_password(monkeypatch) -> None:
    _patch_create_pool(monkeypatch, _FakePool())

    session = await create_session(_PARTS)

    assert "hunter2" not in repr(session)
    assert not hasattr(session, "password")


async def test_create_session_probe_failure_closes_pool_and_registers_nothing(monkeypatch) -> None:
    failure = ConnectionRefusedError("no route to host")
    pool = _patch_create_pool(monkeypatch, _FakePool(_FakeConn(fail=failure)))

    with pytest.raises(ConnectionRefusedError):
        await create_session(_PARTS)

    assert pool.closed is True
    assert connections._sessions == {}


# --- get_session ---------------------------------------------------------


async def test_get_session_returns_the_registered_session(monkeypatch) -> None:
    _patch_create_pool(monkeypatch, _FakePool())
    session = await create_session(_PARTS)

    assert get_session(session.id) is session


def test_get_session_missing_token_raises_unauthorized() -> None:
    with pytest.raises(Unauthorized):
        get_session(None)

    with pytest.raises(Unauthorized):
        get_session("nope")


# --- close_session ---------------------------------------------------------


async def test_close_session_closes_pool_and_removes_entry(monkeypatch) -> None:
    pool = _patch_create_pool(monkeypatch, _FakePool())
    session = await create_session(_PARTS)

    await close_session(session.id)

    assert pool.closed is True
    assert session.id not in connections._sessions


async def test_close_session_is_a_noop_for_unknown_tokens() -> None:
    await close_session(None)  # does not raise
    await close_session("nope")  # does not raise


# --- close_all_sessions ------------------------------------------------


async def test_close_all_sessions_closes_every_pool_and_clears_registry(monkeypatch) -> None:
    pools: list[_FakePool] = []

    async def _create_pool(**kwargs: object) -> _FakePool:
        pool = _FakePool()
        pools.append(pool)

        return pool

    monkeypatch.setattr("app.connections.asyncpg.create_pool", _create_pool)

    await create_session(_PARTS)
    await create_session(ConnParts(
        host="db.internal", port=5432, database="sqladmin",
        username="bob", password="p", connection_id="second",
    ))

    await close_all_sessions()

    assert len(pools) == 2
    assert all(pool.closed is True for pool in pools)
    assert connections._sessions == {}
