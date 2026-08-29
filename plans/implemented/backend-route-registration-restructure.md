---
depends-on: [backend-security-config-hardening]
touches-shared:
  - backend/app/main.py
  - backend/app/errors.py
  - backend/app/endpoints/
  - frontend/src/data/api.ts
  - frontend/src/data/stores.ts
---

# Backend route registration restructure — Implementation Plan

## Overview

[`backend/app/main.py`](backend/app/main.py) is 1,616 lines, and 54 of the 58 routes it registers live in it directly. 24 of those are byte-identical apart from one class name: `op = OP(c, body); await op.apply(); return op.get_result()` ([`main.py:961-1548`](backend/app/main.py#L961)). This plan moves every route into a per-resource `APIRouter` under a new `backend/app/endpoints/` package, replaces the 24 preview routes with one declared `{path suffix: preview op class}` table plus a registration loop, and leaves `main.py` as app assembly only — lifespan, the two exception handlers, the four auth/config routes, the router includes, and the static mount.

The move carries a live bug fix. FastAPI matches routes in registration order, whichever file declares them, and two of today's route templates can claim the same concrete URL: `GET /api/default/roles/schemas` matches [`main.py:254`](backend/app/main.py#L254)'s schemas route with `database="roles"` instead of [`main.py:653`](backend/app/main.py#L653)'s role-detail route with `role="schemas"`. A Postgres role named `schemas` or `graph` is unreachable. Splitting the routes across files without changing the URLs reproduces that ambiguity, so this plan also moves every database-scoped route behind a literal `db` segment — `/api/{connection_id}/db/{database}/...`. On the backend that is one line, because each router declares its prefix once; on the frontend it is a one-segment insertion in 45 URL builders.

Alongside those, the driver-error handler at [`main.py:177-185`](backend/app/main.py#L177) stops hardcoding its own statuses and translates into the typed taxonomy instead, which makes [`errors.ConflictError`](backend/app/errors.py#L49) — dead today — the one place 409 is decided.

---

## Architecture Decisions

### Routes live in per-resource `APIRouter`s under `backend/app/endpoints/`

Eight route modules, one `APIRouter` each, aggregated by `endpoints/__init__.py` into a `ROUTERS` tuple that `main.py` loops over. `APIRouter` is new to this repo; the package *shape* is not — it copies `backend/app/operations/`, which already pairs one module per concern with an `__init__.py` aggregator ([`operations/__init__.py:1-4`](backend/app/operations/__init__.py#L1)) and a `common.py` for what several modules share.[^why-routers]

| File | Router prefix | Routes |
|---|---|---|
| `endpoints/databases.py` | `CONNECTION_PREFIX` | 1 |
| `endpoints/roles.py` | `CONNECTION_PREFIX` | 2 |
| `endpoints/query.py` | `CONNECTION_PREFIX` | 3 |
| `endpoints/schemas.py` | `DATABASE_PREFIX` | 9 |
| `endpoints/tables.py` | `DATABASE_PREFIX` | 6 |
| `endpoints/rows.py` | `DATABASE_PREFIX` | 6 |
| `endpoints/export.py` | `DATABASE_PREFIX` | 1 |
| `endpoints/ddl.py` | `DATABASE_PREFIX + "/ddl"` | 26 |

`POST /api/{connection_id}/ddl/execute` stays connection-scoped and lives in `query.py`, beside the other two routes that take a SQL string in the body and run it.[^execute-home]

### Every database-scoped route moves behind a literal `db` segment

`endpoints/common.py` declares the two prefixes every router is built on, and they are the whole URL change:

```python
CONNECTION_PREFIX = "/api/{connection_id}"
DATABASE_PREFIX = "/api/{connection_id}/db/{database}"
```

| Before | After |
|---|---|
| `GET /api/default/sqladmin/schemas` | `GET /api/default/db/sqladmin/schemas` |
| `GET /api/default/sqladmin/public/orders/rows` | `GET /api/default/db/sqladmin/public/orders/rows` |
| `POST /api/default/sqladmin/ddl/create-view` | `POST /api/default/db/sqladmin/ddl/create-view` |
| `GET /api/default/roles/alice` | `GET /api/default/roles/alice` — unchanged |
| `POST /api/default/query` | `POST /api/default/query` — unchanged |

Connection-scoped routes (`/databases`, `/roles`, `/roles/{role}`, `/query`, `/explain`, `/ddl/execute`) and the four auth/config routes keep today's URLs.

### No two routes may claim the same concrete path, and a test proves it

Two route templates are **ambiguous** when they carry the same HTTP method and the same number of segments, and at every position either both hold the same literal or at least one holds a parameter. An ambiguous pair means one concrete URL that both templates match, with registration order silently deciding which wins. `backend/tests/test_routes.py` asserts the app has zero such pairs.[^ambiguity-rule]

| Method | Route A | Route B | Verdict |
|---|---|---|---|
| GET | `/api/{connection_id}/{database}/schemas` | `/api/{connection_id}/roles/{role}` | **ambiguous** — both match `/api/default/roles/schemas` (today's bug) |
| GET | `/api/{connection_id}/db/{database}/schemas` | `/api/{connection_id}/roles/{role}` | safe — 5 segments vs 4 |
| GET | `/api/{connection_id}/databases` | `/api/{connection_id}/roles` | safe — position 3 holds two different literals |
| POST | `/api/{connection_id}/db/{database}/ddl/table/create` | `/api/{connection_id}/db/{database}/{schema}/{table}/rows` | safe — position 7 holds `create` vs `rows` |

The property that makes the fixed table pass is that the segment after `{connection_id}` is **always** a literal: `databases`, `roles`, `query`, `explain`, `ddl`, or `db`. `{database}` only ever appears one segment deeper.

### The 24 DDL-preview routes are registered from one declared table

`endpoints/ddl.py` holds `PREVIEW_OPS: dict[str, type[DdlPreview]]` mapping a path suffix to the op class the route constructs, and one loop that registers a route per entry. Adding a preview phase becomes one line there plus the op class itself. The precedent is [`list_objects.py:20-39`](backend/app/operations/list_objects.py#L20)'s `_OBJECT_SELECTS`, whose own comment states the same rationale: a new kind is "a distinct, additive line rather than an edit to one shared string".[^registry-not-decorators]

Each route's OpenAPI summary and description come from the op class's own docstring, which already carries both — no per-route text is written twice.

| `PREVIEW_OPS` entry | Registered path | Route name |
|---|---|---|
| `"table/create": PreviewCreateTable` | `POST /api/{connection_id}/db/{database}/ddl/table/create` | `preview_table_create` |
| `"create-view": CreateViewPreview` | `POST /api/{connection_id}/db/{database}/ddl/create-view` | `preview_create_view` |
| `"alter-type-add-value": AlterTypeAddValuePreview` | `POST /api/{connection_id}/db/{database}/ddl/alter-type-add-value` | `preview_alter_type_add_value` |

### The driver-error handler translates into the taxonomy, so `ConflictError` becomes live

`_pg_error_handler` stops building its own `JSONResponse` with hardcoded status numbers. It converts the driver error into a `ConflictError` (integrity/unique violation) or a new `BadRequest` (everything else) and hands that to `_domain_error_handler`. `errors.py` becomes the single table deciding which status an error carries, which is what its own module docstring already claims.[^conflict-live]

| Driver exception | `DomainError` built | Status | Body |
|---|---|---|---|
| `asyncpg.UniqueViolationError` | `ConflictError(str(exc))` | 409 | `{"detail": str(exc)}` |
| `asyncpg.ForeignKeyViolationError` | `ConflictError(str(exc))` | 409 | `{"detail": str(exc)}` |
| `asyncpg.PostgresSyntaxError` | `BadRequest(str(exc))` | 400 | `{"detail": str(exc)}` |

Statuses and bodies are byte-identical to today's; only which code decides them changes.

---

## Public API

### `backend/app/endpoints/common.py` (new)

```python
CONNECTION_PREFIX: str   # "/api/{connection_id}"
DATABASE_PREFIX: str     # "/api/{connection_id}/db/{database}"

# Introspect a table's columns; raises NotFound when it has none.
async def columns_for(conn: asyncpg.Connection, table: TableRef) -> list[ColumnMeta]: ...
```

`columns_for` is [`main.py:212-229`](backend/app/main.py#L212)'s `_columns_for` moved verbatim and made non-private (it now has two importers, `rows.py` and `export.py`).

### `backend/app/endpoints/ddl.py` (new)

```python
# {path suffix: preview op class} — see Architecture Decisions.
PREVIEW_OPS: dict[str, type[DdlPreview]]

# Split a preview op's docstring into the route's OpenAPI (summary, description).
def preview_docs(op_class: type[DdlPreview]) -> tuple[str, str]: ...
```

### `backend/app/endpoints/__init__.py` (new)

```python
ROUTERS: tuple[APIRouter, ...]
```

Each of the eight route modules exports one module-level `router: APIRouter`.

### `backend/app/errors.py`

```python
class BadRequest(DomainError):
    """
    The server rejected the request and it is not a conflict — the status the
    driver-error handler in ``main.py`` gives every non-integrity Postgres error.
    """

    status_code: int = 400
```

### `backend/app/main.py`

`_columns_for`, `_parse_json_array`, `_DEFAULT_PAGE_SIZE`, and all 54 route functions are removed. `app`, `lifespan`, `_sweep_loop`, `_domain_error_handler`, and `_pg_error_handler` stay.

### Frontend

No exported signature changes. `frontend/src/data/api.ts`'s 44 database-scoped URL builders and `frontend/src/data/stores.ts`'s row-collection URL each gain one path segment.

---

## Internal Structure

### `backend/app/endpoints/common.py`

```python
"""
Helpers shared by the endpoint modules: the two route prefixes every router is
built on, and the column introspection the row and export routes both need.
"""

# Prefix for every route scoped to a connection but not to one database. The
# segment right after {connection_id} is ALWAYS a literal — `databases`,
# `roles`, `query`, `explain`, `ddl`, `db` — never a name read out of Postgres.
CONNECTION_PREFIX = "/api/{connection_id}"

# Prefix for every route scoped to one database inside a connection. The literal
# `db` is what keeps the rule above true. Without it {database} would sit in the
# same position as the literal `roles`, so `/api/default/roles/schemas` matched
# the schemas route with database="roles" instead of the role-detail route with
# role="schemas", making a role actually named `schemas` or `graph` unreachable.
DATABASE_PREFIX = "/api/{connection_id}/db/{database}"
```

### `backend/app/endpoints/ddl.py` — the registry and its loop

```python
router = APIRouter(prefix=DATABASE_PREFIX + "/ddl", tags=["ddl"])

PREVIEW_OPS: dict[str, type[DdlPreview]] = {
    # Table DDL
    "table/create": PreviewCreateTable,
    "table/drop": PreviewDropTable,
    "table/alter": PreviewAlterTable,
    "table/constraint": PreviewConstraint,
    "table/index": PreviewIndex,
    # View / materialized-view DDL
    "create-view": CreateViewPreview,
    "drop-view": DropViewPreview,
    "create-matview": CreateMaterializedViewPreview,
    "drop-matview": DropMaterializedViewPreview,
    "refresh-matview": RefreshMaterializedViewPreview,
    "replace-matview": ReplaceMaterializedViewPreview,
    # Schema & sequence DDL
    "create-schema": SchemaCreatePreview,
    "drop-schema": SchemaDropPreview,
    "rename-schema": SchemaRenamePreview,
    "create-sequence": SequenceCreatePreview,
    "alter-sequence": SequenceAlterPreview,
    "sequence-owner": SequenceOwnerPreview,
    "drop-sequence": SequenceDropPreview,
    # Function & type DDL
    "create-function": CreateFunctionPreview,
    "drop-function": DropFunctionPreview,
    "create-enum-type": CreateEnumTypePreview,
    "create-composite-type": CreateCompositeTypePreview,
    "drop-type": DropTypePreview,
    "alter-type-add-value": AlterTypeAddValuePreview,
}


def preview_docs(op_class: type[DdlPreview]) -> tuple[str, str]:
    """
    Split a preview op's docstring into the route's OpenAPI text.

    Args:
        op_class: the preview op the route constructs.

    Returns:
        ``(summary, description)`` — the docstring's first line, and the whole
        dedented docstring.
    """
    doc = inspect.getdoc(op_class) or ""

    return doc.split("\n", 1)[0], doc


def _preview_endpoint(op_class: type[DdlPreview]) -> Callable[..., Awaitable[dict]]:
    """
    Build the route handler for one DDL preview op.

    Every preview route has the same body, so the handler is closed over its op
    class rather than written out per route. FastAPI reads the returned
    function's own signature, so the path params, the body, and the CSRF
    dependency are all declared here once.

    Args:
        op_class: the preview op to construct from the request body.

    Returns:
        The async route handler for that op.
    """
    async def preview(
        connection_id: str, database: str, body: dict = Body(...),
        session: Session = Depends(require_csrf),
    ) -> dict:
        """
        Build the preview SQL for one DDL spec (see the route's description).
        """
        async with session_pool_for(session, connection_id).acquire() as c:
            op = op_class(c, body)
            await op.apply()

            return op.get_result()

    return preview


for _suffix, _op_class in PREVIEW_OPS.items():
    _summary, _description = preview_docs(_op_class)

    router.add_api_route(
        f"/{_suffix}",
        _preview_endpoint(_op_class),
        methods=["POST"],
        # Derived, not hand-written: FastAPI names a route after its handler
        # function, and every handler here is the same closure called `preview`.
        # The name only feeds the OpenAPI operation id and tests/test_routes.py.
        name=f"preview_{_suffix.replace('/', '_').replace('-', '_')}",
        summary=_summary,
        description=_description,
    )
```

### A migrated router, end to end (`backend/app/endpoints/databases.py`)

```python
"""
The connection's database list — the navigator's top level.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import require_session
from ..connections import Session, session_pool_for
from ..operations import ListDatabasesQuery
from .common import CONNECTION_PREFIX

router = APIRouter(prefix=CONNECTION_PREFIX, tags=["databases"])


@router.get("/databases")
async def databases(
    connection_id: str, session: Session = Depends(require_session)
) -> list[dict]:
    """
    List the databases available on a connection.

    Route: ``GET /api/{connection_id}/databases``.

    Returns:
        ``[{"name": str}]`` — one entry per non-template, connectable database.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListDatabasesQuery(c)
        await op.apply()

        return op.get_result()
```

### `backend/app/main.py` after the move

```python
from .endpoints import ROUTERS
from .errors import BadRequest, ConflictError, DomainError

# ... app construction, auth/config route registration, _domain_error_handler ...

@app.exception_handler(asyncpg.PostgresError)
async def _pg_error_handler(request: Request, exc: asyncpg.PostgresError) -> JSONResponse:
    """
    Translate a driver error into the typed taxonomy, then render it through the
    one domain-error handler — so ``errors.py`` stays the single place a status
    is chosen. An integrity/unique violation is a conflict; anything else the
    server rejected is a bad request.
    """
    if isinstance(exc, asyncpg.exceptions.IntegrityConstraintViolationError):
        domain: DomainError = ConflictError(str(exc))
    else:
        domain = BadRequest(str(exc))

    return await _domain_error_handler(request, domain)


# Registration order decides nothing: no two routes can claim the same concrete
# path (see tests/test_routes.py), so this loop follows the tuple's own order.
for _router in ROUTERS:
    app.include_router(_router)


# Must stay the last statement in this file: it registers a catch-all
# `GET /{full_path:path}` route, and FastAPI matches routes in registration
# order. Any route added below this line would be unreachable.
mount_static(app)
```

### `backend/tests/test_routes.py` — the ambiguity check

```python
def _segments(path: str) -> list[str]:
    """
    Split a route path into its non-empty segments.
    """
    return [s for s in path.split("/") if s]


def _is_param(segment: str) -> bool:
    """
    Report whether a path segment is a ``{name}`` placeholder.
    """
    return segment.startswith("{") and segment.endswith("}")


def _ambiguous(a: str, b: str) -> bool:
    """
    Report whether two route paths can both match one concrete URL.

    Args:
        a: the first route's path template.
        b: the second route's path template.

    Returns:
        True when the two have the same segment count and every position either
        holds the same literal in both or a parameter in at least one.
    """
    left, right = _segments(a), _segments(b)

    if len(left) != len(right):
        return False

    return all(_is_param(x) or _is_param(y) or x == y for x, y in zip(left, right))
```

The route table the tests compare against is a module-level `EXPECTED_ROUTES` tuple of `(method, path, name)` triples — the `## Route inventory` tables, transcribed. Routes are read off `app.routes`, keeping only paths that start with `/api/`, dropping `HEAD`/`OPTIONS`, and skipping any path holding a `:path` convertor (so the test is valid whether or not `mount_static` registered its catch-all).

---

## Route inventory

Every route in the app after this change. `C` is `/api/{connection_id}`; `D` is `/api/{connection_id}/db/{database}`. "Ops" names the operation classes the body constructs, all imported from `app.operations`. "Name" is the route name FastAPI records, which `EXPECTED_ROUTES` transcribes.

**`main.py`** — registered directly on `app`, handlers in `auth.py` / `config.py`, URLs unchanged.

| Method | Path | Name | Handler |
|---|---|---|---|
| POST | `/api/login` | `login` | `auth.login` |
| POST | `/api/logout` | `logout` | `auth.logout` |
| GET | `/api/whoami` | `whoami` | `auth.whoami` |
| GET | `/api/config` | `app_config` | `config.app_config` |

**`endpoints/databases.py`** — `prefix=CONNECTION_PREFIX`

| Method | Path | Name | Ops | From |
|---|---|---|---|---|
| GET | `C/databases` | `databases` | `ListDatabasesQuery` | [`main.py:235`](backend/app/main.py#L235) |

**`endpoints/roles.py`** — `prefix=CONNECTION_PREFIX`

| Method | Path | Name | Ops | From |
|---|---|---|---|---|
| GET | `C/roles` | `roles` | `ListRolesQuery` | [`main.py:634`](backend/app/main.py#L634) |
| GET | `C/roles/{role}` | `role_detail` | `RoleAttributesQuery`, `RoleMembershipsQuery`, `RolePrivilegesQuery` | [`main.py:653`](backend/app/main.py#L653) |

**`endpoints/query.py`** — `prefix=CONNECTION_PREFIX`

| Method | Path | Name | Ops | From |
|---|---|---|---|---|
| POST | `C/query` | `run_query` | `RunQueryCommand` | [`main.py:868`](backend/app/main.py#L868) |
| POST | `C/explain` | `explain_query` | `ExplainQueryCommand` | [`main.py:895`](backend/app/main.py#L895) |
| POST | `C/ddl/execute` | `execute_ddl` | `ExecuteDdlCommand` | [`main.py:932`](backend/app/main.py#L932) |

**`endpoints/schemas.py`** — `prefix=DATABASE_PREFIX`

| Method | Path | Name | Ops | From |
|---|---|---|---|---|
| GET | `D/schemas` | `schemas` | `ListSchemasQuery` | [`main.py:254`](backend/app/main.py#L254) |
| GET | `D/graph` | `database_graph` | `SchemaTablesQuery`, `SchemaIndexesQuery`, `SchemaConstraintsQuery`, `SchemaForeignKeysQuery`, `assemble_database_graph` | [`main.py:539`](backend/app/main.py#L539) |
| GET | `D/{schema}/objects` | `objects` | `ListObjectsQuery` | [`main.py:273`](backend/app/main.py#L273) |
| GET | `D/{schema}/functions` | `functions` | `ListFunctionsQuery` | [`main.py:293`](backend/app/main.py#L293) |
| GET | `D/{schema}/types` | `types` | `ListTypesQuery` | [`main.py:313`](backend/app/main.py#L313) |
| GET | `D/{schema}/indexes` | `indexes` | `SchemaIndexesQuery`, `flatten_schema_indexes` | [`main.py:333`](backend/app/main.py#L333) |
| GET | `D/{schema}/dependencies` | `dependencies` | `ListDependenciesQuery` | [`main.py:355`](backend/app/main.py#L355) |
| GET | `D/{schema}/inheritance` | `inheritance` | `ListInheritanceQuery` | [`main.py:376`](backend/app/main.py#L376) |
| GET | `D/{schema}/graph` | `schema_graph` | `SchemaTablesQuery`, `SchemaColumnsQuery`, `SchemaIndexesQuery`, `SchemaConstraintsQuery`, `SchemaForeignKeysQuery`, `assemble_schema_graph` | [`main.py:499`](backend/app/main.py#L499) |

**`endpoints/tables.py`** — `prefix=DATABASE_PREFIX`

| Method | Path | Name | Ops | From |
|---|---|---|---|---|
| GET | `D/{schema}/{table}/columns` | `columns` | `ListColumnsQuery` | [`main.py:397`](backend/app/main.py#L397) |
| GET | `D/{schema}/{table}/privileges` | `table_privileges` | `TablePrivilegesQuery` | [`main.py:418`](backend/app/main.py#L418) |
| GET | `D/{schema}/{table}/definition` | `view_definition` | `ViewDefinitionQuery` | [`main.py:441`](backend/app/main.py#L441) |
| GET | `D/{schema}/{table}/structure` | `structure` | `ListIndexesQuery`, `ListConstraintsQuery`, `ListForeignKeysQuery` | [`main.py:464`](backend/app/main.py#L464) |
| GET | `D/{schema}/{table}/sequence` | `sequence_detail` | `SequenceDetailQuery` | [`main.py:578`](backend/app/main.py#L578) |
| GET | `D/{schema}/{name}/index` | `index_detail` | `IndexDetailQuery` | [`main.py:604`](backend/app/main.py#L604) |

**`endpoints/rows.py`** — `prefix=DATABASE_PREFIX`

| Method | Path | Name | Ops | From |
|---|---|---|---|---|
| GET | `D/{schema}/{table}/rows` | `list_rows` | `ListRowsQuery` | [`main.py:693`](backend/app/main.py#L693) |
| POST | `D/{schema}/{table}/rows` | `insert_row` | `InsertRowCommand` | [`main.py:731`](backend/app/main.py#L731) |
| PUT | `D/{schema}/{table}/rows/{row_id}` | `update_row` | `UpdateRowCommand` | [`main.py:758`](backend/app/main.py#L758) |
| DELETE | `D/{schema}/{table}/rows/{row_id}` | `delete_row` | `DeleteRowCommand` | [`main.py:785`](backend/app/main.py#L785) |
| POST | `D/{schema}/{table}/rows/import/preview` | `preview_import_rows` | `PreviewImportRowsQuery` | [`main.py:811`](backend/app/main.py#L811) |
| POST | `D/{schema}/{table}/rows/import` | `import_rows` | `ImportRowsCommand` | [`main.py:839`](backend/app/main.py#L839) |

**`endpoints/export.py`** — `prefix=DATABASE_PREFIX`

| Method | Path | Name | Ops | From |
|---|---|---|---|---|
| GET | `D/{schema}/{table}/export` | `export_rows` | `ExportRowsQuery` | [`main.py:1557`](backend/app/main.py#L1557) |

**`endpoints/ddl.py`** — `prefix=DATABASE_PREFIX + "/ddl"`

| Method | Path | Name | Ops | From |
|---|---|---|---|---|
| POST | `D/ddl/function-definition` | `function_definition` | `FunctionDefinitionQuery` | [`main.py:1370`](backend/app/main.py#L1370) |
| POST | `D/ddl/type-definition` | `type_definition` | `TypeDefinitionQuery` | [`main.py:1395`](backend/app/main.py#L1395) |
| POST | `D/ddl/<suffix>` ×24 | `preview_<slug>` | the 24 `PREVIEW_OPS` values | [`main.py:961-1548`](backend/app/main.py#L961) |

The 24 suffixes are `PREVIEW_OPS`' keys, listed in `## Internal Structure`; each route's name is `"preview_" + suffix.replace("/", "_").replace("-", "_")`. 58 routes total.

---

## Ordered Implementation Steps

1. **`backend/tests/test_routes.py` — new module, written first.** Module docstring; the `_segments`/`_is_param`/`_ambiguous` helpers from `## Internal Structure`; a module-level `EXPECTED_ROUTES: tuple[tuple[str, str, str], ...]` transcribing every row of `## Route inventory` (method, full path with `C`/`D` expanded, name) with the 24 preview rows spelled out literally, not derived from `PREVIEW_OPS`; and the tests for `## Expected Behaviour` cases 1-8. Import `app` from `app.main` and `PREVIEW_OPS`/`preview_docs` from `app.endpoints.ddl`. Run `cd backend && poetry run python -m pytest tests/test_routes.py` — expect an `ImportError` on `app.endpoints`.

2. **`backend/app/endpoints/common.py` — new module.** The docstring, `CONNECTION_PREFIX`, and `DATABASE_PREFIX` exactly as in `## Internal Structure`, then `columns_for` — [`main.py:212-229`](backend/app/main.py#L212)'s `_columns_for` moved verbatim, renamed without the underscore, with an `Args:` section added for `conn` and `table`.

3. **`backend/app/endpoints/databases.py`** — the module from `## Internal Structure`, verbatim. This is the shape every other route module copies: module docstring, `router = APIRouter(prefix=…, tags=[…])`, then the route functions with their bodies and docstrings moved unchanged from `main.py`. Each moved docstring's `Route:` line is rewritten to the route's new full path.

4. **`backend/app/endpoints/roles.py`, `endpoints/query.py`** — same treatment for the five routes in the `## Route inventory` tables for those two files. `query.py`'s docstring states that it holds the three routes that take a SQL string in the body and run it, `/ddl/execute` included.

5. **`backend/app/endpoints/schemas.py`** — the nine routes from its inventory table. While moving the `objects` route, fix its docstring (audit Priority 4): the summary becomes "List the tables, views, materialized views, and sequences in a schema." and `Returns:` becomes ``[{"name": str, "kind": "table" | "view" | "materializedView" | "sequence"}]``.

6. **`backend/app/endpoints/tables.py`** — the six routes from its inventory table.

7. **`backend/app/endpoints/rows.py`** — the six routes from its inventory table, plus `_DEFAULT_PAGE_SIZE` ([`main.py:106-107`](backend/app/main.py#L106)) and `_parse_json_array` ([`main.py:188-209`](backend/app/main.py#L188)) moved in as module-private, since `list_rows` is their only caller. Import `columns_for` from `.common`.

8. **`backend/app/endpoints/export.py`** — the export route moved verbatim from `main.py`, which by then already carries `backend-security-config-hardening`'s edits (that plan is this one's declared dependency). Confirm before moving that the route reads `media, ext = EXPORT_MEDIA[format]` and `headers={"Content-Disposition": content_disposition(schema, table, ext)}`, and move the `from ..export_format import EXPORT_MEDIA, content_disposition` import in with it. Check afterwards: `grep -rn 'filename=\|_EXPORT_MEDIA' backend/app/endpoints/` — zero matches. Import `columns_for` from `.common`.

9. **`backend/app/endpoints/ddl.py`** — the module docstring (it holds the DDL preview routes plus the two definition reads; the single execute route lives in `query.py`; every route here is POST + CSRF because the spec travels in the body, though a preview mutates nothing), the `router`, `PREVIEW_OPS`, `preview_docs`, `_preview_endpoint`, the two hand-written definition routes moved from `main.py`, and the registration loop — all exactly as in `## Internal Structure`. Its imports are `inspect`; `Awaitable`/`Callable` from `collections.abc`; `APIRouter`/`Body`/`Depends` from `fastapi`; `require_csrf` from `..auth`; `Session`/`session_pool_for` from `..connections`; `DdlPreview`, `FunctionDefinitionQuery`, `TypeDefinitionQuery`, and the 24 `PREVIEW_OPS` classes from `..operations`; and `DATABASE_PREFIX` from `.common`. Check: `cd backend && poetry run python -c "from app.endpoints.ddl import PREVIEW_OPS; print(len(PREVIEW_OPS))"` prints `24`.

10. **`backend/app/endpoints/__init__.py`** — module docstring naming its role (aggregate the per-resource routers so `main.py` includes one tuple, mirroring `operations/__init__.py`), the eight `from .x import router as x_router` lines, the `ROUTERS` tuple with the comment from `## Internal Structure`, and `__all__ = ["ROUTERS"]`.

11. **`backend/app/main.py` — delete everything that moved.** Remove all 54 route functions, `_DEFAULT_PAGE_SIZE`, `_parse_json_array`, `_columns_for`, and the four `# --- … ---` section banners. Remove the now-unused imports: `json`, `Body`, `Depends`, `Response`, `StreamingResponse`, the whole `from .operations import (…)` block, `from .contract import ColumnMeta, TableRef`, the `from .export_format import …` line, `require_csrf`/`require_session` from the `.auth` import, and `Session`/`session_pool_for` from the `.connections` import. **Keep** `AsyncIterator` (the lifespan's return type), `asyncpg`, `Request`, `FastAPI`, `JSONResponse`, and `SWEEP_INTERVAL_SECONDS`/`close_all_sessions`/`sweep_idle_sessions`. Add `from .endpoints import ROUTERS`. Add the `include_router` loop from `## Internal Structure` immediately above the `mount_static(app)` call, keeping that call and its comment last in the file.

12. **`backend/app/main.py` — rewrite the module docstring.** It describes app assembly now: lifespan, the two exception handlers, the four auth/config routes, the router includes, the static mount. Keep the two sentences that still hold — the pool is resolved from the session cookie rather than the `connection_id` path segment, and `GET /api/config` is deliberately unauthenticated. Add one sentence saying the routes live in `app/endpoints/`, one saying every database-scoped route sits under `/api/{connection_id}/db/{database}/` so `{database}` can never occupy the same position as a literal, and correct the stale claim that only mutating routes take `require_csrf` — every POST/PUT/DELETE does, the non-mutating DDL preview POSTs included.

13. **`backend/app/errors.py` — add `BadRequest`.** Insert the class from `## Public API` directly above `ConflictError` ([`errors.py:49`](backend/app/errors.py#L49)), leaving every other class where it is. Extend `ConflictError`'s docstring with one sentence naming `main.py`'s driver-error handler as what raises it.

14. **`backend/app/main.py` — rewire `_pg_error_handler`.** Replace its body with the version in `## Internal Structure` and change the `.errors` import to `BadRequest, ConflictError, DomainError`. Check: `grep -n '409\|400' backend/app/main.py` — zero matches.

15. **Run the backend suite.** `cd backend && poetry run python -m pytest`. `tests/test_routes.py` cases 1-8 go green; `test_auth.py`, `test_config.py`, `test_rate_limit.py`, and `test_static.py` pass unchanged — none of them requests a database-scoped URL ([`test_auth.py:132`](backend/tests/test_auth.py#L132) uses `/api/default/databases` and [`:144`](backend/tests/test_auth.py#L144) `/api/default/query`, both connection-scoped).

16. **`backend/tests/test_routes.py` — add the error-handler cases.** Append `## Expected Behaviour` cases 9-10, calling `_pg_error_handler` directly with `asyncpg.UniqueViolationError("dup")` and `asyncpg.PostgresSyntaxError("bad")` and reading `response.status_code` / `json.loads(response.body)`. Run the file.

17. **`frontend/tests/data/api.test.ts` — update the pinned URLs and add the new families.** Change the five database-scoped assertions to their `db`-prefixed forms ([`:31`](frontend/tests/data/api.test.ts#L31), [`:69`](frontend/tests/data/api.test.ts#L69), [`:112`](frontend/tests/data/api.test.ts#L112), [`:150`](frontend/tests/data/api.test.ts#L150), [`:177`/`:179`/`:192`](frontend/tests/data/api.test.ts#L177)) per `## Expected Behaviour` cases 11-15; leave the `runQuery`/`runExplain`/`executeDdl` assertions alone. Add the assertions in cases 16-17. Run `cd frontend && npm run test` — the changed assertions fail.

18. **`frontend/src/data/api.ts` — insert the `db` segment.** In each of the 44 builders listed under `## Files to Create / Modify / Delete`, add one path segment `db` immediately after the connection id and before the database. The edit takes one of two forms, depending on whether `data-layer-navigator-convergence` has landed:

    | Current | After |
    |---|---|
    | `` `/api/${ref.connectionId}/${ref.database}/ddl/create-view` `` | `` `/api/${ref.connectionId}/db/${ref.database}/ddl/create-view` `` |
    | `apiPath(ref.connectionId, ref.database, "ddl", "create-view")` | `apiPath(ref.connectionId, "db", ref.database, "ddl", "create-view")` |

    Leave `login`, `logout`, `whoami`, `getConfig`, `getDatabases`, `runQuery`, `runExplain`, `executeDdl`, `getRoles`, and `getRoleDetail` untouched. If `executeDdl`'s JSDoc still carries its worked example of a preview method (around [`api.ts:345`](frontend/src/data/api.ts#L345)), add the `db` segment there too — it is the pattern the next phase copies.

19. **`frontend/src/data/stores.ts` — the row-collection URL.** Apply the same insertion at [`stores.ts:25`](frontend/src/data/stores.ts#L25). If `data-layer-navigator-convergence` has already moved that URL into `api.ts`'s `tableRowsUrl`, `stores.ts` needs no edit and `tableRowsUrl` is the 45th builder to change instead.

20. **Run the frontend checks.** `cd frontend && npm run test && npm run typecheck && npm run build`. Then the two greps, each expecting zero matches:
    - `grep -rn 'connectionId}/\${' frontend/src/data/`
    - `grep -rn 'connectionId, \(ref\.\)\?database' frontend/src/data/`

21. **`backend/README.md`** — per `## Documentation Impact`.

22. **Full verification** — the `## Verification` list, including the manual walk.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `backend/app/endpoints/__init__.py` |
| Create | `backend/app/endpoints/common.py` |
| Create | `backend/app/endpoints/databases.py` |
| Create | `backend/app/endpoints/roles.py` |
| Create | `backend/app/endpoints/query.py` |
| Create | `backend/app/endpoints/schemas.py` |
| Create | `backend/app/endpoints/tables.py` |
| Create | `backend/app/endpoints/rows.py` |
| Create | `backend/app/endpoints/export.py` |
| Create | `backend/app/endpoints/ddl.py` |
| Create | `backend/tests/test_routes.py` |
| Modify | `backend/app/main.py` |
| Modify | `backend/app/errors.py` |
| Modify | `frontend/src/data/api.ts` |
| Modify | `frontend/src/data/stores.ts` |
| Modify | `frontend/tests/data/api.test.ts` |
| Modify | `backend/README.md` |

The 44 `api.ts` builders that gain the `db` segment, in file order: `getSchemas`, `getObjects`, `getFunctions`, `getTypes`, `getIndexes`, `getDependencies`, `getInheritance`, `getColumns`, `getTablePrivileges`, `getViewDefinition`, `getStructure`, `getSchemaGraph`, `getDatabaseGraph`, `getSequenceDetail`, `getIndexDetail`, `tableExportUrl`, `previewCreateTable`, `previewDropTable`, `previewAlterTable`, `previewConstraint`, `previewIndex`, `previewCreateView`, `previewDropView`, `previewCreateMatview`, `previewDropMatview`, `previewRefreshMatview`, `previewReplaceMatview`, `previewCreateSchema`, `previewDropSchema`, `previewRenameSchema`, `previewCreateSequence`, `previewAlterSequence`, `previewSequenceOwner`, `previewDropSequence`, `getFunctionDefinition`, `getTypeDefinition`, `previewCreateFunction`, `previewDropFunction`, `previewCreateEnumType`, `previewCreateCompositeType`, `previewDropType`, `previewAlterTypeAddValue`, `previewImportRows`, `executeImportRows`.

---

## Expected Behaviour

Cases 1-17 are unit-testable; cases 18-22 need a running app.

**Route table** (`backend/tests/test_routes.py`)

1. The set of `(method, path, name)` triples the app registers for paths starting `/api/`, excluding `HEAD`/`OPTIONS`, equals `EXPECTED_ROUTES` exactly — same 58 entries, no extras, no omissions.
2. No two of those routes sharing an HTTP method are `_ambiguous`. (Against today's `main.py` this test reports two failures: `GET /api/{connection_id}/{database}/schemas` vs `/api/{connection_id}/roles/{role}`, and `GET /api/{connection_id}/{database}/graph` vs the same.)
3. `GET /api/default/roles/schemas` resolves to the route named `role_detail`, with `role="schemas"`. Same for `/api/default/roles/graph` with `role="graph"`.
4. `GET /api/default/db/roles/schemas` resolves to `schemas`, with `database="roles"` — a database named `roles` still works.
5. `GET /api/default/db/shop/ddl/objects` resolves to `objects` with `schema="ddl"`, and `POST /api/default/db/shop/ddl/table/rows` resolves to `insert_row` with `schema="ddl"`, `table="table"` — a schema named `ddl` is reachable.
6. `POST /api/default/db/shop/ddl/table/create` resolves to `preview_table_create`.
7. `PREVIEW_OPS` has 24 entries, every value is a `DdlPreview` subclass, and `set(PREVIEW_OPS.values())` equals the set of `DdlPreview` subclasses exported from `app.operations` — a phase that adds a preview op without a route fails here.
8. `preview_docs(CreateViewPreview)` returns a 2-tuple whose first element is `"Preview a ``CREATE [OR REPLACE] VIEW`` statement."` and whose second starts with the first and contains `"Spec:"`.

**Error handling** (`backend/tests/test_routes.py`)

9. `_pg_error_handler` given `asyncpg.UniqueViolationError("dup")` returns status 409 with body `{"detail": "dup"}`; the same for `asyncpg.ForeignKeyViolationError`.
10. `_pg_error_handler` given `asyncpg.PostgresSyntaxError("bad")` returns status 400 with body `{"detail": "bad"}`.

**Frontend URL builders** (`frontend/tests/data/api.test.ts`)

11. `getViewDefinition` fetches `/api/default/db/sqladmin/public/active_customers/definition`.
12. `getStructure` fetches `/api/default/db/sqladmin/public/customers/structure`.
13. `getSchemaGraph` fetches `/api/default/db/sqladmin/public/graph`; `getDatabaseGraph` fetches `/api/default/db/sqladmin/graph`.
14. `tableExportUrl` returns `/api/default/db/sqladmin/public/customers/export?format=csv` and the `format=json` form.
15. `tableExportUrl` with a table named `my table` returns `/api/default/db/sqladmin/public/my%20table/export?format=csv` — the encoding it already does is unaffected.
16. `getSchemas("default", "shop")` fetches `/api/default/db/shop/schemas`; `previewCreateTable` posts to `/api/default/db/shop/ddl/table/create`; `previewImportRows` posts to `/api/default/db/shop/public/orders/rows/import/preview`.
17. The connection-scoped builders are byte-identical to today: `runQuery` → `/api/default/query`, `runExplain` → `/api/default/explain`, `executeDdl` → `/api/default/ddl/execute`, `getDatabases` → `/api/default/databases`, `getRoles` → `/api/default/roles`, `getRoleDetail("default", "schemas")` → `/api/default/roles/schemas`.

**Manual** (a running app against the seeded database)

18. Sign in, then walk the navigator: databases → schemas → objects → a table. The Data, Structure, and Properties tabs all populate.
19. Open a schema diagram and a database diagram; both render. Open the Functions, Types, and Indexes categories, a sequence's info tab, and an index's info tab.
20. Run a query, run Explain, preview and execute one DDL statement from a dialog, import rows from a file, and export a table as CSV — the downloaded file is named `public.customers.csv`.
21. Open the Roles rail and a role's detail page.
22. **The bug fix.** Run `CREATE ROLE "schemas"; CREATE ROLE "graph";` in the Query panel, refresh the Roles rail, and open each. Before this change both show a schema list; after it, each shows its own role detail page.

---

## Verification

```bash
cd backend && poetry run python -m pytest
cd backend && poetry run pyright          # standard mode, per pyproject.toml:39
cd frontend && npm run test && npm run typecheck && npm run build
```

Grep invariants, from the repo root, each expecting the stated result:

```bash
grep -n '@app\.\(get\|post\|put\|delete\)' backend/app/main.py     # 0
grep -n 'session_pool_for\|409\|400' backend/app/main.py           # 0
grep -rn 'filename=\|_EXPORT_MEDIA' backend/app/endpoints/         # 0
grep -rln 'APIRouter(' backend/app/endpoints/                      # the 8 route modules only
grep -rn 'connectionId}/\${' frontend/src/data/                    # 0
grep -rn 'connectionId, \(ref\.\)\?database' frontend/src/data/    # 0
wc -l backend/app/main.py                                          # under 150
```

Manual smoke: run the app with the project's `/verify` skill and walk `## Expected Behaviour` cases 18-22. Case 22 is the one that proves the bug fixed; run it against a scratch database so the two odd roles can be dropped afterwards.

---

## Documentation Impact

The backend publishes no generated API docs (`/docs` is off unless `SQLADMIN_ENABLE_DOCS` opts it in), so [`backend/README.md`](backend/README.md#L50)'s Layout section is the backend's architecture map. Rewrite its first bullet and add one:

- `app/main.py` — FastAPI app, lifespan (idle-session sweep), exception handlers, router wiring
- `app/endpoints/` — one `APIRouter` per resource (`databases`, `schemas`, `tables`, `rows`, `export`, `roles`, `query`, `ddl`); `common.py` holds the two route prefixes

Add one sentence under the Layout list: *"Authenticated routes are namespaced `/api/{connection_id}/...`, and every database-scoped route sits under `/api/{connection_id}/db/{database}/...` — the literal `db` keeps a database name out of the same path position as a literal segment like `roles`."*

`main.py`'s module docstring is the other documentation surface, rewritten in step 12. No frontend doc page names an API path. `CHANGELOG.md` gains no entry — changelog text is written at release time, per [`release-steps.md`](release-steps.md).

---

## Potential Challenges

- **Two other drafted plans also edit `backend/app/main.py`.** `backend-security-config-hardening` is this plan's declared dependency, so its export-route edits are already in place when step 8 moves that route. `backend-query-ddl-layer-convergence` has no declared order relative to this plan: its step 35 corrects the `/objects` route docstring, which step 5 here applies while moving that route. If it lands afterwards, its step 35 is already done and its target file is `endpoints/schemas.py`, not `main.py`.
- **`data-layer-navigator-convergence` rewrites the same `api.ts` lines.** It routes all 54 URLs through a new `apiPath(...segments)` helper. Step 18's table gives both forms of the same one-segment insertion; whichever state the file is in, the edit and the two zero-match greps in step 20 are the same.
- **A missed frontend builder is a 404 only at runtime.** The two step-20 greps are the mechanical catch — neither can pass while a database name still sits directly after the connection id.
- **The backend and frontend URL changes must ship together.** Between step 11 and step 19 the app does not work end to end; do not stop to smoke-test in that window.
- **`_preview_endpoint`'s closure must declare its own path params.** FastAPI reads the returned inner function's signature, not the factory's. Dropping `connection_id` or `database` from the inner signature makes FastAPI raise at import time about an undeclared path parameter, so the failure is loud rather than silent.
- **Route names are derived, not written.** `name=f"preview_{suffix…}"` yields `preview_table_create` where today's function is `preview_create_table`. Nothing calls `url_for`, so the only consumers are the OpenAPI operation ids and `EXPECTED_ROUTES`; transcribe the derived names into the test, not today's function names.
- **`mount_static` must stay the last statement.** It registers `GET /{full_path:path}`, which matches everything. `test_routes.py` filters to paths starting `/api/` and skips `:path` convertors so it stays valid whether or not a static directory is present.

---

## Critical Files

- [`backend/app/main.py`](backend/app/main.py) — read in full before starting; every route body moves out of it.
- [`backend/app/operations/__init__.py:80-148`](backend/app/operations/__init__.py#L80) — the aggregated operation classes the route→class table draws from, and the `__init__.py`-as-aggregator shape `endpoints/__init__.py` copies.
- [`backend/app/operations/list_objects.py:20-39`](backend/app/operations/list_objects.py#L20) — **the precedent for `PREVIEW_OPS`**: a declared table plus one loop, with the comment stating why a new entry is one additive line.
- [`backend/app/operations/common.py:1-3`](backend/app/operations/common.py#L1) — the `common.py`-per-package precedent `endpoints/common.py` copies.
- [`backend/app/operations/ddl.py:25-68`](backend/app/operations/ddl.py#L25) — `DdlPreview`, the base every `PREVIEW_OPS` value subclasses and the type the registry is annotated with.
- [`backend/app/auth.py:139-176`](backend/app/auth.py#L139) — `require_session` and `require_csrf`, the two dependencies every moved route keeps.
- [`backend/app/connections.py:204-218`](backend/app/connections.py#L204) — `session_pool_for`, the first line of every moved route body.
- [`backend/app/errors.py:11-79`](backend/app/errors.py#L11) — the taxonomy, gaining `BadRequest` and putting `ConflictError` to work.
- [`backend/app/static.py:38-56`](backend/app/static.py#L38) — `mount_static` and its catch-all, which must stay registered last.
- [`frontend/src/data/api.ts`](frontend/src/data/api.ts) — all 44 database-scoped builders.
- [`plans/backend-security-config-hardening.md`](plans/backend-security-config-hardening.md) — the declared dependency; its export-route edits are what step 8 moves into `endpoints/export.py`.
- [`plans/research/codebase-health-audit-2026-08-29.md`](plans/research/codebase-health-audit-2026-08-29.md) — Priority 1 #15, Priority 2 #20 and #22, and the "route-table shape" design-decision note this plan closes.
- `~/.claude/CODE_CONVENTIONS.md` — the Python docstring and typing rules every new module follows.

---

## Non-Goals

- **A FastAPI dependency that yields the acquired connection.** Every route body would shrink by its `async with session_pool_for(...).acquire() as c:` line, but the export route must keep its connection alive past the response and so could not use it. The move stays verbatim instead, so the diff is reviewable route by route.[^no-conn-dep]
- **Renaming the DDL preview op classes.** The audit lists their three competing naming conventions as a separate design call. `PREVIEW_OPS` names them as they are today.
- **Changing which routes require CSRF.** The 26 non-mutating preview POSTs keep `require_csrf`; step 12 corrects the docstring that denies it, and nothing else.
- **Moving the exception handlers out of `main.py`.** Two handlers totalling ~20 lines are app-level wiring, which is what `main.py` is for after this change.
- **Versioning the API or adding a `/api/v1` prefix.** The frontend and backend ship as one artifact; there is no second client to keep working on the old URLs.
- **Removing the other dead code the audit lists** (`sql.ddl.rename_view`, the `operations/__init__.py` base re-exports, `Session.host`). They belong to the two sibling backend plans.

---

## Implementation Notes

- **`endpoints/ddl.py`'s `_preview_endpoint` needed a `cast` the `## Internal Structure` snippet doesn't show.** The snippet's `op = op_class(c, body)` fails `pyright` (standard mode): `op_class` is statically `type[DdlPreview]`, and calling a generic `type[Base]` type-checks against `Base`'s own `__init__` — `DdlPreview.__init__(self) -> None` ([`operations/ddl.py:58`](backend/app/operations/ddl.py#L58)) takes zero args, not the `(conn, spec)` every subclass actually declares. `DdlPreview.__init__` is outside this plan's file list, so rather than widen its signature, the route builds a locally-scoped `construct = cast(Callable[[asyncpg.Connection, dict], DdlPreview], op_class)` and calls that — asserting, at the one place the registry pattern needs it, the "every subclass takes `(conn, spec)`" convention `DdlPreview`'s own docstring and `CreateViewPreview`'s already document. `PREVIEW_OPS`'s declared type (`dict[str, type[DdlPreview]]`) and the case-7/8 test assertions are unaffected — the cast changes nothing observable, only what `pyright` can verify at the call site.
- **`frontend/src/data/stores.ts` needed no edit.** Step 19's conditional fired on its "already moved" branch: `data-layer-navigator-convergence` had already relocated the row-collection URL into `api.ts`'s `tableRowsUrl`, so `stores.ts` still only calls that function and never spells out a URL itself. `tableRowsUrl` is the 45th builder in the `db`-segment insertion instead of `stores.ts`'s own literal.

---

## Notes

[^why-routers]: `APIRouter` appears nowhere in the repo today — `grep -rn 'APIRouter\|include_router' backend/` returns zero matches — so this is a new pattern and needs the justification. The alternative that keeps the repo pattern-free is per-resource modules exposing a `register(app)` function that the app calls, which is what the four auth/config routes already do in miniature ([`main.py:161-164`](backend/app/main.py#L161)). It was rejected on the load-bearing point of this plan: a `register(app)` function declares each route's full path at its decorator, so the URL scheme stays scattered across nine files and nothing forces a module to state its prefix. `APIRouter` makes the prefix a required, single, greppable declaration per file — which is why the `db` insertion is one constant rather than 45 decorators, and why a reader can tell a file's URL scope from its first ten lines. It is also FastAPI's own documented mechanism for exactly this split, so it costs no novelty for a reader who knows the framework.

[^execute-home]: `POST /api/{connection_id}/ddl/execute` is connection-scoped while every preview is database-scoped, so it cannot share `ddl.py`'s router. The two ways to keep it in `ddl.py` are a second router in that module (breaking the one-router-per-file rule that makes the prefix table readable) or moving it under `DATABASE_PREFIX` (changing `executeDdl(connectionId, sql)`'s signature and its 26 call sites in `SqlAdminController.ts`, for a `{database}` segment the backend does not read). Grouping it with `/query` and `/explain` costs neither: all three take `{"sql": …}` in the body and run it on the session's connection, and `ddl.py`'s docstring points at it.

[^ambiguity-rule]: FastAPI and Starlette resolve an ambiguous pair by registration order — first registered wins — and many FastAPI apps lean on that deliberately, registering `/users/me` above `/users/{id}`. This app cannot: the two templates that collide today are declared 400 lines apart in one file, and after the split they live in different files entirely, so nothing at either declaration site hints that a third route decides the outcome. The test therefore asserts the stronger property, that ordering decides nothing at all, which is checkable from the route table alone and stays checkable as routes move between files. The restriction to routes sharing a method is what keeps it from firing on the real pairs that already differ safely — `PUT`/`DELETE` on `…/rows/{row_id}` against `POST …/rows/import`, for instance. A weaker test (assert the two known-bad URLs resolve correctly) was rejected: it pins the two symptoms and none of the cause, so the next route added in the `{database}` position would reintroduce the class of bug with the test still green.

[^registry-not-decorators]: Keeping 24 decorated functions and merely moving them into four files was the alternative. It keeps every route greppable by its own `@router.post` line, which is the one real advantage — but it preserves 24 copies of a four-line body that already exist only because a decorator needs a function under it, and it leaves the next DDL phase copying a block instead of adding a line. The registry keeps a route greppable by its path suffix (the string a reader actually has, from a browser's network tab) and keeps the OpenAPI text derived from the op class that already documents it. A middle option — a decorator factory applied 24 times — was rejected as strictly worse than both: it keeps the 24 call sites and adds indirection.

[^conflict-live]: Removing `ConflictError` was the other option, and it is the cheaper edit: delete six lines from `errors.py` and change nothing else. It was rejected because it settles the split the wrong way round. [`errors.py:1-6`](backend/app/errors.py#L1) states that the taxonomy is what a single handler maps to `(status, {detail})`, and the frontend consumes that one contract; the ad-hoc statuses in `_pg_error_handler` are what contradicts it, not the class. Deleting the class would leave two mechanisms choosing statuses and would make 409 the only status in the app with no name — so the next integrity-violation case (an operation that wants to raise a conflict itself, rather than letting the driver error escape) would either hardcode a third mechanism or resurrect the class. Translating instead costs four lines in the handler, deletes both magic numbers, and leaves one table. `BadRequest` is added by the same argument: with `ConflictError` named, a bare `DomainError(str(exc))` would leave 400 as the one status chosen by a base class's default rather than by a named member of the taxonomy.

[^no-conn-dep]: A `Depends` that acquires the connection and yields it would remove one nesting level from ~45 route bodies. Two things rule it out here. `export_rows` acquires its connection manually and releases it in the streaming generator's `finally` precisely because the connection must outlive the handler's return ([`main.py:1583-1604`](backend/app/main.py#L1583)); a yield dependency's exit runs on a schedule the route cannot control, so that route would need the manual form anyway and the pattern would be two-thirds applied. And a plan whose stated claim is "the bodies moved verbatim" cannot also rewrite every body — a reviewer would have to read all 54 diffs rather than confirming the file each landed in. Introducing the dependency later, on top of a green `test_routes.py` and an unchanged suite, is a strictly smaller change than doing it during the move.
