"""
PreviewImportRowsQuery / ImportRowsCommand — CSV/JSON row-import preview and
commit.

Two structurally different failure modes exist for one imported file:

  * A **structural** problem — a file column naming no real table column —
    is shared by every row, so it fails the whole preview/commit at
    construction time, before any row is coerced (see ``_coerce_row``, and
    ``PreviewImportRowsQuery.__init__``'s up-front key scan).
  * A **per-row data** problem — a value that fails to coerce for its
    column's type, or a NOT NULL column left empty — is independent per row:
    the preview reports it against that row's own ``ok``/``error`` entry
    while every other row is validated on its own merits (see
    ``_validate_row``).

The commit (``ImportRowsCommand``) reuses ``InsertRowCommand`` itself for
each row's actual INSERT, inside one outer transaction — an exception from
any row's nested transaction (asyncpg turns it into a SAVEPOINT) propagates
out and rolls back the whole batch, so no new SQL-building code is needed.
"""

from __future__ import annotations

import decimal
import json
from typing import Any

import asyncpg

from ..contract import ColumnMeta, TableRef
from ..errors import ValidationError
from ..wire import from_import_scalar, from_wire_value
from .base import Command, Query
from .common import is_required_column
from .insert_row import InsertRowCommand

# This app's established per-request row ceiling — matches run_query.py's
# MAX_RESULT_ROWS and list_rows.py's _MAX_PAGE_SIZE.
MAX_IMPORT_ROWS = 1000

# The coercion exceptions a bad cell value can raise, once the column itself
# is known to exist. Shared by _coerce_row (wraps them into a ValidationError
# naming the column) and _validate_row (catches them — already wrapped, or
# raised directly by the from_wire_value validation call below — to produce a
# per-row preview result instead of failing the whole request).
_COERCION_ERRORS = (ValueError, decimal.InvalidOperation, json.JSONDecodeError)


def _coerce_row(raw: dict, by_name: dict[str, ColumnMeta]) -> dict:
    """
    Map one raw import row to a wire-shaped dict ``InsertRowCommand`` accepts.

    Drops any key naming a generated column (mirrors ``SqlAdminWriter.strip()``
    on the frontend) rather than rejecting it — this is what lets importing
    this app's own CSV/JSON export of a table (which includes the generated
    PK via ``SELECT *``) work without the user hand-editing the file first.

    Args:
        raw: one row's raw file values, keyed by file column name.
        by_name: the target table's columns, keyed by name.

    Raises:
        ValidationError: a key names no real column, or a value fails to
            coerce (the message names the offending column).

    Returns:
        The row's wire-shaped values, ready for ``InsertRowCommand``.
    """
    wire_row: dict[str, Any] = {}

    for k, v in raw.items():
        column = by_name.get(k)

        if column is None:
            raise ValidationError(f"Unknown column '{k}'")

        if column.is_generated:
            continue

        try:
            wire_row[k] = from_import_scalar(v, column)
        except _COERCION_ERRORS as e:
            raise ValidationError(f"{k}: {e}")

    return wire_row


def _validate_row(
    row_number: int, raw: dict, by_name: dict[str, ColumnMeta], columns: list[ColumnMeta]
) -> dict:
    """
    Coerce and fully validate one preview row: coercion (``_coerce_row``),
    then a ``from_wire_value`` dry run (catches a value ``_coerce_row``
    itself defers, e.g. bad ISO/Decimal/UUID text), then a required-column
    sweep. Any failure at any of these steps is this row's own soft failure
    — it never aborts the rows around it.

    Args:
        row_number: the row's 1-based position, echoed into the result.
        raw: the row's raw file values, keyed by file column name.
        by_name: the target table's columns, keyed by name.
        columns: the target table's columns, in table order (for the
            required-column sweep).

    Returns:
        ``{"rowNumber", "ok": True, "values": wire_row}`` on success, or
        ``{"rowNumber", "ok": False, "error": str}`` on any failure above.
    """
    try:
        wire_row = _coerce_row(raw, by_name)

        # Purely to validate it doesn't raise — from_wire_value's native-Python
        # return value is discarded, since the wire-shaped value _coerce_row
        # already produced is what a successful preview result sends back.
        for k, v in wire_row.items():
            from_wire_value(v, by_name[k])

        missing = [
            c.name for c in columns
            if is_required_column(c) and (c.name not in wire_row or wire_row[c.name] is None)
        ]

        if missing:
            raise ValidationError(f"Missing required column(s): {', '.join(missing)}")
    except ValidationError as e:
        return {"rowNumber": row_number, "ok": False, "error": e.detail}
    except _COERCION_ERRORS as e:
        return {"rowNumber": row_number, "ok": False, "error": str(e)}

    return {"rowNumber": row_number, "ok": True, "values": wire_row}


