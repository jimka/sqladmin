"""
ListRowsQuery — a paginated/sorted/filtered table read.

Values are bound as ``$n`` params; identifiers are validated against the
introspected column set during clause compilation in the constructor (before
any I/O). ``count(*) OVER()`` yields the total in the same round-trip.
"""

from __future__ import annotations

from typing import Any

import asyncpg

from ..contract import ColumnMeta, TableRef
from ..sql.compiler import FilterCompiler, OrderCompiler
from ..wire import rows_to_wire
from .base import CatalogQuery
from .common import MAX_ROWS_PER_REQUEST, qualified


class ListRowsQuery(CatalogQuery):
    """
    Read one page of a table, with optional sort and filter.
    """

    def __init__(
        self,
        conn: asyncpg.Connection,
        table: TableRef,
        page: int,
        page_size: int,
        sort: list[dict] | None,
        filters: list[dict] | None,
        columns: list[ColumnMeta],
    ) -> None:
        """
        Compile the sort/filter clauses and pagination — validating before any I/O.

        Args:
            conn: the connection the query will run on.
            table: the table to read from.
            page: 1-based page number.
            page_size: rows per page (capped at the module maximum).
            sort: the SortDescriptor list, or None.
            filters: the FilterDescriptor list, or None.
            columns: the table's introspected columns (the legal identifiers).

        Raises:
            ValidationError: if a sort/filter identifier is not a known column.
        """
        super().__init__(conn)
        self._table: TableRef = table
        self._columns: list[ColumnMeta] = columns

        # Validation + clause compilation happen HERE — before any I/O:
        self._where: str
        self._params: list[Any]
        self._where, self._params = FilterCompiler(filters, columns).compile()
        self._order: str = OrderCompiler(sort, columns).compile()
        # Cap the page size so a hostile/buggy client can't request an unbounded read.
        self._limit: int = max(1, min(int(page_size), MAX_ROWS_PER_REQUEST))
        self._offset: int = max(0, (max(1, int(page)) - 1) * self._limit)

    async def apply(self) -> None:
        """
        Fetch the page plus the windowed total count.
        """
        n = len(self._params)
        sql = (
            f"SELECT *, count(*) OVER() AS __total FROM {qualified(self._table)} "
            f"{self._where} {self._order} LIMIT ${n + 1} OFFSET ${n + 2}"
        )
        self._raw = await self._conn.fetch(sql, *self._params, self._limit, self._offset)

    def get_result(self) -> dict:
        """
        Build the ``{rows, totalCount}`` payload, lifting ``__total`` off the rows.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``{"rows": [...], "totalCount": int}`` with wire-mapped scalar values.
        """
        records = [dict(r) for r in self._rows()]
        total = int(records[0]["__total"]) if records else 0

        for r in records:
            r.pop("__total", None)

        return {"rows": rows_to_wire(records, self._columns), "totalCount": total}
