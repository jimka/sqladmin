# SQLAdmin backend

FastAPI + asyncpg API for the SQLAdmin demo. Thin, stateless-per-request, CQRS
`Query`/`Command` operation handlers over **per-session** asyncpg pools: a user
authenticates against the target Postgres server (a login opens a pool for the
supplied credentials), and each request resolves its pool from an opaque
server-side session cookie. The app boots with **no** pools — they exist only for
the lifetime of a logged-in session. Authorization is the Postgres role's own
grants; there is no app-level user store.

## Run locally

```bash
poetry install
SQLADMIN_ALLOWED_HOSTS=localhost:5432 \
  poetry run uvicorn app.main:app --reload --port 8000
```

`SQLADMIN_ALLOWED_HOSTS` is a comma-separated allowlist of `host` / `host:port`
targets the backend may dial (default-deny — an unset allowlist rejects every
login). Optional:

- `SQLADMIN_COOKIE_SECURE` — `auto` (default), `true`, or `false`. See the
  root [`README.md`](../README.md#configuration) for the reverse-proxy
  explanation.
- `SQLADMIN_ENABLE_DOCS` — off by default; set truthy to expose `/docs`,
  `/redoc`, and `/openapi.json`.
- `FORWARDED_ALLOW_IPS` — uvicorn's own variable; see the root
  [`README.md`](../README.md#configuration) for what it's for.
- `SERVER_PRESETS` — a JSON array of `{name, host, port, database}` connection
  presets offered on the login screen (never credentials), e.g.
  `SERVER_PRESETS='[{"name":"Local","host":"localhost","port":5432,"database":"sqladmin"}]'`.
- `ALLOW_USER_PRESETS` — on by default; `false`/`0`/`no`/`off` hides the "save
  your own preset" UI and suppresses browser-local presets. See the root
  [`README.md`](../README.md#configuration) for the flag spellings every
  boolean variable accepts.

(Bring the database up first from the repo root: `docker compose up -d db`.)

`SQLADMIN_STATIC_DIR` (default `/srv/static`) makes the backend also serve a
built frontend: if that directory holds an `index.html`, the app mounts it
and falls back to it for any non-API path. Running locally as above, the
directory is absent, so the backend serves the API only — the Vite dev
server (`npm run dev`) is what serves the frontend during development.

## Test

```bash
poetry run pytest
```

## Layout

Authenticated routes are namespaced `/api/{connection_id}/...`, and every
database-scoped route sits under `/api/{connection_id}/db/{database}/...` —
the literal `db` keeps a database name out of the same path position as a
literal segment like `roles`.

- `app/main.py` — FastAPI app, lifespan (idle-session sweep), exception handlers, router wiring
- `app/endpoints/` — one `APIRouter` per resource (`databases`, `schemas`, `tables`, `rows`, `export`, `roles`, `query`, `ddl`); `common.py` holds the two route prefixes
- `app/auth.py` — login/logout/whoami, the host allowlist, session + CSRF dependencies
- `app/config.py` — `SERVER_PRESETS` / `ALLOW_USER_PRESETS` + the pre-auth `GET /api/config`
- `app/contract.py` — the wire contract's scalar types and shared value objects
- `app/operations/` — CQRS `Query`/`Command` handlers (introspection + rows); `base.py`'s
  `CatalogQuery` and `catalog.py`'s shared SQL fragments/mappers back the catalog reads
- `app/sql/compiler.py` — pure `FilterCompiler`/`OrderCompiler` + `quote_ident`
- `app/sql/ddl.py` — pure DDL SQL-builder primitives shared by every DDL phase
- `app/wire.py` — Postgres/asyncpg -> wire-contract value mapping
- `app/export_format.py` — the CSV/JSON export dialect + the export format registry
- `app/connections.py` — per-session pool store; `app/errors.py` — exception taxonomy
- `app/rate_limit.py` — in-process sliding-window rate limit on failed logins
- `app/static.py` — serves the built frontend alongside the API from one container
- `app/dev.py` — the `poetry run dev` launcher entry point
