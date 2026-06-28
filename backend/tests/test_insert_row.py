"""
InsertRowCommand: constructor validation, get_result() transform, temporal guard.
"""

from __future__ import annotations

import decimal

import pytest

from app.errors import ValidationError
from app.operations import InsertRowCommand
from tests.conftest import NO_CONN, ROW_COLS, TABLE


def test_unknown_column_raises() -> None:
    with pytest.raises(ValidationError):
        InsertRowCommand(NO_CONN,TABLE, {"ghost": 1}, ROW_COLS)


def test_get_result_maps_scalars() -> None:
    op = InsertRowCommand(NO_CONN,TABLE, {"name": "x", "balance": "5.00"}, ROW_COLS)
    op._raw = {"id": 7, "name": "x", "balance": decimal.Decimal("5.00")}

    assert op.get_result() == {"id": 7, "name": "x", "balance": "5.00"}


def test_get_result_before_apply_raises() -> None:
    op = InsertRowCommand(NO_CONN,TABLE, {"name": "x"}, ROW_COLS)

    with pytest.raises(RuntimeError):
        op.get_result()
