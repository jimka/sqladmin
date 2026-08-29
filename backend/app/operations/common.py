"""
Helpers shared across the row and result-shaping operations.
"""

from __future__ import annotations

from ..contract import ColumnMeta, TableRef
from ..errors import ValidationError
from ..sql.compiler import quote_ident

# The app's one row-budget policy: the ad-hoc query result cap, the list-rows
# page-size ceiling, and the import row ceiling. One number because a
# request's row budget is one policy, not three independently-tuned ones.
MAX_ROWS_PER_REQUEST = 1000


def qualified(table: TableRef) -> str:
    """
    Return the schema-qualified, quoted table name for use in SQL.
    """
    return f"{quote_ident(table.schema)}.{quote_ident(table.name)}"


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
