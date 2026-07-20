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
- `ALLOW_USER_PRESETS` — `false`/`0`/`no` hides the "save your own preset" UI and
  suppresses browser-local presets (default: on).

(Bring the database up first from the repo root: `docker compose up -d db`.)

## Test

```bash
poetry run pytest
```

## Layout

- `app/main.py` — FastAPI app, lifespan (idle-session sweep), exception handler, routes
- `app/auth.py` — login/logout/whoami, the host allowlist, session + CSRF dependencies
- `app/config.py` — `SERVER_PRESETS` / `ALLOW_USER_PRESETS` + the pre-auth `GET /api/config`
- `app/operations/` — CQRS `Query`/`Command` handlers (introspection + rows)
- `app/sql/compiler.py` — pure `FilterCompiler`/`OrderCompiler` + `quote_ident`
- `app/wire.py` — Postgres/asyncpg -> wire-contract value mapping
- `app/connections.py` — per-session pool store; `app/errors.py` — exception taxonomy
- `app/rate_limit.py` — in-process sliding-window rate limit on failed logins
