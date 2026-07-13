"""
SequenceDetailQuery — a sequence's current state and parameters, via
``pg_catalog.pg_sequences``.

The sequence is located by schema + name and read from ``pg_sequences``
(PostgreSQL 10+), which already carries the owner and data type — no join
to ``pg_type``/``pg_get_userbyid`` is needed. Both identifiers are bound as
query parameters (``$1``/``$2``), never interpolated, so no identifier
quoting is needed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from ..contract import TableRef
from ..errors import NotFound
from .base import Query


class SequenceDetailQuery(Query):
    """
    Fetch a sequence's state and parameters from ``pg_sequences``.
    """

    _SQL = (
        "SELECT sequenceowner AS owner, "
        "data_type::text AS data_type, "
        "start_value, min_value, max_value, "
        "increment_by, cache_size, cycle, last_value "
        "FROM pg_catalog.pg_sequences "
        "WHERE schemaname = $1 AND sequencename = $2"
    )

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the sequence to introspect.
        """
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the detail row (zero or one row) for the sequence.
        """
        self._raw = await self._conn.fetch(self._SQL, self._table.schema, self._table.name)

    def get_result(self) -> dict:
        """
        Return the sequence's current state and parameters.

        Raises:
            RuntimeError: if called before ``apply()``.
            NotFound: if no sequence by that name exists.

        Returns:
            ``{lastValue, startValue, minValue, maxValue, increment,
            cacheSize, cycle, dataType, owner}`` — every ``bigint`` column
            stringified to preserve full precision (a default ``max_value``
            of ``9223372036854775807`` exceeds ``Number.MAX_SAFE_INTEGER``);
            ``lastValue`` is ``None`` when the sequence was never read or the
            role lacks ``USAGE``/``SELECT`` on it.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        if not self._raw:
            raise NotFound(f"Sequence '{self._table.schema}.{self._table.name}' not found")

        row = self._raw[0]
        last_value = row["last_value"]

        return {
            "lastValue": str(last_value) if last_value is not None else None,
            "startValue": str(row["start_value"]),
            "minValue": str(row["min_value"]),
            "maxValue": str(row["max_value"]),
            "increment": str(row["increment_by"]),
            "cacheSize": str(row["cache_size"]),
            "cycle": row["cycle"],
            "dataType": row["data_type"],
            "owner": row["owner"],
        }