class PreviewImportRowsQuery(Query):
    """
    Validate every row of a proposed import without touching the database —
    mirrors ``DdlPreview``'s no-I/O ``apply()`` (see ``ddl.py``).
    """

    def __init__(self, table: TableRef, rows: list[dict], columns: list[ColumnMeta]) -> None:
        """
        Reject an oversized payload, then an unknown column name — both are
        structural problems shared by every row, so both fail construction
        entirely rather than surfacing as a per-row preview result (unlike a
        bad cell value or a missing required column, which are each row's own
        concern — see ``_validate_row``, run later in ``apply()``).

        Args:
            table: the target table (not read here — carried for symmetry
                with ``ImportRowsCommand`` and future use; preview needs no I/O).
            rows: the raw file rows to validate.
            columns: the table's introspected columns.

        Raises:
            ValidationError: ``rows`` exceeds ``MAX_IMPORT_ROWS``, or any row
                has a key naming no real column.
        """
        if len(rows) > MAX_IMPORT_ROWS:
            raise ValidationError(f"Import is limited to {MAX_IMPORT_ROWS} rows (got {len(rows)})")

        by_name = {c.name: c for c in columns}
        unknown = sorted({k for raw in rows for k in raw if k not in by_name})

        if unknown:
            raise ValidationError(f"Unknown column(s): {', '.join(unknown)}")

        self._table: TableRef = table
        self._rows: list[dict] = rows
        self._columns: list[ColumnMeta] = columns
        self._by_name: dict[str, ColumnMeta] = by_name
        self._result: dict | None = None

    async def apply(self) -> None:
        """
        Validate every row — no I/O, so this never awaits anything; still
        ``async`` to satisfy the ``Operation`` contract (mirrors ``DdlPreview``).
        """
        results = [
            _validate_row(i + 1, raw, self._by_name, self._columns)
            for i, raw in enumerate(self._rows)
        ]
        error_rows = sum(1 for r in results if not r["ok"])

        self._result = {"rows": results, "totalRows": len(self._rows), "errorRows": error_rows}

    def get_result(self) -> dict:
        """
        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``{"rows": [...], "totalRows": int, "errorRows": int}``.
        """
        if self._result is None:
            raise RuntimeError("get_result() called before apply()")

        return self._result


class ImportRowsCommand(Command):
    """
    Insert every row of a validated import in one transaction, by
    constructing and applying one ``InsertRowCommand`` per row — reusing it
    rather than building new INSERT SQL (see the module docstring).
    """

    def __init__(
        self, conn: asyncpg.Connection, table: TableRef, rows: list[dict], columns: list[ColumnMeta],
    ) -> None:
        """
        Reject an oversized payload, then coerce every row up front — so an
        unknown column or a bad value fails before any INSERT runs, not
        mid-batch.

        Args:
            conn: the connection every row's insert will run on.
            table: the table to insert into.
            rows: the raw file rows to import.
            columns: the table's introspected columns.

        Raises:
            ValidationError: ``rows`` exceeds ``MAX_IMPORT_ROWS``, a key names
                no real column, or a value fails to coerce.
        """
        if len(rows) > MAX_IMPORT_ROWS:
            raise ValidationError(f"Import is limited to {MAX_IMPORT_ROWS} rows (got {len(rows)})")

        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._columns: list[ColumnMeta] = columns
        by_name = {c.name: c for c in columns}
        self._wire_rows: list[dict] = [_coerce_row(raw, by_name) for raw in rows]
        self._inserted: int | None = None

    async def apply(self) -> None:
        """
        Insert every row inside one outer transaction. ``InsertRowCommand
        .apply()``'s own ``async with self._conn.transaction()``, opened while
        already inside this one, becomes a SAVEPOINT (asyncpg's documented
        nested-transaction behavior) — an exception from any row re-raises out
        of it uncaught, rolling back every row inserted before it too.
        """
        async with self._conn.transaction():
            for wire_row in self._wire_rows:
                op = InsertRowCommand(self._conn, self._table, wire_row, self._columns)
                await op.apply()

            self._inserted = len(self._wire_rows)

    def get_result(self) -> dict:
        """
        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``{"insertedCount": N}``.
        """
        if self._inserted is None:
            raise RuntimeError("get_result() called before apply()")

        return {"insertedCount": self._inserted}
