"""
Tests for ``app.config``: ``SERVER_PRESETS`` / ``ALLOW_USER_PRESETS`` parsing and
the pre-auth ``GET /api/config`` route. Pure logic plus one httpx
``ASGITransport`` route test — no database, no session.
"""

from __future__ import annotations

import json
from dataclasses import asdict

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import allow_user_presets, server_presets
from app.main import app


def test_server_presets_parses_valid(monkeypatch) -> None:
    monkeypatch.setenv(
        "SERVER_PRESETS",
        json.dumps([{"name": "Local", "host": "localhost", "port": 5432, "database": "sqladmin"}]),
    )

    presets = server_presets()

    assert len(presets) == 1
    assert presets[0].name == "Local"
    assert presets[0].port == 5432


def test_server_presets_drops_credential_keys(monkeypatch) -> None:
    monkeypatch.setenv(
        "SERVER_PRESETS",
        json.dumps(
            [{"name": "P", "host": "h", "port": 5432, "database": "d",
              "username": "u", "password": "secret"}]
        ),
    )

    presets = server_presets()

    assert len(presets) == 1
    assert set(asdict(presets[0])) == {"name", "host", "port", "database"}


def test_server_presets_empty_on_unset(monkeypatch) -> None:
    monkeypatch.delenv("SERVER_PRESETS", raising=False)

    assert server_presets() == []


def test_server_presets_empty_on_malformed(monkeypatch) -> None:
    monkeypatch.setenv("SERVER_PRESETS", "{not json")
    assert server_presets() == []

    monkeypatch.setenv("SERVER_PRESETS", json.dumps({"not": "a list"}))
    assert server_presets() == []


def test_server_presets_skips_bad_entry(monkeypatch) -> None:
    monkeypatch.setenv(
        "SERVER_PRESETS",
        json.dumps(
            [{"name": "ok", "host": "h", "port": 5432, "database": "d"},
             {"name": "missing port", "host": "h", "database": "d"}]
        ),
    )

    presets = server_presets()

    assert [p.name for p in presets] == ["ok"]


def test_allow_user_presets_default_true(monkeypatch) -> None:
    monkeypatch.delenv("ALLOW_USER_PRESETS", raising=False)

    assert allow_user_presets() is True


@pytest.mark.parametrize("value", ["0", "false", "FALSE", "no", "No"])
def test_allow_user_presets_falsey(monkeypatch, value) -> None:
    monkeypatch.setenv("ALLOW_USER_PRESETS", value)

    assert allow_user_presets() is False


@pytest.mark.parametrize("value", ["1", "true", "yes", "anything"])
def test_allow_user_presets_truthy(monkeypatch, value) -> None:
    monkeypatch.setenv("ALLOW_USER_PRESETS", value)

    assert allow_user_presets() is True


async def test_config_endpoint_is_unauthenticated_and_credential_free(monkeypatch) -> None:
    monkeypatch.setenv(
        "SERVER_PRESETS",
        json.dumps(
            [{"name": "Local", "host": "localhost", "port": 5432, "database": "sqladmin",
              "username": "u", "password": "secret"}]
        ),
    )
    monkeypatch.setenv("ALLOW_USER_PRESETS", "false")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/config")

    assert resp.status_code == 200
    body = resp.json()
    assert body["allowUserPresets"] is False
    assert body["presets"] == [
        {"name": "Local", "host": "localhost", "port": 5432, "database": "sqladmin"}
    ]
    # No credential key surfaces, and a pre-auth read sets no cookie.
    assert "password" not in json.dumps(body)
    assert "set-cookie" not in resp.headers
