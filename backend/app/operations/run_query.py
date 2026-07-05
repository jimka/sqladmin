"""
RunQueryCommand — execute one arbitrary SQL statement, returning either a row
result set (any SELECT / RETURNING) or a status line (INSERT/UPDATE/DDL).

A query panel submits opaque SQL: it is deliberately NOT parameterized and its
identifiers are NOT validated — arbitrary SQL on the trusted "default"
connection is the feature, not a hole. Exactly one statement runs per call:
asyncpg's prepared-statement path uses the PostgreSQL extended query protocol,
which rejects a ``;``-separated multi-statement script with a
``PostgresSyntaxError`` (surfaced as 400 by the app's error handler) — so the
single-statement rule needs no explicit check.
"""

from __future__ import annotations

from typing import Any, Sequence

import asyncpg

from ..contract import ColumnMeta, WireType
from ..errors import ValidationError
from ..wire import pg_type_to_wire, rows_to_wire
from .base import Command


# The ad-hoc query result cap. A rows-returning statement is read through a
# server-side cursor that fetches at most this many rows (plus one, to detect
# truncation), so an unbounded SELECT (e.g. ``SELECT * FROM huge_table``) never
# materializes fully server- or client-side — the ad-hoc query panel is not
# paginated, so the bound belongs here. Mirrors the list-rows page-size ceiling.
MAX_RESULT_ROWS = 1000


def _query_columns(attrs: Sequence[Any]) -> list[dict]:
    """
    Turn asyncpg result attributes into ``{name, wireType}`` contract columns.

    Each attribute's pg_catalog short type name (``attr.type.name`` — e.g.
    ``int4``, ``bool``, ``timestamptz``) is mapped through ``pg_type_to_wire``;
    the emitted ``wireType`` is the string value (matching ``ColumnMeta``'s own
    serialization). Empty/unnamed (``?column?``) or duplicate result-column
    names are disambiguated to stable unique names (``column``, ``column_2``, …)
    so the frontend model's field names never collide.

    Args:
        attrs: the prepared statement's attribute descriptors (one per column).

    Returns:
        One ``{"name": str, "wireType": str}`` per attribute, in order.
    """
    used: set[str] = set()
    columns: list[dict] = []

    for attr in attrs:
        raw = getattr(attr, "name", None)
        base = raw if raw and raw != "?column?" else "column"
        name = base
        n = 1

        while name in used:
            n += 1
            name = f"{base}_{n}"

        used.add(name)
        columns.append({"name": name, "wireType": pg_type_to_wire(attr.type.name).value})

    return columns


def _as_colmeta(columns: list[dict]) -> list[ColumnMeta]:
    """
    Adapt ``{name, wireType}`` dicts into the ``ColumnMeta`` instances
    ``rows_to_wire`` keys on. A query result carries no introspection metadata,
    so every field other than ``name``/``wire_type`` gets an inert default;
    only those two affect the value mapping.

    Args:
        columns: the ``{name, wireType}`` columns from :func:`_query_columns`.

    Returns:
        One ``ColumnMeta`` per column.
    """
    return [
        ColumnMeta(
            name=c["name"],
            data_type="",
            nullable=True,
            is_primary_key=False,
            is_generated=False,
            has_default=False,
            wire_type=WireType(c["wireType"]),
        )
        for c in columns
    ]


def _affected(status: str | None) -> int:
    """
    Parse the affected-row count off a command tag.

    ``"INSERT 0 3"`` -> 3, ``"UPDATE 5"`` -> 5, ``"CREATE TABLE"`` -> 0,
    ``None``/``""`` -> 0.

    Args:
        status: the asyncpg command status tag, or None.

    Returns:
        The trailing integer of the tag, or 0 when there is none.
    """
    if not status:
        return 0

    last = status.rsplit(" ", 1)[-1]

    return int(last) if last.isdigit() else 0


class RunQueryCommand(Command):
    """
    Run one arbitrary SQL statement and classify its result.
    """

    def __init__(self, conn: asyncpg.Connection, sql: str) -> None:
        """
        Capture the statement, rejecting an empty one before any I/O.

        Args:
            conn: the connection the statement will run on.
            sql: the raw SQL to execute (exactly one statement).

        Raises:
            ValidationError: if the SQL is empty or whitespace-only.
        """
        if not sql or not sql.strip():
            raise ValidationError("Empty SQL statement")

        self._conn: asyncpg.Connection = conn
        self._sql: str = sql
        self._attrs: Sequence[Any] | None = None
        self._records: Sequence[Any] | None = None
        self._status: str | None = None

    async def apply(self) -> None:
        """
        Prepare and run the statement in a transaction, capturing the column
        description, the (capped) rows, and the command status tag.

        A rows-returning statement is read through a server-side cursor that
        fetches at most ``MAX_RESULT_ROWS + 1`` rows: the cursor never
        materializes a huge result set, and the extra row lets ``get_result``
        report truncation without a second COUNT. A non-row statement
        (INSERT/UPDATE/DDL) is executed for its status tag.
        """
        async with self._conn.transaction():
            stmt = await self._conn.prepare(self._sql)
            self._attrs = stmt.get_attributes()

            if self._attrs:
                cursor = await stmt.cursor()
                self._records = await cursor.fetch(MAX_RESULT_ROWS + 1)
            else:
                await stmt.fetch()

            self._status = stmt.get_statusmsg()

    def get_result(self) -> dict:
        """
        Classify the raw result: a column description means a rows envelope, its
        absence a status envelope.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``{"kind": "rows", "columns", "rows", "rowCount", "truncated"}`` for a
            statement that returned a result set (even an empty one) — ``truncated``
            is ``True`` when the result exceeded ``MAX_RESULT_ROWS`` and only the
            first ``MAX_RESULT_ROWS`` rows are returned — or
            ``{"kind": "status", "command", "rowCount"}`` otherwise.
        """
        if self._attrs is None:
            raise RuntimeError("get_result() called before apply()")

        if self._attrs:
            columns = _query_columns(self._attrs)
            names   = [c["name"] for c in columns]

            # apply() fetches one past the cap; a full extra row means the result
            # was truncated. Keep only the capped rows for the wire.
            fetched   = self._records or []
            truncated = len(fetched) > MAX_RESULT_ROWS
            kept      = fetched[:MAX_RESULT_ROWS]

            # Build each row positionally against the de-duplicated names. asyncpg
            # collapses duplicate/unnamed keys under dict(record) (last wins), which
            # would drop a value and leave a renamed column (e.g. column_2) matching
            # no key; indexing by position keeps every column's value.
            raw_rows = [
                {names[i]: record[i] for i in range(len(names))}
                for record in kept
            ]
            rows = rows_to_wire(raw_rows, _as_colmeta(columns))

            return {
                "kind": "rows",
                "columns": columns,
                "rows": rows,
                "rowCount": len(rows),
                "truncated": truncated,
            }

        return {"kind": "status", "command": self._status or "", "rowCount": _affected(self._status)}
