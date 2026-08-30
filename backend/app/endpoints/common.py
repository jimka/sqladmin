"""
Helpers shared by the endpoint modules: the two route prefixes every router is
built on, and the column introspection the row and export routes both need.
"""

from __future__ import annotations

import asyncpg

from ..contract import ColumnMeta, TableRef
from ..errors import NotFound
from ..operations import ListColumnsQuery

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


async def columns_for(conn: asyncpg.Connection, table: TableRef) -> list[ColumnMeta]:
    """
    Introspect a table's columns.

    Args:
        conn: the connection to introspect on.
        table: the table to introspect.

    Raises:
        NotFound: if the table has no columns (treated as non-existent).

    Returns:
        The table's columns as typed ``ColumnMeta``.
    """
    op = ListColumnsQuery(conn, table)
    await op.apply()
    columns = op.get_columns_result()

    if not columns:
        raise NotFound(f"Table '{table.schema}.{table.name}' not found")

    return columns
