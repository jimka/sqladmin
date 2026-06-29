"""
Shared helpers for the pure-logic tests (no database).
"""

from __future__ import annotations

from typing import cast

import asyncpg

from app.contract import ColumnMeta, TableRef, WireType

# Stand-in connection for pure-logic tests that never touch the database. The
# operations require a real connection only in apply(); the phases under test
# (constructor validation, get_result) never use it.
NO_CONN = cast(asyncpg.Connection, None)


def col(
    name: str,
    wire: WireType = WireType.STRING,
    *,
    pk: bool = False,
    generated: bool = False,
    has_default: bool = False,
    data_type: str = "text",
) -> ColumnMeta:
    """
    Build a ``ColumnMeta`` for tests with sensible defaults.
    """
    return ColumnMeta(
        name=name,
        data_type=data_type,
        nullable=True,
        is_primary_key=pk,
        is_generated=generated,
        has_default=has_default,
        wire_type=wire,
    )


# Shared fixtures for the row-operation tests.
TABLE = TableRef("sqladmin", "public", "customers")
ROW_COLS = [
    col("id", WireType.NUMBER, pk=True, generated=True),
    col("name"),
    col("balance", WireType.STRING),
]
