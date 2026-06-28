"""
UpdateRowCommand — update one row by PK, returning the updated row.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import asyncpg

from ..contract import ColumnMeta, TableRef
from ..errors import NotFound, ValidationError
from ..sql.compiler import quote_ident
from ..wire import rows_to_wire
from .base import Command
from .common import qualified, single_pk


class UpdateRowCommand(Command):
    """
    Update a row's non-PK columns, matched by its primary key.
    """

    def __init__(
        self,
        conn: asyncpg.Connection,
        table: TableRef,
        row_id: Any,
        data: dict,
        columns: list[ColumnMeta],
    ) -> None:
        """
        Collect the assignable (non-PK) columns, validating the payload.

        Args:
            conn: the connection the update will run on.
            table: the table to update.
            row_id: the primary-key value identifying the row.
            data: the row's column values (the PK is ignored).
            columns: the table's introspected columns (the legal identifiers).

        Raises:
            ValidationError: if a payload key is unknown, the table lacks a single
                primary key, or no updatable column is supplied.
        """
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._columns: list[ColumnMeta] = columns
        self._pk: str = single_pk(columns)
        self._row_id: Any = row_id
        allowed = {c.name for c in columns}
        self._assign: list[str] = []
        self._values: list[Any] = []

        for k, v in (data or {}).items():
            if k not in allowed:
                raise ValidationError(f"Unknown column '{k}'")

            if k == self._pk:
                continue  # never update the PK

            self._assign.append(k)
            self._values.append(v)

        if not self._assign:
            raise ValidationError("No updatable columns supplied")

        self._raw: Mapping[str, Any] | None = None

    async def apply(self) -> None:
        """
        Update the row in a transaction.

        Raises:
            NotFound: if no row matches the primary key.
        """
        set_sql = ", ".join(f"{quote_ident(c)} = ${i + 1}" for i, c in enumerate(self._assign))
        idx = len(self._values) + 1
        # ::text cast so a string path param matches int/uuid/text PKs uniformly.
        sql = (
            f"UPDATE {qualified(self._table)} SET {set_sql} "
            f"WHERE {quote_ident(self._pk)}::text = ${idx} RETURNING *"
        )

        async with self._conn.transaction():
            self._raw = await self._conn.fetchrow(sql, *self._values, str(self._row_id))

        if self._raw is None:
            raise NotFound(f"Row with {self._pk}={self._row_id!r} not found")

    def get_result(self) -> dict:
        """
        Return the updated row with wire-mapped scalars.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            The updated row as wire-mapped scalar values.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return rows_to_wire([dict(self._raw)], self._columns)[0]
