"""
SequenceDetailQuery — a sequence's current state, parameters, and owning
column, via ``pg_catalog.pg_sequences``.

The sequence is located by schema + name and read from ``pg_sequences``
(PostgreSQL 10+), which already carries the owning ROLE and data type — no
join to ``pg_type``/``pg_get_userbyid`` is needed. It does not, however,
expose the owning COLUMN (``ALTER SEQUENCE ... OWNED BY``), so that one
relation comes from a ``pg_depend`` lateral. Both identifiers are bound as
query parameters (``$1``/``$2``), never interpolated, so no identifier
quoting is needed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from ..contract import SequenceOwnedBy, TableRef
from ..errors import NotFound
from .base import Query


class SequenceDetailQuery(Query):
    """
    Fetch a sequence's state and parameters from ``pg_sequences``.
    """

    # The owning-column lateral MUST be a LEFT JOIN: a standalone sequence has
    # no owner, and an inner join would drop its row entirely — which
    # get_result()'s NotFound-on-empty guard would then report as a 404 for
    # every ownerless sequence.
    #
    # This is the reverse of arm (a) in ListColumnsQuery, and ownership only:
    # a sequence merely referenced by some column's DEFAULT is not OWNED BY it,
    # so the two directions are deliberately not inverses. A sequence has at
    # most one owning column (a second OWNED BY replaces the first).
    _SQL = """
        SELECT s.sequenceowner AS owner,
               s.data_type::text AS data_type,
               s.start_value, s.min_value, s.max_value,
               s.increment_by, s.cache_size, s.cycle, s.last_value,
               ow.table_schema AS owned_by_schema,
               ow.table_name   AS owned_by_table,
               ow.column_name  AS owned_by_column
        FROM pg_catalog.pg_sequences s
        LEFT JOIN LATERAL (
            SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name
            FROM pg_catalog.pg_class sq
            JOIN pg_catalog.pg_namespace sn ON sn.oid = sq.relnamespace
            JOIN pg_catalog.pg_depend d     ON d.objid = sq.oid
            JOIN pg_catalog.pg_class c      ON c.oid = d.refobjid
            JOIN pg_catalog.pg_namespace n  ON n.oid = c.relnamespace
            JOIN pg_catalog.pg_attribute a  ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
            WHERE sq.relkind = 'S'
              AND sn.nspname = s.schemaname AND sq.relname = s.sequencename
              AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
              AND d.deptype IN ('a', 'i') AND d.refobjsubid > 0
        ) ow ON true
        WHERE s.schemaname = $1 AND s.sequencename = $2
    """

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
            cacheSize, cycle, dataType, owner, ownedBy}`` — every ``bigint``
            column stringified to preserve full precision (a default
            ``max_value`` of ``9223372036854775807`` exceeds
            ``Number.MAX_SAFE_INTEGER``); ``lastValue`` is ``None`` when the
            sequence was never read or the role lacks ``USAGE``/``SELECT`` on
            it, and ``ownedBy`` is ``None`` for a standalone sequence.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        if not self._raw:
            raise NotFound(f"Sequence '{self._table.schema}.{self._table.name}' not found")

        row = self._raw[0]
        last_value = row["last_value"]
        owned_by_schema = row["owned_by_schema"]

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
            "ownedBy": (
                SequenceOwnedBy(
                    schema=owned_by_schema,
                    table=row["owned_by_table"],
                    column=row["owned_by_column"],
                ).to_contract()
                if owned_by_schema is not None
                else None
            ),
        }
