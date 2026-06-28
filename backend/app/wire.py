"""
Postgres/asyncpg -> wire-contract mapping.

Two pure helpers:
  * ``pg_type_to_wire`` — at introspection time, picks the ``WireType`` a column's
    values will arrive as (recorded in ``ColumnMeta.wire_type``).
  * ``rows_to_wire`` / ``to_wire_value`` — at read/write time, map each native
    asyncpg value into its contract scalar.

Neither touches a database, so both are trivially unit-testable.
"""

from __future__ import annotations

import base64
import datetime
import decimal
import json
import uuid
from typing import Any, Iterable

from .contract import ColumnMeta, WireType

_NUMBER_TYPES = frozenset(
    {"smallint", "integer", "bigint", "real", "double precision", "double", "int", "int2", "int4", "int8", "float4", "float8"}
)
# numeric/decimal map to a precision-preserving STRING, not a float.
_NUMERIC_AS_STRING = frozenset({"numeric", "decimal", "money"})
_DATETIME_TYPES = frozenset(
    {
        "timestamp with time zone",
        "timestamp without time zone",
        "timestamp",
        "timestamptz",
        "date",
        "time with time zone",
        "time without time zone",
        "time",
        "timetz",
    }
)
_STRING_TYPES = frozenset(
    {"text", "character varying", "varchar", "character", "char", "bpchar", "name", "uuid", "citext"}
)
# Subsets of the datetime family, used by from_wire_value to pick the Python
# temporal type (date / time / datetime) an ISO string is parsed into.
_DATE_TYPES = frozenset({"date"})
_TIME_TYPES = frozenset({"time", "time without time zone", "time with time zone", "timetz"})


def pg_type_to_wire(data_type: str) -> WireType:
    """
    Map an ``information_schema`` Postgres type name to its wire scalar.

    Unknown types fall back to ``STRING`` so the wire stays well-formed.
    """
    dt = data_type.lower()

    if dt == "array" or dt.endswith("[]"):
        return WireType.JSON_ARRAY

    if dt in _NUMBER_TYPES:
        return WireType.NUMBER

    if dt in _NUMERIC_AS_STRING:
        return WireType.STRING

    if dt == "boolean" or dt == "bool":
        return WireType.BOOLEAN

    if dt in _DATETIME_TYPES:
        return WireType.ISO_STRING

    if dt in ("json", "jsonb"):
        return WireType.JSON

    if dt == "bytea":
        return WireType.BASE64

    if dt in _STRING_TYPES:
        return WireType.STRING

    return WireType.STRING


def _jsonable(value: Any) -> Any:
    """
    Recursively coerce a (possibly nested) array value into JSON-safe scalars.
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value

    if isinstance(value, decimal.Decimal):
        return str(value)

    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()

    if isinstance(value, uuid.UUID):
        return str(value)

    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")

    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]

    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}

    return str(value)


def to_wire_value(value: Any, wire_type: WireType) -> Any:
    """
    Map one native asyncpg value into its column's contract scalar.
    """
    if value is None:
        return None

    if wire_type is WireType.NUMBER:
        return value

    if wire_type is WireType.STRING:
        return str(value)

    if wire_type is WireType.BOOLEAN:
        return bool(value)

    if wire_type is WireType.ISO_STRING:
        return value.isoformat()

    if wire_type is WireType.JSON:
        # json/jsonb are decoded to Python objects by the connection codec.
        return value

    if wire_type is WireType.BASE64:
        return base64.b64encode(bytes(value)).decode("ascii")

    if wire_type is WireType.JSON_ARRAY:
        return _jsonable(value)

    return value


def _parse_iso_datetime(text: str) -> datetime.datetime:
    """
    Parse an ISO-8601 timestamp, normalising the JS ``Z`` suffix.

    ``datetime.fromisoformat`` only accepts a ``Z`` offset from Python 3.11, but
    ``Date.toISOString()`` always emits one, so it is rewritten to ``+00:00``.
    """
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"

    return datetime.datetime.fromisoformat(text)


def from_wire_value(value: Any, column: ColumnMeta) -> Any:
    """
    Map one wire scalar back to the Python value asyncpg binds for ``column``.

    This is the inverse of ``to_wire_value``, applied to incoming write payloads
    so a JSON string/number lands as the native type the column expects (an ISO
    string becomes a ``datetime``/``date``/``time``, a numeric string becomes a
    ``Decimal``, base64 becomes ``bytes``). Values that asyncpg already binds
    directly (numbers, booleans, plain text, arrays) pass through unchanged.

    Args:
        value: the wire scalar from the decoded JSON payload.
        column: the target column, whose wire and Postgres types pick the mapping.

    Returns:
        The Python value to bind for this column.
    """
    if value is None:
        return None

    wire_type = column.wire_type
    data_type = column.data_type.lower()

    if wire_type is WireType.ISO_STRING:
        if data_type in _DATE_TYPES:
            return datetime.date.fromisoformat(value[:10])

        if data_type in _TIME_TYPES:
            return datetime.time.fromisoformat(value)

        return _parse_iso_datetime(value)

    if wire_type is WireType.STRING:
        if data_type in _NUMERIC_AS_STRING:
            return decimal.Decimal(value)

        if data_type == "uuid":
            return uuid.UUID(value)

        return value

    if wire_type is WireType.JSON:
        return json.dumps(value)

    if wire_type is WireType.BASE64:
        return base64.b64decode(value)

    return value


def rows_to_wire(rows: Iterable[dict], columns: list[ColumnMeta]) -> list[dict]:
    """
    Map every value in every row into its column's wire scalar.
    """
    by_name = {c.name: c.wire_type for c in columns}

    return [
        {k: to_wire_value(v, by_name.get(k, WireType.STRING)) for k, v in row.items()}
        for row in rows
    ]
