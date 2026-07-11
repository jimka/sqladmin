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
  targets the backend may dial. **Default-deny**: an unset allowlist rejects
  every login.
- `SERVER_PRESETS` — JSON array of `{name, host, port, database}` connection
  presets offered on the login screen (never credentials).
- `ALLOW_USER_PRESETS` — set falsy to hide the "save your own preset" UI and
  suppress browser-local presets.

## Development

```bash
# Backend tests
cd backend && poetry run pytest

# Frontend type-check and unit tests
cd frontend && npm run typecheck && npm test
```

Deferred features, known issues, and the backlog live in [`TODO.md`](TODO.md);
in-flight designs live in [`plans/`](plans/).
