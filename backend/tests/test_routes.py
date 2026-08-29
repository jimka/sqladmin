"""
Tests for the app's route table: every route resolves to exactly the
``EXPECTED_ROUTES`` triples (no extras, no omissions), no two routes sharing
an HTTP method can match the same concrete URL, the DDL preview registry
stays in sync with the ``DdlPreview`` subclasses ``app.operations`` exports,
and the driver-error handler translates a Postgres error into the typed
taxonomy's status/body.

Route *resolution* (which route wins for a concrete URL) is tested through
Starlette's own ``Route.matches`` rather than an end-to-end request, so these
tests need no session, no CSRF token, and no real Postgres connection.
"""

from __future__ import annotations

import itertools
import json
from typing import cast

import asyncpg
import pytest
from starlette.requests import Request
from starlette.routing import Match

from app import operations
from app.endpoints.ddl import PREVIEW_OPS, preview_docs
from app.main import _pg_error_handler, app
from app.operations import DdlPreview

# --- the fixed route table (## Route inventory, C/D expanded) --------------

C = "/api/{connection_id}"
D = "/api/{connection_id}/db/{database}"

EXPECTED_ROUTES: tuple[tuple[str, str, str], ...] = (
    # main.py — auth/config, URLs unchanged
    ("POST", "/api/login", "login"),
    ("POST", "/api/logout", "logout"),
    ("GET", "/api/whoami", "whoami"),
    ("GET", "/api/config", "app_config"),
    # endpoints/databases.py
    ("GET", f"{C}/databases", "databases"),
    # endpoints/roles.py
    ("GET", f"{C}/roles", "roles"),
    ("GET", f"{C}/roles/{{role}}", "role_detail"),
    # endpoints/query.py
    ("POST", f"{C}/query", "run_query"),
    ("POST", f"{C}/explain", "explain_query"),
    ("POST", f"{C}/ddl/execute", "execute_ddl"),
    # endpoints/schemas.py
    ("GET", f"{D}/schemas", "schemas"),
    ("GET", f"{D}/graph", "database_graph"),
    ("GET", f"{D}/{{schema}}/objects", "objects"),
    ("GET", f"{D}/{{schema}}/functions", "functions"),
    ("GET", f"{D}/{{schema}}/types", "types"),
    ("GET", f"{D}/{{schema}}/indexes", "indexes"),
    ("GET", f"{D}/{{schema}}/dependencies", "dependencies"),
    ("GET", f"{D}/{{schema}}/inheritance", "inheritance"),
    ("GET", f"{D}/{{schema}}/graph", "schema_graph"),
    # endpoints/tables.py
    ("GET", f"{D}/{{schema}}/{{table}}/columns", "columns"),
    ("GET", f"{D}/{{schema}}/{{table}}/privileges", "table_privileges"),
    ("GET", f"{D}/{{schema}}/{{table}}/definition", "view_definition"),
    ("GET", f"{D}/{{schema}}/{{table}}/structure", "structure"),
    ("GET", f"{D}/{{schema}}/{{table}}/sequence", "sequence_detail"),
    ("GET", f"{D}/{{schema}}/{{name}}/index", "index_detail"),
    # endpoints/rows.py
    ("GET", f"{D}/{{schema}}/{{table}}/rows", "list_rows"),
    ("POST", f"{D}/{{schema}}/{{table}}/rows", "insert_row"),
    ("PUT", f"{D}/{{schema}}/{{table}}/rows/{{row_id}}", "update_row"),
    ("DELETE", f"{D}/{{schema}}/{{table}}/rows/{{row_id}}", "delete_row"),
    ("POST", f"{D}/{{schema}}/{{table}}/rows/import/preview", "preview_import_rows"),
    ("POST", f"{D}/{{schema}}/{{table}}/rows/import", "import_rows"),
    # endpoints/export.py
    ("GET", f"{D}/{{schema}}/{{table}}/export", "export_rows"),
    # endpoints/ddl.py — the two hand-written definition reads
    ("POST", f"{D}/ddl/function-definition", "function_definition"),
    ("POST", f"{D}/ddl/type-definition", "type_definition"),
    # endpoints/ddl.py — the 24 PREVIEW_OPS routes
    ("POST", f"{D}/ddl/table/create", "preview_table_create"),
    ("POST", f"{D}/ddl/table/drop", "preview_table_drop"),
    ("POST", f"{D}/ddl/table/alter", "preview_table_alter"),
    ("POST", f"{D}/ddl/table/constraint", "preview_table_constraint"),
    ("POST", f"{D}/ddl/table/index", "preview_table_index"),
    ("POST", f"{D}/ddl/create-view", "preview_create_view"),
    ("POST", f"{D}/ddl/drop-view", "preview_drop_view"),
    ("POST", f"{D}/ddl/create-matview", "preview_create_matview"),
    ("POST", f"{D}/ddl/drop-matview", "preview_drop_matview"),
    ("POST", f"{D}/ddl/refresh-matview", "preview_refresh_matview"),
    ("POST", f"{D}/ddl/replace-matview", "preview_replace_matview"),
    ("POST", f"{D}/ddl/create-schema", "preview_create_schema"),
    ("POST", f"{D}/ddl/drop-schema", "preview_drop_schema"),
    ("POST", f"{D}/ddl/rename-schema", "preview_rename_schema"),
    ("POST", f"{D}/ddl/create-sequence", "preview_create_sequence"),
    ("POST", f"{D}/ddl/alter-sequence", "preview_alter_sequence"),
    ("POST", f"{D}/ddl/sequence-owner", "preview_sequence_owner"),
    ("POST", f"{D}/ddl/drop-sequence", "preview_drop_sequence"),
    ("POST", f"{D}/ddl/create-function", "preview_create_function"),
    ("POST", f"{D}/ddl/drop-function", "preview_drop_function"),
    ("POST", f"{D}/ddl/create-enum-type", "preview_create_enum_type"),
    ("POST", f"{D}/ddl/create-composite-type", "preview_create_composite_type"),
    ("POST", f"{D}/ddl/drop-type", "preview_drop_type"),
    ("POST", f"{D}/ddl/alter-type-add-value", "preview_alter_type_add_value"),
)


