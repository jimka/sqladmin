"""
Helpers shared across the row operations.
"""

from __future__ import annotations

from ..contract import ColumnMeta, TableRef
from ..errors import ValidationError
from ..sql.compiler import quote_ident


def qualified(table: TableRef) -> str:
    """
    Return the schema-qualified, quoted table name for use in SQL.
    """
    return f"{quote_ident(table.schema)}.{quote_ident(table.name)}"


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
