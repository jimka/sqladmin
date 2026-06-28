"""
UpdateRowCommand: constructor validation and get_result() transform.
"""

from __future__ import annotations

import decimal

import pytest

from app.errors import ValidationError
from app.operations import UpdateRowCommand
from tests.conftest import NO_CONN, ROW_COLS, TABLE


def test_unknown_column_raises() -> None:
    with pytest.raises(ValidationError):
        UpdateRowCommand(NO_CONN,TABLE, 1, {"ghost": 1}, ROW_COLS)


def test_only_pk_supplied_raises() -> None:
    with pytest.raises(ValidationError):
        UpdateRowCommand(NO_CONN,TABLE, 1, {"id": 1}, ROW_COLS)


def test_get_result_maps_scalars() -> None:
    op = UpdateRowCommand(NO_CONN,TABLE, 1, {"balance": "9.99"}, ROW_COLS)
    op._raw = {"id": 1, "name": "Ada", "balance": decimal.Decimal("9.99")}

    assert op.get_result()["balance"] == "9.99"
