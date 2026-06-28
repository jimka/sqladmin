"""
Pure wire-mapping tests: pg_type_to_wire, to_wire_value, rows_to_wire.
"""

from __future__ import annotations

import base64
import datetime
import decimal

import pytest

from app.contract import WireType
from app.wire import pg_type_to_wire, rows_to_wire, to_wire_value
from tests.conftest import col


@pytest.mark.parametrize(
    "pg,expected",
    [
        ("integer", WireType.NUMBER),
        ("bigint", WireType.NUMBER),
        ("double precision", WireType.NUMBER),
        ("numeric", WireType.STRING),
        ("text", WireType.STRING),
        ("character varying", WireType.STRING),
        ("uuid", WireType.STRING),
        ("boolean", WireType.BOOLEAN),
        ("timestamp with time zone", WireType.ISO_STRING),
        ("date", WireType.ISO_STRING),
        ("json", WireType.JSON),
        ("jsonb", WireType.JSON),
        ("bytea", WireType.BASE64),
        ("ARRAY", WireType.JSON_ARRAY),
        ("something_unknown", WireType.STRING),
    ],
)
def test_pg_type_to_wire(pg: str, expected: WireType) -> None:
    assert pg_type_to_wire(pg) is expected


def test_none_passes_through_for_every_type() -> None:
    for wt in WireType:
        assert to_wire_value(None, wt) is None


def test_numeric_to_precision_string() -> None:
    assert to_wire_value(decimal.Decimal("1240.50"), WireType.STRING) == "1240.50"


def test_number_passthrough() -> None:
    assert to_wire_value(42, WireType.NUMBER) == 42


def test_boolean() -> None:
    assert to_wire_value(True, WireType.BOOLEAN) is True


def test_datetime_to_iso() -> None:
    dt = datetime.datetime(2026, 6, 28, 12, 0, 0)

    assert to_wire_value(dt, WireType.ISO_STRING) == "2026-06-28T12:00:00"


def test_bytea_to_base64() -> None:
    assert to_wire_value(b"hi", WireType.BASE64) == base64.b64encode(b"hi").decode()


def test_json_passthrough() -> None:
    obj = {"a": [1, 2]}

    assert to_wire_value(obj, WireType.JSON) is obj


def test_array_makes_nested_values_jsonable() -> None:
    arr = [decimal.Decimal("1.5"), datetime.date(2026, 1, 1)]

    assert to_wire_value(arr, WireType.JSON_ARRAY) == ["1.5", "2026-01-01"]


def test_rows_to_wire_maps_each_column() -> None:
    cols = [col("id", WireType.NUMBER), col("balance", WireType.STRING)]
    rows = [{"id": 1, "balance": decimal.Decimal("9.99")}]

    assert rows_to_wire(rows, cols) == [{"id": 1, "balance": "9.99"}]


def test_rows_to_wire_unknown_column_defaults_to_string() -> None:
    rows = [{"extra": 5}]

    assert rows_to_wire(rows, []) == [{"extra": "5"}]
