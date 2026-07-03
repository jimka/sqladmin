"""
ExportRowsQuery — stream a relation's full contents as CSV or JSON.

A streaming export deliberately breaks the ``apply()``/``get_result()`` CQRS
split (buffering the whole relation would defeat streaming), so this operation
exposes ``stream()`` instead: it opens an asyncpg server-side cursor inside a
transaction and yields formatted chunks (header first, then one formatted record
per iteration) without ever materializing the relation in memory. The pure
formatters in ``export_format`` remain the testable core; only the cursor
iteration is I/O. The constructor still validates its inputs before any I/O,
preserving the "validate in ``__init__``" half of the contract.
"""

from __future__ import annotations

from typing import AsyncIterator

import asyncpg

from ..contract import ColumnMeta, TableRef
from ..errors import ValidationError
from ..export_format import csv_header, csv_row, json_close, json_open, json_row
from ..wire import rows_to_wire
from .base import Query
from .common import qualified

# The export formats this operation supports; anything else is a client error.
_VALID_FORMATS = frozenset({"csv", "json"})


class ExportRowsQuery(Query):
    """
    Stream a relation's full contents as CSV or JSON (server-side cursor).
    """

    def __init__(
        self,
        conn: asyncpg.Connection,
        table: TableRef,
        fmt: str,
        columns: list[ColumnMeta],
    ) -> None:
        """
        Validate the format before any I/O and hold the (already introspected)
        columns that drive the header, column order, and wire mapping.

        Args:
            conn: the connection the cursor will run on (kept alive across the stream).
            table: the validated relation to export (existence confirmed by the caller).
            fmt: the export format, "csv" or "json".
            columns: the relation's introspected columns.

        Raises:
            ValidationError: if ``fmt`` is not a supported format.
        """
        if fmt not in _VALID_FORMATS:
            raise ValidationError(f"Unsupported export format: {fmt!r} (expected csv or json)")

        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._fmt: str = fmt
        self._columns: list[ColumnMeta] = columns

    async def stream(self) -> AsyncIterator[str]:
        """
        Yield the export body chunk by chunk: the CSV header (or the JSON ``[``),
        then one formatted record per row read through a server-side cursor, then
        the JSON ``]``. Each raw row is wire-mapped so its scalars match the
        frontend dialect (numeric as its precision string, timestamptz as ISO,
        bytea as base64). No user value is interpolated — the SQL is a bare
        ``SELECT *`` over the validated, quoted relation.
        """
        if self._fmt == "csv":
            yield csv_header(self._columns)
        else:
            yield json_open()

        first = True

        # A server-side cursor must live inside a transaction; it fetches in
        # batches so the whole relation is never buffered in memory at once.
        async with self._conn.transaction():
            async for record in self._conn.cursor(f"SELECT * FROM {qualified(self._table)}"):
                wired = rows_to_wire([dict(record)], self._columns)[0]

                if self._fmt == "csv":
                    yield csv_row(wired, self._columns)
                else:
                    yield json_row(wired, self._columns, first)
                    first = False

        if self._fmt == "json":
            yield json_close()
