# SQLAdmin

A web-based PostgreSQL admin client. Browse schemas and tables, edit rows, run
ad-hoc SQL, and visualize your schema and roles as interactive diagrams —
authenticating directly against the target database with its own credentials.

There is no application user store: you log in as a Postgres role, and what you
can see and do is exactly what that role is granted. The backend holds no
connection until you sign in, and drops it when your session ends.

> **Note:** SQLAdmin is currently a demo application for the
> `@jimka/typescript-ui` component library — it exists to exercise and showcase
> that library in a real-world app, and is not yet intended for production use.

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

Bring up the database (seeded with a multi-schema demo — customers, orders,
sales, inventory, hr, analytics — plus views and a materialized view):

```bash
docker compose up -d db
```

Run the backend:

```bash
cd backend
poetry install
SQLADMIN_ALLOWED_HOSTS=localhost:5432 \
  poetry run uvicorn app.main:app --reload --port 8000
```

Run the frontend (the dev loop links `@jimka/typescript-ui` from a sibling
checkout, so the frontend runs on the host rather than in a container):

```bash
cd frontend
npm install
npm run dev
```

Open the printed Vite URL and log in against `localhost:5432` /
database `sqladmin` (the seed's superuser is `sqladmin` / `sqladmin`).

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
- `FORWARDED_ALLOW_IPS` — uvicorn's own variable. Behind a reverse proxy, set
  it to the proxy's address so SQLAdmin sees the real scheme and the real
  client address. Left unset, the session cookie is never marked `Secure`
  even when the browser is on https, and every client shares one login
  rate-limit bucket.
- `SERVER_PRESETS` — JSON array of `{name, host, port, database}` connection
  presets offered on the login screen (never credentials).
- `ALLOW_USER_PRESETS` — set falsy to hide the "save your own preset" UI and
  suppress browser-local presets.

**Reaching a database on the Docker host.** Inside the container, `localhost`
is the container. Use `host.docker.internal`, and on Linux add
`--add-host=host.docker.internal:host-gateway`:

```bash
docker run --rm -p 8000:8000 \
  -e SQLADMIN_ALLOWED_HOSTS=host.docker.internal:5432 \
  --add-host=host.docker.internal:host-gateway \
  <image>
```

**Login rate limiting.** More than 10 failed logins from one address within 5
minutes returns 429 with `Retry-After`. The limits are fixed, and the counter
is per process — it does not protect a multi-replica deployment.

## Development

```bash
# Backend tests
cd backend && poetry run pytest

# Frontend type-check and unit tests
cd frontend && npm run typecheck && npm test
```

Deferred features, known issues, and the backlog live in [`TODO.md`](TODO.md);
in-flight designs live in [`plans/`](plans/).
