"""
Aggregates the per-resource routers so ``main.py`` includes one tuple,
mirroring ``operations/__init__.py``'s aggregation of the operation classes.
"""

from __future__ import annotations

from fastapi import APIRouter

from .databases import router as databases_router
from .ddl import router as ddl_router
from .export import router as export_router
from .query import router as query_router
from .roles import router as roles_router
from .rows import router as rows_router
from .schemas import router as schemas_router
from .tables import router as tables_router

# Registration order decides nothing (see tests/test_routes.py's ambiguity
# check), so this is simply the module's own declaration order.
ROUTERS: tuple[APIRouter, ...] = (
    databases_router,
    roles_router,
    query_router,
    schemas_router,
    tables_router,
    rows_router,
    export_router,
    ddl_router,
)

__all__ = ["ROUTERS"]
