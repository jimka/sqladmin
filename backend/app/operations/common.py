"""
Helpers shared across the operations: row and result shaping, and translating a
driver error raised by the client's own SQL into a positioned domain error.
"""

from __future__ import annotations

import contextlib
from typing import Iterator

import asyncpg

from ..contract import ColumnMeta, TableRef
from ..errors import ValidationError, from_postgres_error
from ..sql.ddl import qualify

# The app's one row-budget policy: the ad-hoc query result cap, the list-rows
# page-size ceiling, and the import row ceiling. One number because a
# request's row budget is one policy, not three independently-tuned ones.
MAX_ROWS_PER_REQUEST = 1000


def qualified(table: TableRef) -> str:
    """
    Return the schema-qualified, quoted table name for use in SQL.
    """
    return qualify(table.schema, table.name)


def affected(status: str | None) -> int:
    """
    Parse the affected-row count off a command tag.

    ``"INSERT 0 3"`` -> 3, ``"UPDATE 5"`` -> 5, ``"CREATE TABLE"`` -> 0,
    ``None``/``""`` -> 0.

    Args:
        status: the driver's command status tag, or None.

    Returns:
        The trailing integer of the tag, or 0 when there is none.
    """
    if not status:
        return 0

    last = status.rsplit(" ", 1)[-1]

    return int(last) if last.isdigit() else 0


def status_envelope(status: str | None) -> dict:
    """
    Build the status-result envelope a non-rows statement returns.

    Args:
        status: the driver's command tag, or None when the driver reported none.

    Returns:
        ``{"kind": "status", "command", "rowCount"}``.
    """
    return {"kind": "status", "command": status or "", "rowCount": affected(status)}


def single_pk(columns: list[ColumnMeta]) -> str:
    """
    Return the sole primary-key column name.

    Args:
        columns: the table's introspected columns.

    Raises:
        ValidationError: if the table has zero or several primary-key columns.

    Returns:
        The single primary-key column's name.
    """
    pks = [c.name for c in columns if c.is_primary_key]

    if len(pks) != 1:
        raise ValidationError(
            f"Table must have exactly one primary key column (found {len(pks)})"
        )

    return pks[0]


def is_required_column(column: ColumnMeta) -> bool:
    """
    Returns whether a column requires a user-supplied value on insert.

    Required = NOT NULL, not generated, and no DB default — mirrors the
    frontend's ``isRequiredColumn`` (``tableWriteRules.ts``), so a required
    column is flagged identically whether the value came from a manual grid
    edit or an imported row.
    """
    return not column.nullable and not column.is_generated and not column.has_default


def client_sql_position(exc: asyncpg.PostgresError, prefix_length: int = 0) -> int | None:
    """
    Read Postgres's error position off a driver error, relative to the client's SQL.

    Postgres counts from the start of the text it parsed, so a statement the
    operation prefixed (e.g. ``EXPLAIN (…) ``) is shifted back by the prefix.

    Args:
        exc: the error asyncpg raised.
        prefix_length: how many characters the operation prepended to the
            client's SQL before sending it.

    Returns:
        The 1-based character offset into the client's SQL, or None when the
        error has no position, it is not an integer, or it points into the prefix
        (text the client never wrote).
    """
    # asyncpg stores the protocol's 'P' field as a string.
    raw = getattr(exc, "position", None)

    if raw is None:
        return None

    try:
        shifted = int(raw) - prefix_length
    except (TypeError, ValueError):
        return None

    return shifted if shifted >= 1 else None


@contextlib.contextmanager
def client_sql_errors(prefix_length: int = 0) -> Iterator[None]:
    """
    Translate a driver error raised by the client's own SQL into the typed
    taxonomy, carrying the position Postgres reported.

    Wrap it around (outside) the operation's transaction, so the transaction
    rolls back on the original driver error before it is translated. Only
    ``asyncpg.PostgresError`` is caught; anything else propagates untouched.

    Args:
        prefix_length: how many characters the operation prepended to the
            client's SQL (see ``client_sql_position``).

    Raises:
        BadRequest: for a non-integrity driver error, chained from it.
        ConflictError: for an integrity/unique violation, chained from it.
    """
    try:
        yield
    except asyncpg.PostgresError as exc:
        raise from_postgres_error(exc, client_sql_position(exc, prefix_length)) from exc
