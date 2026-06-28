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
from .update_row import UpdateRowCommand

__all__ = [
    "Operation",
    "Query",
    "Command",
    "ListDatabasesQuery",
    "ListSchemasQuery",
    "ListObjectsQuery",
    "ListColumnsQuery",
    "ListRowsQuery",
    "InsertRowCommand",
    "UpdateRowCommand",
    "DeleteRowCommand",
]
