"""
Serves the built frontend (``frontend/dist``) alongside the API, so a single
container can host both. Wired from the bottom of ``main.py`` — see the
ordering comment there for why it must be the last statement in the file.

Environment reading mirrors ``config.py``: a module-level ``_..._ENV``
constant, bare ``os.environ``, a documented default, no settings framework.
A host-run backend during development has no static directory, so
``mount_static`` registers nothing and the Vite dev server keeps serving the
frontend, proxying ``/api`` per ``frontend/vite.config.ts``.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .errors import NotFound

# Env var naming the directory holding the built frontend (index.html + assets/).
_STATIC_DIR_ENV = "SQLADMIN_STATIC_DIR"

# Where the Docker image copies `frontend/dist`.
_DEFAULT_STATIC_DIR = "/srv/static"


def static_dir() -> Path | None:
    """The directory holding the built frontend, or None when absent."""
    path = Path(os.environ.get(_STATIC_DIR_ENV) or _DEFAULT_STATIC_DIR)

    return path if (path / "index.html").is_file() else None


def mount_static(app: FastAPI) -> None:
    """Mount the built frontend on `app`; a no-op when `static_dir()` is None."""
    directory = static_dir()

    if directory is None:
        return

    app.mount("/assets", StaticFiles(directory=directory / "assets"), name="assets")
    index = directory / "index.html"

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_index(full_path: str) -> FileResponse:
        if full_path == "api" or full_path.startswith("api/"):
            raise NotFound(f"No such API route: /{full_path}")

        # `no-cache` so a browser revalidates the shell; the assets it points at
        # are content-hashed by Vite and cached normally by StaticFiles.
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
