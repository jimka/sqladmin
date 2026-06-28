"""
ListColumnsQuery — columns + PK + generated flags for one table.

``get_result()`` returns the contract JSON for the ``/columns`` route;
``get_columns_result()`` returns the typed ``ColumnMeta`` list the row
operations consume.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from ..contract import ColumnMeta, TableRef
from ..wire import pg_type_to_wire
from .base import Query


class ListColumnsQuery(Query):
    """
    Introspect one table's columns, marking primary-key and generated ones.
    """

    _SQL = """
        SELECT
            c.column_name AS name,
            c.data_type   AS data_type,
            (c.is_nullable = 'YES') AS nullable,
            COALESCE(
                c.is_identity = 'YES'
                OR c.is_generated = 'ALWAYS'
                OR c.column_default LIKE 'nextval(%',
                false
            ) AS is_generated,
            COALESCE(pk.is_pk, false) AS is_primary_key
        FROM information_schema.columns c
        LEFT JOIN (
            SELECT kcu.column_name, true AS is_pk
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name
             AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = $1 AND tc.table_name = $2
        ) pk ON pk.column_name = c.column_name
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position
    """

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the table to introspect.
        """
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the column metadata rows for the table.
        """
        self._raw = await self._conn.fetch(self._SQL, self._table.schema, self._table.name)

    def get_columns_result(self) -> list[ColumnMeta]:
        """
        Return the typed column metadata, with derived wire types.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            One ``ColumnMeta`` per column, in ordinal order.
        """
        if self._raw is None:
            raise RuntimeError("get_columns_result() called before apply()")

        return [
            ColumnMeta(
                name=r["name"],
                data_type=r["data_type"],
                nullable=r["nullable"],
                is_primary_key=r["is_primary_key"],
                is_generated=r["is_generated"],
                wire_type=pg_type_to_wire(r["data_type"]),
            )
            for r in self._raw
        ]

    def get_result(self) -> list[dict]:
        """
        Return the contract JSON for each column.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            One contract dict (name, dataType, nullable, isPrimaryKey,
            isGenerated, wireType) per column.
        """
        return [m.to_contract() for m in self.get_columns_result()]
