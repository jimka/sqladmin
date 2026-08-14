"""
Pure wire-mapping tests: pg_type_to_wire, to_wire_value, rows_to_wire.
"""

from __future__ import annotations

import base64
import datetime
import decimal

import pytest

import uuid

from app.contract import WireType
from app.wire import from_wire_filter_operand, from_wire_value, pg_type_to_wire, rows_to_wire, to_wire_value
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


def test_from_wire_none_passes_through() -> None:
    assert from_wire_value(None, col("x", WireType.ISO_STRING, data_type="date")) is None


def test_from_wire_number_and_boolean_pass_through() -> None:
    assert from_wire_value(42, col("n", WireType.NUMBER, data_type="integer")) == 42
    assert from_wire_value(True, col("b", WireType.BOOLEAN, data_type="boolean")) is True


def test_from_wire_text_passes_through() -> None:
    assert from_wire_value("hi", col("t", WireType.STRING, data_type="text")) == "hi"


def test_from_wire_numeric_string_to_decimal() -> None:
    result = from_wire_value("1240.50", col("balance", WireType.STRING, data_type="numeric"))

    assert result == decimal.Decimal("1240.50")
    assert isinstance(result, decimal.Decimal)


def test_from_wire_uuid_string_to_uuid() -> None:
    text = "12345678-1234-5678-1234-567812345678"
    result = from_wire_value(text, col("uid", WireType.STRING, data_type="uuid"))

    assert result == uuid.UUID(text)


def test_from_wire_timestamptz_parses_js_z_suffix() -> None:
    # JS Date.toISOString() emits a trailing 'Z'; Python 3.10 fromisoformat
    # cannot parse it, so the mapping must normalise it to a UTC offset.
    result = from_wire_value(
        "2026-06-28T12:04:59.110Z",
        col("created_at", WireType.ISO_STRING, data_type="timestamp with time zone"),
    )

    assert result == datetime.datetime(
        2026, 6, 28, 12, 4, 59, 110000, tzinfo=datetime.timezone.utc
    )


def test_from_wire_timestamp_without_tz() -> None:
    result = from_wire_value(
        "2026-06-28T12:04:59",
        col("ts", WireType.ISO_STRING, data_type="timestamp without time zone"),
    )

    assert result == datetime.datetime(2026, 6, 28, 12, 4, 59)


def test_from_wire_date_and_time() -> None:
    assert from_wire_value(
        "2026-06-28", col("d", WireType.ISO_STRING, data_type="date")
    ) == datetime.date(2026, 6, 28)
    assert from_wire_value(
        "12:04:59", col("t", WireType.ISO_STRING, data_type="time without time zone")
    ) == datetime.time(12, 4, 59)


def test_from_wire_date_accepts_full_datetime_string() -> None:
    # A date column whose value arrived as a full ISO datetime keeps just the date.
    assert from_wire_value(
        "2026-06-28T12:04:59.110Z", col("d", WireType.ISO_STRING, data_type="date")
    ) == datetime.date(2026, 6, 28)


def test_from_wire_base64_to_bytes() -> None:
    encoded = base64.b64encode(b"hi").decode()

    assert from_wire_value(encoded, col("blob", WireType.BASE64, data_type="bytea")) == b"hi"


def test_from_wire_json_to_text() -> None:
    # asyncpg binds json/jsonb columns from a JSON text string.
    assert from_wire_value({"a": 1}, col("doc", WireType.JSON, data_type="jsonb")) == '{"a": 1}'


UTC = datetime.timezone.utc


@pytest.mark.parametrize(
    "data_type,wire_value,expected",
    [
        ("timestamp with time zone", "2026-06-28T12:04:00.000Z", datetime.datetime(2026, 6, 28, 12, 4, tzinfo=UTC)),
        ("timestamp without time zone", "2026-06-28T12:04:00.000Z", datetime.datetime(2026, 6, 28, 12, 4)),
        ("date", "2026-06-28T00:00:00.000Z", datetime.datetime(2026, 6, 28, 0, 0)),
        ("time without time zone", "1970-01-01T09:30:00.000Z", datetime.time(9, 30)),
        ("time with time zone", "1970-01-01T09:30:00.000Z", datetime.time(9, 30, tzinfo=UTC)),
    ],
)
def test_from_wire_filter_operand_temporal_types(data_type: str, wire_value: str, expected: object) -> None:
    column = col("t", WireType.ISO_STRING, data_type=data_type)

    assert from_wire_filter_operand(wire_value, column) == expected


def test_from_wire_filter_operand_date_keeps_time_of_day() -> None:
    # A `date` column's operand is compared as an instant, not truncated to a
    # day -- see FilterCompiler's `::timestamp` cast.
    result = from_wire_filter_operand("2026-06-28T12:04:59.110Z", col("d", WireType.ISO_STRING, data_type="date"))

    assert result == datetime.datetime(2026, 6, 28, 12, 4, 59, 110000)
    assert result.tzinfo is None


def test_from_wire_filter_operand_timestamptz_normalizes_to_utc() -> None:
    result = from_wire_filter_operand(
        "2026-06-28T14:04:00+02:00",
        col("created_at", WireType.ISO_STRING, data_type="timestamp with time zone"),
    )

    assert result == datetime.datetime(2026, 6, 28, 12, 4, tzinfo=UTC)


def test_from_wire_filter_operand_time_without_tz_is_naive() -> None:
    result = from_wire_filter_operand(
        "1970-01-01T09:30:00.000Z", col("opens_at", WireType.ISO_STRING, data_type="time without time zone")
    )

    assert result == datetime.time(9, 30)
    assert result.tzinfo is None


def test_from_wire_filter_operand_time_with_tz_is_aware() -> None:
    result = from_wire_filter_operand(
        "1970-01-01T09:30:00.000Z", col("opens_at", WireType.ISO_STRING, data_type="time with time zone")
    )

    assert result == datetime.time(9, 30, tzinfo=UTC)


@pytest.mark.parametrize(
    "wire_type,data_type,value",
    [
        (WireType.NUMBER, "integer", 10),
        (WireType.BOOLEAN, "boolean", True),
        (WireType.STRING, "text", "ada"),
        (WireType.STRING, "uuid", "1234"),
        (WireType.STRING, "numeric", "10"),
    ],
)
def test_from_wire_filter_operand_passes_non_temporal_columns_through(
    wire_type: WireType, data_type: str, value: object
) -> None:
    # Regression guard: from_wire_filter_operand must NOT reuse
    # from_wire_value's write-path coercion, which would reject a partial
    # uuid or over-narrow a numeric string to Decimal.
    result = from_wire_filter_operand(value, col("x", wire_type, data_type=data_type))

    assert result == value
    assert type(result) is type(value)


def test_from_wire_filter_operand_none_on_temporal_column_returns_none() -> None:
    assert from_wire_filter_operand(None, col("d", WireType.ISO_STRING, data_type="date")) is None


def test_from_wire_filter_operand_non_string_on_temporal_column_passes_through() -> None:
    assert from_wire_filter_operand(10, col("d", WireType.ISO_STRING, data_type="date")) == 10


def test_from_wire_filter_operand_unparseable_text_raises_value_error() -> None:
    with pytest.raises(ValueError):
        from_wire_filter_operand("not-a-date", col("d", WireType.ISO_STRING, data_type="date"))
