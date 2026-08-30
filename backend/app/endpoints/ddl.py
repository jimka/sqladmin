"""
DDL routes for one database: the 27 preview routes (registered from a
declared ``{path suffix: op class}`` table, since every preview route's body
is identical apart from the op class it constructs) plus two hand-written
definition reads: one that prefills the create-function form, one that seeds
the (editable) type info tab. The single execute route lives in ``query.py``
instead, since it is connection-scoped rather than database-scoped. Every
route here is POST + CSRF because the spec travels in the body, though a
preview mutates nothing.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from typing import cast

import asyncpg
from fastapi import APIRouter, Body, Depends

from ..auth import require_csrf
from ..connections import Session, session_pool_for
from ..operations import (
    AlterCompositeTypePreview,
    AlterTypeAddValuePreview,
    AlterTypeRenameValuePreview,
    CreateCompositeTypePreview,
    CreateEnumTypePreview,
    CreateFunctionPreview,
    CreateMaterializedViewPreview,
    CreateViewPreview,
    DdlPreview,
    DropFunctionPreview,
    DropMaterializedViewPreview,
    DropTypePreview,
    DropViewPreview,
    FunctionDefinitionQuery,
    PreviewAlterTable,
    PreviewConstraint,
    PreviewCreateTable,
    PreviewDropTable,
    PreviewIndex,
    RecreateEnumTypePreview,
    RefreshMaterializedViewPreview,
    ReplaceMaterializedViewPreview,
    SchemaCreatePreview,
    SchemaDropPreview,
    SchemaRenamePreview,
    SequenceAlterPreview,
    SequenceCreatePreview,
    SequenceDropPreview,
    SequenceOwnerPreview,
    TypeDefinitionQuery,
)
from .common import DATABASE_PREFIX

router = APIRouter(prefix=DATABASE_PREFIX + "/ddl", tags=["ddl"])

# {path suffix: preview op class} — see plans/implemented/
# backend-route-registration-restructure.md's Architecture Decisions. Adding a
# preview phase is one additive line here plus the op class itself; the
# precedent is list_objects.py's _OBJECT_SELECTS.
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
    "alter-composite-type": AlterCompositeTypePreview,
    "alter-type-rename-value": AlterTypeRenameValuePreview,
    "recreate-enum-type": RecreateEnumTypePreview,
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
        # A generic `type[DdlPreview]` calls DdlPreview's own zero-arg
        # `__init__`, not the concrete subclass's — every subclass overrides it
        # to take (conn, spec) by convention (see DdlPreview's docstring), but
        # nothing in the type system says so. This cast asserts that convention
        # at the one spot the registry pattern needs it.
        construct = cast(Callable[[asyncpg.Connection, dict], DdlPreview], op_class)

        async with session_pool_for(session, connection_id).acquire() as c:
            op = construct(c, body)
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


@router.post("/function-definition")
async def function_definition(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Fetch a function/procedure's definition SQL for the edit-prefill flow.

    Route: ``POST /api/{connection_id}/db/{database}/ddl/function-definition``.
    POST+CSRF for symmetry with the other DDL routes, even though this reads
    rather than mutates — the routine's identity signature lives in the body.

    Args:
        body: ``{schema, name, signature}`` — the routine's identity-argument
            signature disambiguates overloads.

    Returns:
        ``{"definition", "isProcedure", "signature", "language"}``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = FunctionDefinitionQuery(c, body.get("schema", ""), body.get("name", ""), body.get("signature", ""))
        await op.apply()

        return op.get_result()


@router.post("/type-definition")
async def type_definition(
    connection_id: str, database: str, body: dict = Body(...), session: Session = Depends(require_csrf)
) -> dict:
    """
    Introspect an enum or composite type for the (editable) info tab.

    Route: ``POST /api/{connection_id}/db/{database}/ddl/type-definition``.

    Args:
        body: ``{schema, name}``.

    Returns:
        ``{"category", "labels", "attributes", "owner"}``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = TypeDefinitionQuery(c, body.get("schema", ""), body.get("name", ""))
        await op.apply()

        return op.get_result()