# --- ambiguity check ---------------------------------------------------------


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


# --- reading the app's actual route table -----------------------------------


def _actual_routes() -> set[tuple[str, str, str]]:
    """
    Collect ``(method, path, name)`` triples for every registered ``/api/``
    route, dropping ``HEAD``/``OPTIONS`` (FastAPI adds these automatically to
    every ``GET``) and skipping any path holding a ``:path`` convertor — the
    static catch-all, registered only when a built frontend directory exists.
    """
    triples: set[tuple[str, str, str]] = set()

    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        name = getattr(route, "name", None)

        if not path or not path.startswith("/api/") or ":path" in path or not methods or not name:
            continue

        for method in methods - {"HEAD", "OPTIONS"}:
            triples.add((method, path, name))

    return triples


def _resolve(method: str, path: str) -> tuple[str, dict[str, str]]:
    """
    Resolve ``path`` through the app's routing table exactly as Starlette
    would for an incoming request, without invoking the matched route's
    dependencies or handler body.

    Args:
        method: the HTTP method.
        path: the concrete request path.

    Raises:
        AssertionError: if no registered route matches.

    Returns:
        ``(route name, path params)`` of the route that wins.
    """
    scope = {"type": "http", "method": method, "path": path}

    for route in app.routes:
        match, child_scope = route.matches(scope)

        if match == Match.FULL:
            name = getattr(route, "name", "")

            return name, dict(child_scope["path_params"])

    raise AssertionError(f"No route matches {method} {path}")


# --- Case 1: the route table is exactly EXPECTED_ROUTES ---------------------


def test_route_table_matches_expected_exactly() -> None:
    assert len(EXPECTED_ROUTES) == 58
    assert len(set(EXPECTED_ROUTES)) == 58  # no duplicate entries in the table itself
    assert _actual_routes() == set(EXPECTED_ROUTES)


