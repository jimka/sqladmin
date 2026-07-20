"""
Tests for ``app.rate_limit``: the sliding-window login-failure limiter, both as
pure logic against ``_failures`` and through the ``POST /api/login`` route.
"""

from __future__ import annotations

import time
from typing import cast

import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient

from app import rate_limit
from app.errors import TooManyRequests
from app.main import app
from app.rate_limit import (
    LOGIN_FAILURE_LIMIT,
    LOGIN_FAILURE_WINDOW_SECONDS,
    check_login_rate_limit,
    clear_login_failures,
    record_login_failure,
)


class _FakeRequest:
    """A stand-in for ``fastapi.Request`` exposing only what ``client_key`` reads."""

    def __init__(self, host: str = "127.0.0.1") -> None:
        self.client = type("_Client", (), {"host": host})()


def _request(host: str = "127.0.0.1") -> Request:
    """A fake request, typed as ``Request`` for the functions under test."""
    return cast(Request, _FakeRequest(host))


# --- pure logic ------------------------------------------------------------


def test_under_limit_passes() -> None:
    now = time.monotonic()
    rate_limit._failures["127.0.0.1"] = [now] * (LOGIN_FAILURE_LIMIT - 1)

    check_login_rate_limit(_request())  # does not raise


def test_at_limit_raises_with_retry_after() -> None:
    now = time.monotonic()
    rate_limit._failures["127.0.0.1"] = [now] * LOGIN_FAILURE_LIMIT

    with pytest.raises(TooManyRequests) as exc_info:
        check_login_rate_limit(_request())

    headers = exc_info.value.headers
    assert headers is not None
    assert int(headers["Retry-After"]) >= 1


def test_expired_timestamps_do_not_count() -> None:
    stale = time.monotonic() - LOGIN_FAILURE_WINDOW_SECONDS - 1
    rate_limit._failures["127.0.0.1"] = [stale] * LOGIN_FAILURE_LIMIT

    check_login_rate_limit(_request())  # does not raise

    assert "127.0.0.1" not in rate_limit._failures


def test_failures_accumulate() -> None:
    request = _request()

    for _ in range(LOGIN_FAILURE_LIMIT):
        record_login_failure(request)

    assert len(rate_limit._failures["127.0.0.1"]) == LOGIN_FAILURE_LIMIT


def test_success_clears_failures() -> None:
    request = _request()

    for _ in range(5):
        record_login_failure(request)

    clear_login_failures(request)

    assert "127.0.0.1" not in rate_limit._failures


def test_pruning_is_global() -> None:
    now = time.monotonic()
    stale = now - LOGIN_FAILURE_WINDOW_SECONDS - 1

    rate_limit._failures["stale-client"] = [stale]
    rate_limit._failures["fresh-client"] = [now]

    record_login_failure(_request("third-client"))

    assert set(rate_limit._failures) == {"fresh-client", "third-client"}


# --- route -------------------------------------------------------------


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_route_returns_429_after_limit(monkeypatch) -> None:
    monkeypatch.delenv("SQLADMIN_ALLOWED_HOSTS", raising=False)

    async with _client() as client:
        for _ in range(LOGIN_FAILURE_LIMIT):
            resp = await client.post(
                "/api/login",
                json={"host": "localhost", "port": 5432, "database": "d",
                      "username": "u", "password": "p"},
            )
            assert resp.status_code == 403

        eleventh = await client.post(
            "/api/login",
            json={"host": "localhost", "port": 5432, "database": "d",
                  "username": "u", "password": "p"},
        )

    assert eleventh.status_code == 429
    assert "Retry-After" in eleventh.headers
    assert "Too many failed login attempts" in eleventh.json()["detail"]


async def test_rate_limited_request_does_not_dial(monkeypatch) -> None:
    monkeypatch.delenv("SQLADMIN_ALLOWED_HOSTS", raising=False)

    async with _client() as client:
        for _ in range(LOGIN_FAILURE_LIMIT):
            resp = await client.post(
                "/api/login",
                json={"host": "localhost", "port": 5432, "database": "d",
                      "username": "u", "password": "p"},
            )
            assert resp.status_code == 403

        # This attempt names an allowed host that nothing listens on — if the
        # limiter let it through it would dial and come back 401, not 429.
        monkeypatch.setenv("SQLADMIN_ALLOWED_HOSTS", "127.0.0.1:1")

        eleventh = await client.post(
            "/api/login",
            json={"host": "127.0.0.1", "port": 1, "database": "d",
                  "username": "u", "password": "p"},
        )

    assert eleventh.status_code == 429
