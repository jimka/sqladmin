"""
CQRS operation handlers — one operation per module, aggregated here so call
sites import from ``app.operations`` regardless of file layout.
"""

from .base import Command, Operation, Query
from .delete_row import DeleteRowCommand
from .insert_row import InsertRowCommand
from .list_columns import ListColumnsQuery
from .list_databases import ListDatabasesQuery
from .list_objects import ListObjectsQuery
from .list_rows import ListRowsQuery
from .list_schemas import ListSchemasQuery
from .role_detail import RoleAttributesQuery, RoleMembershipsQuery, RolePrivilegesQuery
from .roles import ListRolesQuery
from .run_query import RunQueryCommand
from .update_row import UpdateRowCommand
from .view_definition import ViewDefinitionQuery

__all__ = [
    "Operation",
    "Query",
    "Command",
    "ListDatabasesQuery",
    "ListSchemasQuery",
    "ListObjectsQuery",
    "ListColumnsQuery",
    "ListRowsQuery",
    "ListRolesQuery",
    "RoleAttributesQuery",
    "RoleMembershipsQuery",
    "RolePrivilegesQuery",
    "InsertRowCommand",
    "UpdateRowCommand",
    "DeleteRowCommand",
    "RunQueryCommand",
    "ViewDefinitionQuery",
]
