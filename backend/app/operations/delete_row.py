"""
DeleteRowCommand — delete one row by PK.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from ..contract import ColumnMeta, TableRef
from ..errors import NotFound
from ..sql.compiler import quote_ident
from .base import Command
from .common import qualified, single_pk


class DeleteRowCommand(Command):
    """
    Delete a row matched by its primary key.
    """

    def __init__(
        self,
        conn: asyncpg.Connection,
        table: TableRef,
        row_id: Any,
        columns: list[ColumnMeta],
    ) -> None:
        """
        Resolve the single PK column and capture the row id.

        Args:
            conn: the connection the delete will run on.
            table: the table to delete from.
            row_id: the primary-key value identifying the row.
            columns: the table's introspected columns.

        Raises:
            ValidationError: if the table does not have exactly one primary key.
        """
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._pk: str = single_pk(columns)
        self._row_id: Any = row_id
        self._status: str | None = None

    async def apply(self) -> None:
        """
        Delete the row in a transaction.

        Raises:
            NotFound: if no row matches the primary key.
        """
        sql = f"DELETE FROM {qualified(self._table)} WHERE {quote_ident(self._pk)}::text = $1"

        async with self._conn.transaction():
            self._status = await self._conn.execute(sql, str(self._row_id))

        if self._status is not None and self._status.rsplit(" ", 1)[-1] == "0":
            raise NotFound(f"Row with {self._pk}={self._row_id!r} not found")

    def get_result(self) -> None:
        """
        Deletes carry no body.
        """
        return None
