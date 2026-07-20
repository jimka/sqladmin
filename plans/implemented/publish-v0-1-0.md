---
depends-on: [harden-for-publication]
touches-shared: [backend/app/main.py, backend/Dockerfile, README.md, backend/README.md]
---

# Publish SQLAdmin 0.1.0 — Implementation Plan

## Overview

SQLAdmin has never been published. This plan turns the repo into something a stranger can run: it adds a license, third-party attribution, a single all-in-one Docker image that serves both the API and the built frontend, a GitHub Actions workflow that pushes that image to GHCR on a version tag, and a README rewritten around `docker run`.

It builds and proves the release machinery without firing it. Nothing here is published: no tag is pushed, no image reaches GHCR, and every check runs against a locally built image. The irreversible steps live in [`release-v0-1-0.md`](release-v0-1-0.md), which depends on this plan.

Three code changes carry the work. A new `backend/app/static.py` mounts the built frontend and adds a fallback route so any non-API path returns `index.html`; it is wired from the bottom of [`backend/app/main.py`](backend/app/main.py#L1410). A new root `Dockerfile` builds `frontend/dist` in a Node stage and copies it into the Python stage, replacing [`backend/Dockerfile`](backend/Dockerfile#L1) — whose `./backend` build context cannot see `frontend/`. A new `scripts/generate_third_party_notices.py` regenerates the dependency inventory in `THIRD-PARTY-NOTICES.md` from the two lockfiles.

Everything else is metainformation and documentation: `LICENSE.md`, license fields in [`frontend/package.json`](frontend/package.json#L1) and [`backend/pyproject.toml`](backend/pyproject.toml#L1), a rewritten [`docker-compose.yml`](docker-compose.yml#L1), and a rewritten quick start in [`README.md`](README.md#L54).

---

## Architecture Decisions

### Mirror `@jimka/typescript-ui`'s licensing layout

The license is **PolyForm Noncommercial 1.0.0**, full verbatim text in a root `LICENSE.md`, with an SPDX identifier of `PolyForm-Noncommercial-1.0.0`. Attribution lives in a root `THIRD-PARTY-NOTICES.md` split into the same two groups the sibling library uses: components bundled into the shipped artifact, and runtime dependencies installed separately.

The precedent is the installed copy of the sibling library at [`frontend/node_modules/@jimka/typescript-ui/LICENSE`](frontend/node_modules/@jimka/typescript-ui/LICENSE) and its [`THIRD-PARTY-NOTICES.md`](frontend/node_modules/@jimka/typescript-ui/THIRD-PARTY-NOTICES.md), published by the same copyright holder under the same license.[^same-license]

### The SPDX identifier is the bare string, in both halves

`frontend/package.json` gets `"license": "PolyForm-Noncommercial-1.0.0"`. `backend/pyproject.toml` gets `license = "PolyForm-Noncommercial-1.0.0"` inside `[project]`, plus a `[project.urls]` table. Both use the bare SPDX identifier — not `LicenseRef-…`, not a `{ text = … }` or `{ file = … }` table.[^spdx-form]

### Serve the SPA from a new `backend/app/static.py`, wired last in `main.py`

`main.py` already wires handlers that live in sibling modules — [`main.py:149-152`](backend/app/main.py#L149) registers `login`, `logout`, `whoami`, and `app_config`, all defined in `auth.py` / `config.py`. The static mount follows that shape: `static.py` defines `mount_static(app)`, and `main.py` calls it as the **last statement in the file**.

Calling it last is a hard ordering rule, not a style choice. FastAPI matches routes in registration order, and `mount_static` registers a catch-all `GET /{full_path:path}`. Registered anywhere earlier, that catch-all would swallow every `GET` API route below it.

### The static mount is opt-in on the directory existing

`mount_static` reads `SQLADMIN_STATIC_DIR` (default `/srv/static`) and returns immediately if that directory has no `index.html`. A host-run backend during development has no such directory, so it registers nothing and behaves exactly as today — the Vite dev server keeps serving the frontend and proxying `/api` per [`frontend/vite.config.ts:24-26`](frontend/vite.config.ts#L24).

Environment reading mirrors [`backend/app/config.py:23-30`](backend/app/config.py#L23): a module-level `_…_ENV` constant, bare `os.environ`, a documented default, no settings framework.

### The fallback route rejects `/api/…` explicitly

The catch-all returns `index.html` for every path **except** one starting with `api/`, where it raises `NotFound` from [`backend/app/errors.py:39`](backend/app/errors.py#L39). Without that guard, a typo'd or removed API route would return an HTML page with status 200 instead of a JSON 404, and the frontend's fetch client would report a parse error instead of the real failure.

| Request | Result | Why |
|---|---|---|
| `GET /` | 200, `index.html` | catch-all, empty path |
| `GET /assets/index-<hash>.js` | 200, JS bytes | `/assets` mount wins (registered before the catch-all) |
| `GET /some/deep/link` | 200, `index.html` | catch-all |
| `GET /api/config` | 200, JSON config | real route, registered before the catch-all |
| `GET /api/nope` | 404, `{"detail": …}` | catch-all's `api/` guard |
| `POST /api/login` | 200, JSON session | catch-all is `GET`-only |

The app has **no client-side router today** — no `pushState`, no `location.hash`, no route table anywhere under `frontend/src`. So "a deep link surviving a refresh" reduces to "any non-API path returns the app shell". The fallback is still required: without it `GET /anything` 404s with JSON, which is the wrong answer for a page load.

### One root `Dockerfile`; `backend/Dockerfile` is deleted

The image needs both `frontend/` and `backend/` in its build context, which `build: ./backend` cannot provide. The root `Dockerfile` is multi-stage: a Node stage runs `npm ci && npm run build`, and the Python stage — carried over almost verbatim from [`backend/Dockerfile`](backend/Dockerfile#L1), including its dependency-layer-first caching — copies `frontend/dist` to `/srv/static`. `backend/Dockerfile` is deleted; nothing else references it once compose is updated.

### The Node stage pins to the build platform so arm64 costs almost nothing

The image ships `linux/amd64` and `linux/arm64`. The Node stage declares `FROM --platform=$BUILDPLATFORM node:22-bookworm-slim`, so the frontend is built **once**, natively, and its output is copied into both architecture variants. Only the Python stage runs under QEMU emulation for arm64, and every wheel it needs has a prebuilt `aarch64` manylinux build.[^multiarch]

### Compose declares both `build` and `image`, so it does either

The compose service carries `build: context: .` **and** `image: ghcr.io/jimka/sqladmin:0.1.0`. `docker compose up --build` builds from the working tree and tags it; `docker compose pull` fetches the published image under the same name. One stanza, both behaviours, no profile.

The service is renamed `backend` → `app` and its container `sqladmin-backend` → `sqladmin-app`, because it no longer serves only the backend.

### The notices inventory is generated, not curated

`scripts/generate_third_party_notices.py` rewrites two marker-delimited blocks inside `THIRD-PARTY-NOTICES.md` — one per half. Prose outside the markers, including the full bundled-component notices, is never touched. The script uses only the Python standard library plus tools the repo already requires (`npm`, `poetry`); it adds no dependency to either half.[^generator]

It is run by hand before tagging a release, listed as a step in `## Ordered Implementation Steps`. CI does not check it.[^no-ci-notices]

---

## Public API

New module `backend/app/static.py`:

```python
def static_dir() -> Path | None:
    """The directory holding the built frontend, or None when absent."""

def mount_static(app: FastAPI) -> None:
    """Mount the built frontend on `app`; a no-op when `static_dir()` is None."""
```

No other public surface changes. `frontend/package.json` stays `"private": true` and is never published to npm.

---

## Internal Structure

### `backend/app/static.py`

```python
# Env var naming the directory holding the built frontend (index.html + assets/).
_STATIC_DIR_ENV = "SQLADMIN_STATIC_DIR"

# Where the Docker image copies `frontend/dist`.
_DEFAULT_STATIC_DIR = "/srv/static"


def static_dir() -> Path | None:
    path = Path(os.environ.get(_STATIC_DIR_ENV) or _DEFAULT_STATIC_DIR)

    return path if (path / "index.html").is_file() else None


def mount_static(app: FastAPI) -> None:
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
```

`mount_static` reads the environment at call time, so a test can point it at a `tmp_path` fixture with `monkeypatch.setenv`.

### `THIRD-PARTY-NOTICES.md` markers

The script replaces the lines strictly between each pair, leaving the markers in place:

```markdown
<!-- BEGIN GENERATED: npm -->
<!-- END GENERATED: npm -->

<!-- BEGIN GENERATED: python -->
<!-- END GENERATED: python -->
```

Each generated block is a Markdown table of `Package | Version | License`.

### `scripts/generate_third_party_notices.py`

Both inventory commands are already verified to work in this repo and to return zero unknown licenses (71 npm packages, 21 Python packages):

```python
# npm — run with cwd `frontend`. `:not(.dev)` yields the production tree
# including transitives; each entry carries name/version/license.
subprocess.run(["npm", "query", ":not(.dev)"], cwd="frontend", ...)
# drop the entry whose name is "sqladmin-frontend" (the root project itself)

# python — the main group only, resolved from backend/poetry.lock.
subprocess.run(["poetry", "-C", "backend", "show", "--only", "main", "--no-ansi"], ...)
# then, for each name, read the license out of the installed distribution:
subprocess.run(["poetry", "-C", "backend", "run", "python", "-c", _LICENSE_DUMP], ...)
```

`_LICENSE_DUMP` reads each distribution's metadata in this precedence order, taking the first that is non-empty:

| Source | Example package | Value produced |
|---|---|---|
| `License-Expression` header (PEP 639) | `anyio` | `MIT` |
| `Classifier: License :: …` headers | `annotated-types` | `MIT License` |
| `License` header, first line | — | its first line |
| none of the above | — | `UNKNOWN` |

```python
_LICENSE_DUMP = """
from importlib.metadata import metadata, version
import sys, json
out = {}
for n in sys.argv[1:]:
    m = metadata(n)
    e = m.get("License-Expression")
    cls = [c.split("::")[-1].strip() for c in (m.get_all("Classifier") or [])
           if c.startswith("License ::")]
    lic = (m.get("License") or "").strip()
    out[n] = e or "; ".join(cls) or (lic.splitlines()[0] if lic else "UNKNOWN")
print(json.dumps({n: [version(n), out[n]] for n in out}))
"""
```

The script exits non-zero if any package resolves to `UNKNOWN`, so a new dependency with missing metadata fails the release step instead of shipping an incomplete notice.

---

## Ordered Implementation Steps

### Phase 1 — License and attribution

1. **Fetch the license text.** Download the canonical PolyForm Noncommercial 1.0.0 text from <https://polyformproject.org/licenses/noncommercial/1.0.0/>. It must be **verbatim and unmodified** — do not reword, reformat, or summarize it.

2. **Create `LICENSE.md`.** Line 1 is `Copyright 2026 Jimmy Karlsson`, line 2 blank, then the fetched text beginning `# PolyForm Noncommercial License 1.0.0`. Checkpoint: `diff <(tail -n +3 LICENSE.md) <(tail -n +3 frontend/node_modules/@jimka/typescript-ui/LICENSE)` — expect **no differences**. That installed file is a known-good copy of the same license, so a non-empty diff means the fetched text was altered.

3. **Add license metainformation to `frontend/package.json`.** Keep `"private": true` and `"version": "0.1.0"`. Add, after `"version"`:

   ```json
   "description": "A web-based PostgreSQL admin client — browse schemas, edit rows, run SQL, and visualize schema and roles.",
   "license": "PolyForm-Noncommercial-1.0.0",
   "author": "Jimmy Karlsson",
   "repository": { "type": "git", "url": "git+https://github.com/jimka/sqladmin.git", "directory": "frontend" },
   "homepage": "https://github.com/jimka/sqladmin#readme",
   "bugs": { "url": "https://github.com/jimka/sqladmin/issues" },
   ```

4. **Add license metainformation to `backend/pyproject.toml`.** Insert `license = "PolyForm-Noncommercial-1.0.0"` in `[project]` immediately after `readme = "README.md"` (line 6). Insert a `[project.urls]` table **after** the `dependencies` list closes and **before** `[tool.poetry]`:

   ```toml
   [project.urls]
   Homepage = "https://github.com/jimka/sqladmin"
   Repository = "https://github.com/jimka/sqladmin"
   "Bug Tracker" = "https://github.com/jimka/sqladmin/issues"
   ```

   Do **not** add `license-files` — PEP 639 requires the referenced file to sit inside the project directory, and `LICENSE.md` is at the repo root. Checkpoint: `cd backend && poetry check` → `All set!`.

5. **Write `scripts/generate_third_party_notices.py`** per `## Internal Structure`. Make it executable.

6. **Write the prose skeleton of `THIRD-PARTY-NOTICES.md`** with the four markers in place and empty generated blocks. The hand-written sections, adapted from [`frontend/node_modules/@jimka/typescript-ui/THIRD-PARTY-NOTICES.md`](frontend/node_modules/@jimka/typescript-ui/THIRD-PARTY-NOTICES.md):

   - A preamble stating that SQLAdmin's own code is licensed separately (pointing at `LICENSE.md`), and that the file covers two groups: assets bundled into `frontend/dist` and shipped inside the Docker image, and runtime dependencies.
   - **Section 1 — bundled in the image.** Three entries whose obligations flow through from the library into `frontend/dist`, and therefore into the image:
     - **Font Awesome Free 7.2.0** icon path data, © Fonticons, Inc., CC BY 4.0. Reproduce the attribution and modification note from [`frontend/node_modules/@jimka/typescript-ui/LICENSE-FONTAWESOME.md`](frontend/node_modules/@jimka/typescript-ui/LICENSE-FONTAWESOME.md).
     - **Manrope** variable font (Latin / Latin-Extended WOFF2 subsets), SIL OFL 1.1 — copy the full OFL text from the library's notices file. `Manrope` is a Reserved Font Name.
     - **elkjs 0.10.2**, © Kiel University and contributors, **EPL-2.0**. It is bundled unmodified into `dist/assets/elk.bundled-*.js`, so the notice must state the license and where to obtain the source: <https://github.com/kieler/elkjs>. Full license text: <https://www.eclipse.org/legal/epl-2.0/>.
   - **Section 2 — frontend runtime dependencies**, containing the npm marker pair.
   - **Section 3 — backend runtime dependencies**, containing the python marker pair.

7. **Generate the inventories.** From the repo root: `python3 scripts/generate_third_party_notices.py`. Checkpoints: the file contains `@jimka/typescript-ui | 0.1.0 | PolyForm-Noncommercial-1.0.0` and `elkjs | 0.10.2 | EPL-2.0` in the npm block, and `asyncpg | 0.30.0 | Apache Software License` in the python block; `grep -c UNKNOWN THIRD-PARTY-NOTICES.md` → 0.

### Phase 2 — Static serving (test-first)

8. **Write `backend/tests/test_static.py`** covering every case in `## Expected Behaviour`, mirroring the httpx `ASGITransport` style of [`backend/tests/test_config.py:13-16`](backend/tests/test_config.py#L13). Each test that needs a static directory builds one under `tmp_path` (`index.html` plus `assets/app.js`), points `SQLADMIN_STATIC_DIR` at it with `monkeypatch.setenv`, and calls `mount_static` on a **fresh** `FastAPI()` instance — not on the imported `app.main.app`, whose `mount_static` already ran at import with no directory present. Run: `cd backend && poetry run pytest tests/test_static.py` — expect failures (the module does not exist yet).

9. **Write `backend/app/static.py`** per `## Internal Structure`. Re-run the tests — expect green.

10. **Wire it in `backend/app/main.py`.** Add `from .static import mount_static` to the sibling-module imports near [`main.py:29-39`](backend/app/main.py#L29), and add `mount_static(app)` as the **last statement in the file**, after the `export_rows` handler ends at line 1410, with a comment recording the ordering rule. Checkpoint: `tail -3 backend/app/main.py` shows the call; `grep -n "mount_static(app)" backend/app/main.py` returns exactly one line, and it is the highest-numbered statement in the file.

11. **Confirm nothing regressed.** `cd backend && poetry run pytest` — the full suite green, including the 60-odd pre-existing files that import `app.main.app`.

### Phase 3 — Image

12. **Create root `.dockerignore`:**

    ```
    .git
    .github
    .worktrees
    .vscode
    **/.venv
    **/node_modules
    **/dist
    **/__pycache__
    **/.pytest_cache
    db
    plans
    ```

    Do **not** exclude `frontend/package-lock.json` — `npm ci` requires it. Do **not** exclude `frontend/tests` or `frontend/vite.config.ts` either: the build script is `tsc --noEmit && vite build`, and [`frontend/tsconfig.json:17`](frontend/tsconfig.json#L17) puts both in the compiler's `include`. They cost a few kilobytes in the build stage and never reach the final image.

13. **Create root `Dockerfile`:**

    ```dockerfile
    # Frontend build. Pinned to the *build* platform so the JS bundle is built
    # once, natively, and copied into every target architecture — arm64 never
    # runs Node under QEMU.
    FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend

    WORKDIR /build

    # Dependency layer first so it caches independently of source changes.
    COPY frontend/package.json frontend/package-lock.json ./
    RUN npm ci

    COPY frontend/ ./
    RUN npm run build

    # API + static server.
    FROM python:3.12-slim

    ENV PYTHONUNBUFFERED=1 \
        PYTHONDONTWRITEBYTECODE=1 \
        POETRY_VERSION=2.1.1 \
        POETRY_VIRTUALENVS_CREATE=false \
        POETRY_NO_INTERACTION=1

    WORKDIR /srv

    RUN pip install --no-cache-dir "poetry==${POETRY_VERSION}"

    COPY backend/pyproject.toml backend/poetry.lock* backend/README.md ./
    RUN poetry install --only main --no-root

    COPY backend/app ./app
    COPY --from=frontend /build/dist ./static
    COPY LICENSE.md THIRD-PARTY-NOTICES.md ./

    # Run as an unprivileged user (carried over from backend/Dockerfile).
    # Everything above is installed as root and only read at runtime.
    RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin sqladmin
    USER sqladmin

    EXPOSE 8000

    # Single worker, deliberately. The session registry is a module-global dict
    # in app/connections.py, so a second worker would resolve cookies against an
    # empty registry and 401 at random. Do not add `--workers`.
    #
    # No proxy flags: uvicorn enables --proxy-headers by default and trusts only
    # 127.0.0.1; behind a reverse proxy the operator sets FORWARDED_ALLOW_IPS.
    CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
    ```

14. **Delete `backend/Dockerfile`.** Checkpoint: `grep -rn "backend/Dockerfile" . --exclude-dir=.git --exclude-dir=node_modules` — expect zero matches outside `plans/`.

15. **Rewrite the `backend` service in `docker-compose.yml`** as the `app` service, and **delete the commented-out `frontend` stub** at the bottom of the file. Its note about `npm link` not surviving into a container is obsolete: the frontend now installs `@jimka/typescript-ui@^0.1.0` from the public registry, so the Node stage does a plain `npm ci` with nothing to mount or link.

    ```yaml
      app:                             # all-in-one: API + built frontend
        # `build` and `image` together: `docker compose up --build` builds from
        # this tree and tags it; `docker compose pull` fetches the published one.
        build:
          context: .
        image: ghcr.io/jimka/sqladmin:0.1.0
        container_name: sqladmin-app
        restart: unless-stopped
        environment:
          # (allowlist comment carried over verbatim from the old backend service)
          SQLADMIN_ALLOWED_HOSTS: "db:5432,sqladmin-db:5432"
          SERVER_PRESETS: '[{"name":"Local (docker)","host":"sqladmin-db","port":5432,"database":"sqladmin"}]'
        ports:
          - "8000:8000"
        depends_on:
          db:
            condition: service_healthy
    ```

    Also update the file's header comment, which still describes the backend and frontend as unbuilt "Phase 0" stubs.

### Phase 4 — Release workflow

16. **Create `.github/workflows/release.yml`:**

    ```yaml
    name: Release

    on:
      push:
        tags:
          - "v*.*.*"

    jobs:
      image:
        runs-on: ubuntu-latest
        permissions:
          contents: read
          packages: write
        steps:
          - uses: actions/checkout@v4
          - uses: docker/setup-qemu-action@v3
          - uses: docker/setup-buildx-action@v3
          - uses: docker/login-action@v3
            with:
              registry: ghcr.io
              username: ${{ github.actor }}
              password: ${{ secrets.GITHUB_TOKEN }}
          - id: meta
            uses: docker/metadata-action@v5
            with:
              images: ghcr.io/${{ github.repository }}
              flavor: latest=auto
              tags: |
                type=semver,pattern={{version}}
                type=semver,pattern={{major}}.{{minor}}
          - uses: docker/build-push-action@v6
            with:
              context: .
              platforms: linux/amd64,linux/arm64
              push: true
              tags: ${{ steps.meta.outputs.tags }}
              labels: ${{ steps.meta.outputs.labels }}
              cache-from: type=gha
              cache-to: type=gha,mode=max
    ```

    The tag-to-image-tag mapping this produces:

    | Git tag pushed | Image tags published |
    |---|---|
    | `v0.1.0` | `0.1.0`, `0.1`, `latest` |
    | `v0.1.1` | `0.1.1`, `0.1`, `latest` |
    | `v0.2.0` | `0.2.0`, `0.2`, `latest` |
    | `v1.0.0-rc.1` | `1.0.0-rc.1` only |

    A pre-release tag gets neither a `{major}.{minor}` tag nor `latest` — `type=semver` and `flavor: latest=auto` both skip prereleases, which is why `v1.0.0-rc.1` publishes one tag.

### Phase 5 — Documentation

17. **Rewrite `README.md`.** Four edits, described in `## Documentation Impact`.

18. **Update `backend/README.md`.** Add a short paragraph after the "Run locally" section noting that `SQLADMIN_STATIC_DIR` (default `/srv/static`) makes the backend serve a built frontend, and that when the directory is absent the backend serves the API only — the development arrangement.

This plan stops here. Tagging, pushing, and making the GHCR package public are irreversible, and live in [`release-v0-1-0.md`](release-v0-1-0.md).

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `LICENSE.md` |
| Create | `THIRD-PARTY-NOTICES.md` |
| Create | `scripts/generate_third_party_notices.py` |
| Create | `Dockerfile` |
| Create | `.dockerignore` |
| Create | `.github/workflows/release.yml` |
| Create | `backend/app/static.py` |
| Create | `backend/tests/test_static.py` |
| Modify | `backend/app/main.py` (import + `mount_static(app)` as the final statement) |
| Modify | `backend/pyproject.toml` (`license`, `[project.urls]`) |
| Modify | `backend/README.md` (`SQLADMIN_STATIC_DIR` note) |
| Modify | `frontend/package.json` (`description`, `license`, `author`, `repository`, `homepage`, `bugs`) |
| Modify | `docker-compose.yml` (`backend` → `app`; root build context; drop the frontend stub) |
| Modify | `README.md` (quick start, status framing, licensing section) |
| Delete | `backend/Dockerfile` |

---

## Expected Behaviour

### Unit-testable — `backend/tests/test_static.py`

1. **No directory, no routes.** With `SQLADMIN_STATIC_DIR` pointing at a non-existent path, `static_dir()` returns `None`; `mount_static` on a fresh `FastAPI()` adds no routes, and `GET /` returns 404.
2. **Directory without `index.html`.** A `tmp_path` that exists but holds no `index.html` behaves identically to case 1 — `static_dir()` returns `None`.
3. **Environment override wins.** With `SQLADMIN_STATIC_DIR` set to a `tmp_path` containing `index.html`, `static_dir()` returns that path (not `/srv/static`).
4. **Root serves the shell.** `GET /` returns 200 and the body of `index.html`.
5. **Deep path serves the shell.** `GET /some/deep/link` returns 200 and the body of `index.html`.
6. **Assets are served as themselves.** `GET /assets/app.js` returns 200 and the asset's bytes — not `index.html`.
7. **Unknown API path 404s.** `GET /api/nope` returns 404 with a JSON `{"detail": …}` body, not HTML.
8. **Real API routes still win.** Register `@app.get("/api/config")` on the fresh app *before* calling `mount_static`; `GET /api/config` returns that handler's body.
9. **Non-GET is untouched.** Register `@app.post("/api/login")` before `mount_static`; `POST /api/login` reaches it (the catch-all is `GET`-only).
10. **Shell is not cached.** The `GET /` response carries `Cache-Control: no-cache`.

### Manual — the running container

11. `docker run` with no `SQLADMIN_ALLOWED_HOSTS` serves the app, and every login attempt is rejected with "Host not allowed" (default-deny is preserved; the container is not usable until an allowlist is supplied).
12. The compose stack logs in against host `sqladmin-db`, database `sqladmin`, user `sqladmin`, password `sqladmin`, and the object navigator lists the seeded schemas (`customers`, `orders`, `sales`, `inventory`, `hr`, `analytics`).
13. A browser refresh at `http://localhost:8000/anything` re-serves the app rather than a JSON 404.
14. The running container holds `/srv/LICENSE.md` and `/srv/THIRD-PARTY-NOTICES.md`.

---

## Verification

Run in order. All seven must pass before [`release-v0-1-0.md`](release-v0-1-0.md) tags the release. Every check here runs against a locally built image — nothing in this plan is published.

1. **Backend suite:** `cd backend && poetry run pytest` — green, `test_static.py` included.
2. **Manifest checks:** `cd backend && poetry check` → `All set!`; `cd frontend && npm pkg get license` → `"PolyForm-Noncommercial-1.0.0"`; `npm pkg get private` → `true`.
3. **License text is verbatim:** `diff <(tail -n +3 LICENSE.md) <(tail -n +3 frontend/node_modules/@jimka/typescript-ui/LICENSE)` — no output.
4. **Notices are current and complete:** the generator is idempotent — `cp THIRD-PARTY-NOTICES.md /tmp/tpn.bak && python3 scripts/generate_third_party_notices.py && diff /tmp/tpn.bak THIRD-PARTY-NOTICES.md` produces no output. Then `grep -c UNKNOWN THIRD-PARTY-NOTICES.md` → 0.
5. **Image builds:** `docker build -t sqladmin:local .` from the repo root. Then confirm the frontend landed: `docker run --rm sqladmin:local ls /srv/static` shows `index.html` and `assets`.
6. **The container serves both halves:**

   ```bash
   docker run --rm -d --name sqladmin-smoke -p 8000:8000 sqladmin:local
   curl -sI  http://localhost:8000/            | head -1   # 200
   curl -s   http://localhost:8000/ | grep -c '<title>SQLAdmin</title>'   # 1
   curl -sI  http://localhost:8000/deep/link   | head -1   # 200 (SPA fallback)
   curl -s   http://localhost:8000/api/config              # {"presets":[],"allowUserPresets":true}
   curl -sI  http://localhost:8000/api/nope    | head -1   # 404
   docker rm -f sqladmin-smoke
   ```

7. **Compose stack against the seeded database:** `docker compose up -d --build`, then open `http://localhost:8000`, log in per Expected Behaviour case 12, expand a schema in the navigator, and open a table to confirm rows render. Refresh the page on a deep path to confirm case 13. Tear down with `docker compose down`.
Multi-arch manifest and anonymous-pull checks can only run after a tag exists; they are `## Verification` in [`release-v0-1-0.md`](release-v0-1-0.md).

---

## Documentation Impact

`README.md` gets four edits:

1. **Replace the "demo application … not yet intended for production use" note** with a **Status and intended use** section. It says plainly: SQLAdmin 0.1.0 is a working tool, published as source-available noncommercial software, built to exercise `@jimka/typescript-ui`. It is intended to run on a workstation or a trusted network against databases you control. It is not hardened for exposure to the public internet, and lists why: no TLS of its own (terminate it at a reverse proxy), a single-process session registry, and login rate limiting that counts per process only.[^framing]

2. **Rewrite "Quick start"** around the image. Two paths:

   ```bash
   # Demo stack — app plus a seeded Postgres.
   docker compose up -d
   # Open http://localhost:8000
   # Log in: host sqladmin-db, database sqladmin, user sqladmin, password sqladmin
   ```

   ```bash
   # Against your own Postgres running on the host machine.
   docker run --rm -p 8000:8000 \
     -e SQLADMIN_ALLOWED_HOSTS=host.docker.internal:5432 \
     --add-host=host.docker.internal:host-gateway \
     ghcr.io/jimka/sqladmin:0.1.0
   ```

   Both snippets must state the two things that otherwise cost a user an hour: `SQLADMIN_ALLOWED_HOSTS` is **default-deny**, so a bare `docker run` rejects every login; and `localhost` inside the container is the container, not the host machine — hence `--add-host`.

3. **Carry the configuration list added by `plans/harden-for-publication.md`** into the rewritten section rather than dropping it: `SQLADMIN_ALLOWED_HOSTS` (required, default-deny), `SQLADMIN_COOKIE_SECURE` (`auto` by default — the cookie is marked `Secure` only when the request arrived over https, so plain-http access on a LAN address works), `SQLADMIN_ENABLE_DOCS` (off by default), `FORWARDED_ALLOW_IPS` (set it to the reverse proxy's address), `SERVER_PRESETS`, and `ALLOW_USER_PRESETS`. Add `SQLADMIN_STATIC_DIR` (default `/srv/static`) to the same list.

4. **Add a Licensing section** at the end: PolyForm Noncommercial 1.0.0 (`LICENSE.md`), source-available and not OSI-approved, noncommercial use only; third-party attribution in `THIRD-PARTY-NOTICES.md`; and a note that `@jimka/typescript-ui` is published by the same author under the same license.

Move the existing host-run instructions (poetry, `npm run dev`) into the **Development** section, which already exists.

---

## Potential Challenges

- **The catch-all must be registered last.** Adding a new `@app.get` route below `mount_static(app)` in `main.py` silently makes it unreachable. Keep `mount_static(app)` the final statement, with the comment from step 10 explaining why.
- **`mount_static` runs at import.** `app.main` is imported by ~60 test modules. If `mount_static` raised on a missing directory instead of returning, the whole suite would break — hence the `index.html` presence gate rather than `StaticFiles`' own directory check.
- **`StaticFiles` raises on a missing directory.** `mount_static` only reaches the `app.mount("/assets", …)` line once `index.html` was found, and a Vite build always emits `index.html` alongside `assets/`. A test fixture must create both, or `mount_static` raises `RuntimeError` before registering anything.
- **`npm ci` needs a lockfile in the build context.** If `.dockerignore` grows a `*lock*` pattern the Node stage fails immediately. The `.dockerignore` in step 12 lists only directories for exactly this reason.
- **GHCR packages are private by default.** Step 21 is not optional; skipping it means `docker pull` fails for everyone but the author, with a misleading "not found" error.
- **The Dockerfile is only exercised at tag time.** The release workflow has no non-tag trigger, so a broken Dockerfile is discovered after an immutable tag exists. Verification step 5, which builds locally before any tag is pushed, is the guard.
- **QEMU still runs the Python stage for arm64.** If the arm64 build times out, the fix is to drop `linux/arm64` from `platforms` and re-tag as `v0.1.1` — not to move the Node stage back under emulation.

---

## Critical Files

- [`frontend/node_modules/@jimka/typescript-ui/LICENSE`](frontend/node_modules/@jimka/typescript-ui/LICENSE) — the verbatim PolyForm text to diff against; also confirms the sibling library is under the same license.
- [`frontend/node_modules/@jimka/typescript-ui/THIRD-PARTY-NOTICES.md`](frontend/node_modules/@jimka/typescript-ui/THIRD-PARTY-NOTICES.md) and [`LICENSE-FONTAWESOME.md`](frontend/node_modules/@jimka/typescript-ui/LICENSE-FONTAWESOME.md) — the notices structure to mirror, and the source of the Font Awesome / Manrope / elkjs texts to copy.
- [`backend/app/main.py:137-152`](backend/app/main.py#L137) — app construction and the sibling-module wiring pattern `mount_static` follows; the file's last line is where the call goes.
- [`backend/app/config.py:20-30`](backend/app/config.py#L20) — the environment-reading convention `static.py` mirrors.
- [`backend/app/errors.py:39-44`](backend/app/errors.py#L39) — `NotFound`, raised by the fallback's `api/` guard.
- [`backend/tests/test_config.py:1-30`](backend/tests/test_config.py#L1) — the httpx `ASGITransport` test shape `test_static.py` mirrors.
- [`backend/Dockerfile`](backend/Dockerfile#L1) — the Python stage carried into the root Dockerfile before deletion.
- [`docker-compose.yml`](docker-compose.yml#L1) — the allowlist and presets comments to carry over.
- [`frontend/vite.config.ts`](frontend/vite.config.ts#L1) — confirms the frontend calls relative `/api/…`, which is what makes same-origin serving work without a frontend change.
- `/home/jika/typescript/typescript-ui/plans/implemented/publish-0-1-0.md` — the sibling project's release plan; the source of the `v0.1.0` tag convention and the "public access ≠ open source" framing.

---

## Non-Goals

- **Publishing the frontend to npm.** It stays `private: true` — it is an application, not a library.
- **Docker Hub.** GHCR only; the `jimka` name is taken on Docker Hub.
- **A CI job that builds the image on pull requests.** The release workflow is tag-triggered only.
- **Performing the release.** Tagging, pushing, and flipping GHCR visibility to public are irreversible and belong to [`release-v0-1-0.md`](release-v0-1-0.md). This plan must not push a tag.
- **Updating the stale symlink comments** in `frontend/vite.config.ts:3` and `.claude/skills/verify/SKILL.md`. Both describe the removed `npm link` arrangement and are now wrong, but neither is touched by this plan.
- **A CHANGELOG or release-notes automation.** The git tag is the release marker, matching the sibling project.

---

## Addendum: Security posture of a publicly pullable image

Everything below was present in the code when this plan was written. Publishing an image changes who runs it and where.

**Fixed by `plans/harden-for-publication.md`, which runs before this plan:**

- **The session cookie was unconditionally `Secure`** ([`auth.py:193-200`](backend/app/auth.py#L193)), so a browser silently discarded it on any origin other than `http://localhost` — a successful login followed by 401s on everything. The flag is now derived per request (`SQLADMIN_COOKIE_SECURE`, default `auto`), so plain-http access on a LAN address works. `## Documentation Impact` item 3 documents the setting rather than the caveat.
- **No rate limiting on `POST /api/login`.** Now an in-process sliding window in `backend/app/rate_limit.py`: more than 10 failed attempts from one client address within 5 minutes returns 429 with `Retry-After`.
- **CORS allowed `localhost:5173` and `localhost:8015` with credentials** ([`main.py:95, 139-145`](backend/app/main.py#L139)). The middleware is deleted; the Vite dev proxy already made the dev loop same-origin.
- **`/docs`, `/redoc`, and `/openapi.json` were enabled** by FastAPI's defaults. Now off unless `SQLADMIN_ENABLE_DOCS` opts them back in.
- **The container ran as root.** The Python stage carried into this plan's root `Dockerfile` (step 13) now creates and switches to the unprivileged `sqladmin` user.
- **Proxy-header trust was undocumented.** `uvicorn` enables `--proxy-headers` by default but trusts only `127.0.0.1`; the operator now sets `FORWARDED_ALLOW_IPS` to the reverse proxy's address, which is what makes both the cookie's `auto` mode and the rate limiter's client key correct. TLS termination is still the proxy's job — the container speaks plain http on `0.0.0.0:8000`.

**Accepted as-is:**

- **`GET /api/config` is unauthenticated by design** ([`config.py:103-115`](backend/app/config.py#L103)). It carries no credentials, but it does disclose the configured host, port, and database names to anyone who can reach the port. The login screen needs it before a session exists; an operator who objects leaves `SERVER_PRESETS` unset.
- **Arbitrary SQL execution is the product**, via `POST /api/{cid}/query` and `/api/{cid}/ddl/execute`. The Postgres role's own grants are the only authorization boundary — which is the design, and worth stating in the README so operators pick roles accordingly.

**Not a risk — checked and clear:**

- **No licensing tension in bundling the frontend.** `@jimka/typescript-ui@0.1.0` declares `"license": "PolyForm-Noncommercial-1.0.0"` in its published `package.json` and ships that license text. Same license, same copyright holder, so bundling it into a PolyForm-Noncommercial image is consistent. The obligations that *do* flow through are attribution ones from assets the library itself bundles — Font Awesome (CC BY 4.0), Manrope (OFL 1.1), and elkjs (EPL-2.0) — all discharged by Section 1 of `THIRD-PARTY-NOTICES.md` shipping inside the image.

---

## Implementation Notes

- **`curl -sI` in Verification step 6 returns 405, not 200.** `curl -I` sends a
  `HEAD` request, and FastAPI's `@app.get(...)` decorator does not
  auto-register `HEAD` the way plain Starlette routes do — confirmed by
  inspecting `app.routes` directly: only FastAPI's own `/docs`/`/openapi.json`
  routes carry `{'GET', 'HEAD'}`, every `@app.get` route in this codebase,
  including the new catch-all, carries only `{'GET'}`. This is not a defect
  introduced by `mount_static`: no route anywhere in the app supports `HEAD`,
  and nothing in `## Expected Behaviour` (or a browser navigating the page)
  ever issues one. The equivalent `GET` checks
  (`curl -s -o /dev/null -w '%{http_code}'`) against the locally built image
  all returned the documented codes: `/` → 200 with the title present,
  `/deep/link` → 200 (SPA fallback), `/api/config` → 200 JSON, `/api/nope` →
  404 with `{"detail": "No such API route: /api/nope"}`. Adding `HEAD`
  support to only the new catch-all, to satisfy the letter of one `curl`
  invocation, would be an unplanned, inconsistent special case — out of scope
  here.

- **Step 6's Section 1 list was incomplete; two more pass-through notices were
  added.** The plan named three Section 1 entries (Font Awesome, Manrope,
  elkjs), but its own cited Critical File —
  `frontend/node_modules/@jimka/typescript-ui/THIRD-PARTY-NOTICES.md` — states
  that d3 is inlined into the library's `dist/lib/component/chart.es.js`
  (lines 133–136 there), which is the same "embedded, not merely installed"
  category as the three named entries, since SQLAdmin's own Vite build then
  bundles that inlined code into `frontend/dist`. The same reasoning applies
  to the library's `dependencies` — CodeMirror, Lexical, `marked`, `prettier`,
  `sql-formatter` — which the library's own notices describe as *not* bundled
  (each ships its own license text in the consumer's `node_modules`), but
  which are true for an npm package's consumers, not for SQLAdmin: Vite
  bundles anything imported into `frontend/dist`, so these are embedded here
  too. Added both to `THIRD-PARTY-NOTICES.md` Section 1, each with the license
  text its terms require verbatim (ISC for d3, MIT for the second group),
  copied from the same precedent file. Also reworded the file's preamble and
  the Section 2/3 headers, which originally said runtime dependencies are
  "installed separately... rather than embedded into the shipped artifact" —
  true of an npm *package*'s consumers, false for a Docker *image*, where the
  entire npm production tree ends up bundled into `frontend/dist` and the
  entire Python main group is installed into the image. Section 2/3 are now
  framed as the complete inventory (deliberately overlapping Section 1's
  fuller entries), not a "not bundled" claim.

## Notes

[^same-license]: The installed package at `frontend/node_modules/@jimka/typescript-ui/package.json` declares `"license": "PolyForm-Noncommercial-1.0.0"` and ships `LICENSE`, `LICENSE-FONTAWESOME.md`, and `THIRD-PARTY-NOTICES.md`. That installed copy — not the source checkout at `/home/jika/typescript/typescript-ui` — is the authoritative artifact, because it is what `npm ci` fetches and what `vite build` bundles into `frontend/dist` and therefore into the image. The source checkout may run ahead of the published tarball, so citing it could describe a license that no consumer actually receives.

[^spdx-form]: `PolyForm-Noncommercial-1.0.0` is a real SPDX license-list identifier, so the `LicenseRef-` prefix (which exists for licenses *absent* from the list) is unnecessary. The published `@jimka/typescript-ui` manifest uses the bare form; using the same string in both repos keeps automated license scanners reporting one identifier rather than two. On the Python side, PEP 639 replaced the older `license = { text = … }` / `{ file = … }` tables with a plain SPDX expression string. Both forms were tested against this repo's poetry 2.1.1 / poetry-core 2.x: `license = "PolyForm-Noncommercial-1.0.0"` with `[project.urls]` placed after `dependencies` passes `poetry check` ("All set!") and builds an sdist cleanly. `license-files` is omitted because PEP 639 requires the referenced path to sit inside the project directory, and `LICENSE.md` is one level above `backend/`.

[^multiarch]: A naive `--platform linux/amd64,linux/arm64` build runs *both* stages under QEMU for the arm64 variant. The Node stage is the expensive one — `npm ci` over ~70 packages plus `tsc --noEmit` and a Vite build that transforms 418 modules in about 10 seconds natively, and roughly an order of magnitude slower emulated. `FROM --platform=$BUILDPLATFORM` on that stage removes the cost entirely: the JS bundle is architecture-independent, so building it once on the runner's native amd64 and copying the output into both variants is correct as well as fast. The remaining emulated work is `pip install poetry` plus `poetry install --only main`, and every wheel involved (`asyncpg`, `uvloop`, `httptools`, `pydantic-core`, `watchfiles`, `PyYAML`) publishes `aarch64` manylinux builds, so nothing compiles from source.

[^generator]: Three approaches were considered. A hand-curated list (what the sibling library does) drifts silently — nothing fails when a transitive dependency changes. A dedicated tool (`license-checker` for npm, `pip-licenses` for Python) means two new dev dependencies and, for npm, an unmaintained package. The chosen approach uses what is already installed: `npm query ":not(.dev)"` returns the whole production tree with a `license` field per entry, and `poetry -C backend show --only main` plus `importlib.metadata` covers the Python side. Both were run against this repo during planning: 71 npm packages and 21 Python packages, zero unresolved licenses. Marker-delimited blocks are what let a generator coexist with the hand-written bundled-asset notices, which no tool can produce because they require reading the upstream license texts.

[^no-ci-notices]: Checking the notices file in CI would mean installing Node, npm, Python, and poetry in a workflow whose only other job is `docker build`, roughly doubling its setup for a file that changes when dependencies change. The release is already a deliberate, manual `git tag`, so a manual regenerate-and-diff immediately before it (step 1 of [`release-v0-1-0.md`](release-v0-1-0.md)) catches the same drift at the same moment.

[^framing]: The current README note — "a demo application … not yet intended for production use" — was accurate when running SQLAdmin required cloning the repo, installing poetry, and starting two dev servers. A pullable image removes every one of those filters, so the note stops being a barrier and becomes a disclaimer nobody acts on. Replacing it with concrete limits (no TLS of its own, single process, per-process rate limiting) tells an operator what to actually check before pointing it at a database, which a blanket "not for production" does not. The `@jimka/typescript-ui` showcase framing stays, but as provenance rather than as a warning.
