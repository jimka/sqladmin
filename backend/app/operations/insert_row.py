"""
InsertRowCommand — insert one row, returning the created row.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import asyncpg

from ..contract import ColumnMeta, TableRef
from ..errors import ValidationError
from ..sql.compiler import quote_ident
from ..wire import rows_to_wire
from .base import Command
from .common import qualified


class InsertRowCommand(Command):
    """
    Insert a row from a (server-managed-columns-stripped) payload.
    """

    def __init__(
        self,
        conn: asyncpg.Connection,
        table: TableRef,
        data: dict,
        columns: list[ColumnMeta],
    ) -> None:
        """
        Collect the insert columns, validating each payload key.

        Args:
            conn: the connection the insert will run on.
            table: the table to insert into.
            data: the new row; server-managed columns are expected to be omitted.
            columns: the table's introspected columns (the legal identifiers).

        Raises:
            ValidationError: if a payload key is not a known column.
        """
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._columns: list[ColumnMeta] = columns
        allowed = {c.name for c in columns}
        self._cols: list[str] = []
        self._values: list[Any] = []

        for k, v in (data or {}).items():
            if k not in allowed:
                raise ValidationError(f"Unknown column '{k}'")

            self._cols.append(k)
            self._values.append(v)

        self._raw: Mapping[str, Any] | None = None

    async def apply(self) -> None:
        """
        Insert the row in a transaction and capture it via ``RETURNING *``.
        """
        if self._cols:
            cols_sql = ", ".join(quote_ident(c) for c in self._cols)
            ph = ", ".join(f"${i + 1}" for i in range(len(self._values)))
            sql = f"INSERT INTO {qualified(self._table)} ({cols_sql}) VALUES ({ph}) RETURNING *"
        else:
            sql = f"INSERT INTO {qualified(self._table)} DEFAULT VALUES RETURNING *"

        async with self._conn.transaction():
            self._raw = await self._conn.fetchrow(sql, *self._values)

    def get_result(self) -> dict:
        """
        Return the created row with wire-mapped scalars.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            The created row as wire-mapped scalar values.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return rows_to_wire([dict(self._raw)], self._columns)[0]
