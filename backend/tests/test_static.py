"""
Tests for ``app.static``: the built-frontend directory resolution and the SPA
mount (assets + catch-all fallback). Pure logic plus httpx ``ASGITransport``
route tests — no database, no session.

Each test that needs a static directory builds one under ``tmp_path``
(``index.html`` plus ``assets/app.js``), points ``SQLADMIN_STATIC_DIR`` at it
with ``monkeypatch.setenv``, and calls ``mount_static`` on a **fresh**
``FastAPI()`` instance — not on the imported ``app.main.app``, whose
``mount_static`` already ran at import time with no directory present.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient

from app.errors import DomainError
from app.static import mount_static, static_dir


def _build_static_dir(tmp_path: Path) -> Path:
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html><body>shell</body></html>")
    (tmp_path / "assets" / "app.js").write_text("console.log('app');")

    return tmp_path


# --- static_dir() -----------------------------------------------------------


def test_static_dir_none_when_path_does_not_exist(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SQLADMIN_STATIC_DIR", str(tmp_path / "does-not-exist"))

    assert static_dir() is None


def test_static_dir_none_when_index_html_missing(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SQLADMIN_STATIC_DIR", str(tmp_path))

    assert static_dir() is None


def test_static_dir_env_override_wins(tmp_path, monkeypatch) -> None:
    directory = _build_static_dir(tmp_path)
    monkeypatch.setenv("SQLADMIN_STATIC_DIR", str(directory))

    assert static_dir() == directory


# --- mount_static() ----------------------------------------------------------


async def test_mount_static_adds_no_routes_when_directory_absent(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("SQLADMIN_STATIC_DIR", str(tmp_path / "does-not-exist"))

    fresh_app = FastAPI()
    mount_static(fresh_app)

    transport = ASGITransport(app=fresh_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/")

    assert resp.status_code == 404


@pytest.fixture
def static_app(tmp_path, monkeypatch) -> FastAPI:
    directory = _build_static_dir(tmp_path)
    monkeypatch.setenv("SQLADMIN_STATIC_DIR", str(directory))

    fresh_app = FastAPI()

    # Mirrors the DomainError -> {status, detail} mapping main.py registers on
    # the real app; the fallback route raises NotFound (a DomainError), and a
    # fresh FastAPI() has no handler for it without this.
    @fresh_app.exception_handler(DomainError)
    async def _domain_error_handler(request: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @fresh_app.get("/api/config")
    async def _config() -> dict[str, str]:
        return {"config": "ok"}

    @fresh_app.post("/api/login")
    async def _login() -> dict[str, str]:
        return {"login": "ok"}

    mount_static(fresh_app)

    return fresh_app


async def test_root_serves_the_shell(static_app) -> None:
    transport = ASGITransport(app=static_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/")

    assert resp.status_code == 200
    assert resp.text == "<html><body>shell</body></html>"


async def test_deep_path_serves_the_shell(static_app) -> None:
    transport = ASGITransport(app=static_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/some/deep/link")

    assert resp.status_code == 200
    assert resp.text == "<html><body>shell</body></html>"


async def test_assets_are_served_as_themselves(static_app) -> None:
    transport = ASGITransport(app=static_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/assets/app.js")

    assert resp.status_code == 200
    assert resp.text == "console.log('app');"


async def test_unknown_api_path_404s_as_json(static_app) -> None:
    transport = ASGITransport(app=static_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/nope")

    assert resp.status_code == 404
    assert "detail" in resp.json()
    assert resp.headers["content-type"].startswith("application/json")


async def test_real_api_get_route_still_wins(static_app) -> None:
    transport = ASGITransport(app=static_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/api/config")

    assert resp.status_code == 200
    assert resp.json() == {"config": "ok"}


async def test_non_get_api_route_is_untouched(static_app) -> None:
    transport = ASGITransport(app=static_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.post("/api/login")

    assert resp.status_code == 200
    assert resp.json() == {"login": "ok"}


async def test_shell_response_is_not_cached(static_app) -> None:
    transport = ASGITransport(app=static_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        resp = await client.get("/")

    assert resp.headers["cache-control"] == "no-cache"
