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

from app.config import allow_user_presets, enable_docs, parse_bool, server_presets
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


# --- docs UIs off by default -----------------------------------------------


def test_docs_are_off_by_default() -> None:
    # SQLADMIN_ENABLE_DOCS is unset for the test process, and app.main is
    # already imported at module load, so this reflects the real default.
    assert app.docs_url is None
    assert app.redoc_url is None
    assert app.openapi_url is None


async def test_openapi_json_is_404_when_docs_are_off() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/openapi.json")

    assert resp.status_code == 404


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_parse_bool_true_values(value) -> None:
    assert parse_bool(value) is True


@pytest.mark.parametrize("value", ["0", "false", "FALSE", "no", "off"])
def test_parse_bool_false_values(value) -> None:
    assert parse_bool(value) is False


@pytest.mark.parametrize("value", [None, "banana"])
def test_parse_bool_unrecognized_is_none(value) -> None:
    assert parse_bool(value) is None


def test_enable_docs_true_only_for_truthy(monkeypatch) -> None:
    monkeypatch.delenv("SQLADMIN_ENABLE_DOCS", raising=False)
    assert enable_docs() is False

    monkeypatch.setenv("SQLADMIN_ENABLE_DOCS", "banana")
    assert enable_docs() is False

    monkeypatch.setenv("SQLADMIN_ENABLE_DOCS", "true")
    assert enable_docs() is True


# --- no CORS -----------------------------------------------------------


async def test_config_route_has_no_cors_headers() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/config", headers={"Origin": "http://localhost:5173"})

    assert resp.status_code == 200
    assert "access-control-allow-origin" not in resp.headers


async def test_login_preflight_has_no_cors_headers() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.options(
            "/api/login",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "POST",
            },
        )

    assert not (resp.status_code == 200 and "access-control-allow-origin" in resp.headers)
