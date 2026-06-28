# SQLAdmin backend

FastAPI + asyncpg API for the SQLAdmin demo. Thin, stateless-per-request, CQRS
`Query`/`Command` operation handlers over a `connectionId -> asyncpg.Pool`
registry.

## Run locally

```bash
poetry install
DATABASE_URL=postgresql://sqladmin:sqladmin@localhost:5432/sqladmin \
  poetry run uvicorn app.main:app --reload --port 8000
```

(Bring the database up first from the repo root: `docker compose up -d db`.)

## Test

```bash
poetry run pytest
```

## Layout

- `app/main.py` — FastAPI app, lifespan (pool open/close), exception handler, routes
- `app/operations/` — CQRS `Query`/`Command` handlers (introspection + rows)
- `app/sql/compiler.py` — pure `FilterCompiler`/`OrderCompiler` + `quote_ident`
- `app/wire.py` — Postgres/asyncpg -> wire-contract value mapping
- `app/connections.py` — pool registry; `app/errors.py` — exception taxonomy