# --- Case 2: no two routes sharing a method are ambiguous -------------------


def test_no_two_routes_sharing_a_method_are_ambiguous() -> None:
    by_method: dict[str, list[str]] = {}

    for method, path, _name in EXPECTED_ROUTES:
        by_method.setdefault(method, []).append(path)

    for method, paths in by_method.items():
        for a, b in itertools.combinations(paths, 2):
            assert not _ambiguous(a, b), f"{method} {a} and {b} are ambiguous"


# --- Cases 3-6: the bug fix and its neighbours resolve correctly ------------


def test_role_named_schemas_resolves_to_role_detail() -> None:
    name, params = _resolve("GET", "/api/default/roles/schemas")

    assert (name, params["role"]) == ("role_detail", "schemas")


def test_role_named_graph_resolves_to_role_detail() -> None:
    name, params = _resolve("GET", "/api/default/roles/graph")

    assert (name, params["role"]) == ("role_detail", "graph")


def test_database_named_roles_still_resolves_to_schemas() -> None:
    name, params = _resolve("GET", "/api/default/db/roles/schemas")

    assert (name, params["database"]) == ("schemas", "roles")


def test_schema_named_ddl_is_reachable() -> None:
    objects_name, objects_params = _resolve("GET", "/api/default/db/shop/ddl/objects")
    assert (objects_name, objects_params["schema"]) == ("objects", "ddl")

    insert_name, insert_params = _resolve("POST", "/api/default/db/shop/ddl/table/rows")
    assert insert_name == "insert_row"
    assert insert_params["schema"] == "ddl"
    assert insert_params["table"] == "table"


def test_table_create_preview_resolves_to_preview_table_create() -> None:
    name, _params = _resolve("POST", "/api/default/db/shop/ddl/table/create")

    assert name == "preview_table_create"


# --- Cases 7-8: the DDL preview registry ------------------------------------


def _exported_ddl_preview_subclasses() -> set[type]:
    """
    Every ``DdlPreview`` subclass exported from ``app.operations`` (its own
    ``__all__``), excluding ``DdlPreview`` itself.
    """
    subclasses: set[type] = set()

    for name in operations.__all__:
        obj = getattr(operations, name)

        if isinstance(obj, type) and issubclass(obj, DdlPreview) and obj is not DdlPreview:
            subclasses.add(obj)

    return subclasses


def test_preview_ops_has_24_entries_matching_ddlpreview_exports() -> None:
    assert len(PREVIEW_OPS) == 24
    assert all(issubclass(op_class, DdlPreview) for op_class in PREVIEW_OPS.values())
    assert set(PREVIEW_OPS.values()) == _exported_ddl_preview_subclasses()


def test_preview_docs_splits_docstring_into_summary_and_description() -> None:
    from app.operations import CreateViewPreview

    summary, description = preview_docs(CreateViewPreview)

    assert summary == "Preview a ``CREATE [OR REPLACE] VIEW`` statement."
    assert description.startswith(summary)
    assert "Spec:" in description


# --- Cases 9-10: the driver-error handler translates into the taxonomy -----


def _request() -> Request:
    """A minimal stand-in ``Request`` for a handler that never reads it."""
    return cast(Request, cast(object, None))


@pytest.mark.parametrize(
    "error",
    [asyncpg.UniqueViolationError("dup"), asyncpg.ForeignKeyViolationError("dup")],
)
async def test_integrity_violation_becomes_409_conflict(error: asyncpg.PostgresError) -> None:
    response = await _pg_error_handler(_request(), error)

    assert response.status_code == 409
    assert json.loads(bytes(response.body)) == {"detail": "dup"}


async def test_syntax_error_becomes_400_bad_request() -> None:
    response = await _pg_error_handler(_request(), asyncpg.PostgresSyntaxError("bad"))

    assert response.status_code == 400
    assert json.loads(bytes(response.body)) == {"detail": "bad"}
