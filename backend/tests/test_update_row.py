"""
UpdateRowCommand: constructor validation and get_result() transform.
"""

from __future__ import annotations

import datetime
import decimal

import pytest

from app.contract import WireType
from app.errors import ValidationError
from app.operations import UpdateRowCommand
from tests.conftest import NO_CONN, ROW_COLS, TABLE, col


def test_unknown_column_raises() -> None:
    with pytest.raises(ValidationError):
        UpdateRowCommand(NO_CONN,TABLE, 1, {"ghost": 1}, ROW_COLS)


def test_only_pk_supplied_raises() -> None:
    with pytest.raises(ValidationError):
        UpdateRowCommand(NO_CONN,TABLE, 1, {"id": 1}, ROW_COLS)


def test_partial_payload_assigns_only_its_columns() -> None:
    # SqlAdminWriter sends only the changed fields plus the primary key on an
    # update; the key is skipped and every other column is left alone.
    op = UpdateRowCommand(NO_CONN, TABLE, 1, {"name": "Grace", "id": 1}, ROW_COLS)

    assert op._assign == ["name"]
    assert op._values == ["Grace"]


def test_timestamp_value_binds_naive() -> None:
    columns = ROW_COLS + [col("logged_at", WireType.ISO_STRING, data_type="timestamp without time zone")]
    op = UpdateRowCommand(NO_CONN, TABLE, 1, {"logged_at": "2026-06-28T12:04:00.000Z", "id": 1}, columns)

    assert op._values == [datetime.datetime(2026, 6, 28, 12, 4)]
    assert op._values[0].tzinfo is None


def test_get_result_maps_scalars() -> None:
    op = UpdateRowCommand(NO_CONN,TABLE, 1, {"balance": "9.99"}, ROW_COLS)
    op._raw = {"id": 1, "name": "Ada", "balance": decimal.Decimal("9.99")}

    assert op.get_result()["balance"] == "9.99"
