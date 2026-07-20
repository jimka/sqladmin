# SQLAdmin

A web-based PostgreSQL admin client. Browse schemas and tables, edit rows, run
ad-hoc SQL, and visualize your schema and roles as interactive diagrams —
authenticating directly against the target database with its own credentials.

There is no application user store: you log in as a Postgres role, and what you
can see and do is exactly what that role is granted. The backend holds no
connection until you sign in, and drops it when your session ends.

## Status and intended use

SQLAdmin 0.1.0 is a working tool, published as source-available noncommercial
software, built to exercise `@jimka/typescript-ui`. It is intended to run on
a workstation or a trusted network against databases you control.

It is not hardened for exposure to the public internet:

- No TLS of its own — terminate it at a reverse proxy.
- A single-process session registry — do not run multiple replicas behind a
  load balancer.
- Login rate limiting counts failed attempts per process, not globally.

## Highlights

- **Object navigator** — walk databases, schemas, tables, and views; open a
  table to browse its rows.
- **Data grid** — filter, sort, and page through table data; insert, update, and
  delete rows (write actions are gated on the connected role's privileges).
- **SQL workspace** — run ad-hoc queries, `EXPLAIN` a statement, and save
  queries for reuse. Export query and table results to CSV or JSON.
- **Structure & definitions** — inspect columns, view a view's definition, and
  read a table's `GRANT`s.
- **Diagrams** — schema-overview, per-schema, relation, and role
  grant/membership diagrams, laid out automatically with [elkjs](https://github.com/kieler/elkjs).
- **Roles explorer** — browse roles, their memberships, and their grants.
- **Session-based auth** — per-login asyncpg pools behind an opaque session
  cookie, a default-deny host allowlist, and CSRF-guarded mutations.

## Architecture

| Layer | Stack |
|-------|-------|
| Frontend | TypeScript + [Vite](https://vitejs.dev/), built on the `@jimka/typescript-ui` component library |
| Backend  | [FastAPI](https://fastapi.tiangolo.com/) + [asyncpg](https://github.com/MagicStack/asyncpg), CQRS `Query`/`Command` handlers over per-session connection pools |
| Database | PostgreSQL 16 |

The backend is thin and stateless-per-request: each request resolves its
connection pool from a server-side session cookie, applies a single operation
handler, and maps the result to a wire contract. Authorization is the Postgres
role's own grants — there is no app-level user table.

See [`backend/README.md`](backend/README.md) for backend internals and
[`LIBRARY_NOTES.md`](LIBRARY_NOTES.md) for notes on the UI library.

## Quick start

Both ways need `SQLADMIN_ALLOWED_HOSTS`: it is **default-deny**, so an
allowlist that names no targets rejects every login attempt.

Point the published image at a database you already run — nothing to clone:

```bash
# Against your own Postgres running on the host machine.
docker run --rm -p 8000:8000 \
  -e SQLADMIN_ALLOWED_HOSTS=host.docker.internal:5432 \
  --add-host=host.docker.internal:host-gateway \
  ghcr.io/jimka/sqladmin:0.1.0
# Open http://localhost:8000
```

Both flags are needed together: inside the container `localhost` is the
container itself, not the host machine, so the target is
`host.docker.internal` — and `--add-host` is what makes that name resolve
(on Linux; Docker Desktop on macOS/Windows resolves it without the flag).

Or try the demo stack — the app plus a seeded Postgres, with the allowlist
and a login preset already wired up. This one needs the repository cloned,
for `docker-compose.yml` and the seed scripts:

```bash
docker compose up -d
# Open http://localhost:8000
# Log in: host sqladmin-db, database sqladmin, user sqladmin, password sqladmin
```

Compose declares both `build` and `image`, so `docker compose up` builds the
image from this tree when it isn't already in the local cache. To run the
published image instead of building it, `docker compose pull` first.

### Configuration

The backend is driven by environment variables:

- `SQLADMIN_ALLOWED_HOSTS` — comma-separated `host` / `host:port` allowlist of
  targets the backend may dial. **Required**: an unset allowlist rejects every
  login (default-deny).
- `SQLADMIN_COOKIE_SECURE` — `auto` (default), `true`, or `false`. Under `auto`,
  the session cookie is marked `Secure` when the request arrived over https.
  This is what makes reaching SQLAdmin over plain http on a LAN address work,
  where before the cookie was silently dropped by the browser.
- `SQLADMIN_ENABLE_DOCS` — off by default; set truthy to expose `/docs`,
  `/redoc`, and `/openapi.json`, which publish the whole API surface without
  authentication.
- `FORWARDED_ALLOW_IPS` — uvicorn's own variable, defaulting to `127.0.0.1`.
  Behind a reverse proxy, set it to the proxy's address so SQLAdmin sees the
  real scheme and the real client address. A proxy at any other address is
  not trusted until you do: its `X-Forwarded-*` headers are ignored, so the
  session cookie stays unmarked even when the browser is on https, and every
  client shares one login rate-limit bucket keyed on the proxy's address.
  Running SQLAdmin in a container puts it on its own network, so a proxy on
  the host does not reach it from `127.0.0.1` and the default does not
  cover it.
- `SERVER_PRESETS` — JSON array of `{name, host, port, database}` connection
  presets offered on the login screen (never credentials).
- `ALLOW_USER_PRESETS` — set falsy to hide the "save your own preset" UI and
  suppress browser-local presets.
- `SQLADMIN_STATIC_DIR` — directory holding the built frontend
  (`index.html` + `assets/`), default `/srv/static`. The published image sets
  this up already; it exists as an override for a custom image layout.

**Login rate limiting.** More than 10 failed logins from one address within 5
minutes returns 429 with `Retry-After`. The limits are fixed, and the counter
is per process — it does not protect a multi-replica deployment.

## Development

Bring up just the database (seeded with a multi-schema demo — customers,
orders, sales, inventory, hr, analytics — plus views and a materialized
view):

```bash
docker compose up -d db
```

Run the backend on the host:

```bash
cd backend
poetry install
SQLADMIN_ALLOWED_HOSTS=localhost:5432 \
  poetry run uvicorn app.main:app --reload --port 8000
```

Run the frontend on the host:

```bash
cd frontend
npm install
npm run dev
```

Open the printed Vite URL and log in against `localhost:5432` /
database `sqladmin` (the seed's superuser is `sqladmin` / `sqladmin`).

```bash
# Backend tests
cd backend && poetry run pytest

# Frontend type-check and unit tests
cd frontend && npm run typecheck && npm test
```

Deferred features, known issues, and the backlog live in [`TODO.md`](TODO.md);
in-flight designs live in [`plans/`](plans/).

## Licensing

SQLAdmin is licensed under the [PolyForm Noncommercial License
1.0.0](LICENSE.md) — source-available, not OSI-approved, noncommercial use
only. Third-party attribution is in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). `@jimka/typescript-ui`, the
component library SQLAdmin is built to showcase, is published by the same
author under the same license.
