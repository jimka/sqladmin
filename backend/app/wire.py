"""
Postgres/asyncpg -> wire-contract mapping.

Pure helpers:
  * ``pg_type_to_wire`` — at introspection time, picks the ``WireType`` a column's
    values will arrive as (recorded in ``ColumnMeta.wire_type``).
  * ``rows_to_wire`` / ``to_wire_value`` — at read/write time, map each native
    asyncpg value into its contract scalar.
  * ``from_wire_value`` — the inverse, for a write payload's column values.
  * ``from_wire_filter_operand`` — maps a FILTER comparison operand to the
    Python value asyncpg binds, which for a temporal column differs from what
    ``from_wire_value`` binds for a write.

None touches a database, so all are trivially unit-testable.
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
# Case-insensitive text accepted for a BOOLEAN import cell (stripped first —
# see from_import_scalar). Mirrors no existing frontend list (the manual-edit
# path never types raw text into a boolean cell), so this is import-specific.
_TRUE_TEXT = frozenset({"true", "t", "1", "yes", "y"})
_FALSE_TEXT = frozenset({"false", "f", "0", "no", "n"})

# Subsets of the datetime family, used by from_wire_value to pick the Python
# temporal type (date / time / datetime) an ISO string is parsed into.
_DATE_TYPES = frozenset({"date"})
_TIME_TYPES = frozenset({"time", "time without time zone", "time with time zone", "timetz"})
# The two members of _TIME_TYPES that carry an offset. Checked BEFORE
# _TIME_TYPES, which contains them as well.
_TIMETZ_TYPES = frozenset({"time with time zone", "timetz"})
_TIMESTAMPTZ_TYPES = frozenset({"timestamp with time zone", "timestamptz"})


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


def from_import_scalar(raw: Any, column: ColumnMeta) -> Any:
    """
    Normalize one raw import-file value into the shape ``from_wire_value``
    already expects for ``column`` — the first of the two coercion steps a
    file-sourced row goes through (see ``import_rows.py``'s ``_coerce_row``).

    ``raw`` is whatever the client's JSON payload carries for one imported
    cell: always ``str | None`` for a CSV-sourced row (``parseImportFile``'s
    CSV branch never emits anything else), or any JSON-native scalar/object
    for a JSON-sourced row. This function does not know or care which file
    format produced ``raw`` — it dispatches purely on ``column.wire_type``
    and Python's own type of ``raw``. Some checks are deliberately left to
    ``from_wire_value``/the eventual INSERT rather than duplicated here: a
    numeric-as-string value's eventual ``Decimal(...)`` parse, a ``BASE64``
    value's eventual ``base64.b64decode``, and an ``ISO_STRING`` value's
    eventual date/time parse.

    Args:
        raw: the raw file value for one cell (``None`` for a SQL NULL).
        column: the target column, whose wire type selects the coercion.

    Raises:
        ValueError: ``raw``'s type or text cannot be coerced for
            ``column.wire_type`` (a non-numeric ``NUMBER`` string, an
            unrecognized ``BOOLEAN`` string, a non-string value for a type
            that only ever arrives as text, a non-array value for a
            ``JSON_ARRAY`` column, ...).

    Returns:
        The coerced value, wire-shaped for ``from_wire_value``.
    """
    if raw is None:
        return None

    wire_type = column.wire_type
    data_type = column.data_type.lower()

    if wire_type is WireType.NUMBER:
        if isinstance(raw, bool):
            raise ValueError("expected a number, got a boolean")

        if isinstance(raw, (int, float)):
            return raw

        if isinstance(raw, str):
            text = raw.strip()

            try:
                return int(text)
            except ValueError:
                return float(text)  # raises ValueError naturally if not numeric either

        raise ValueError(f"expected a number, got {raw!r}")

    if wire_type is WireType.STRING:
        if data_type in _NUMERIC_AS_STRING:
            if isinstance(raw, str):
                return raw

            if isinstance(raw, (int, float)) and not isinstance(raw, bool):
                return str(raw)

            raise ValueError(f"expected a numeric value, got {raw!r}")

        if data_type == "uuid":
            if isinstance(raw, str):
                return raw

            raise ValueError(f"expected a UUID string, got {raw!r}")

        # Plain text: a non-string scalar is accepted leniently (str(raw)),
        # matching a manual cell edit's own str() coercion; anything else
        # (a dict/list) is not.
        if isinstance(raw, str):
            return raw

        if isinstance(raw, (int, float, bool)):
            return str(raw)

        raise ValueError(f"expected text, got {raw!r}")

    if wire_type is WireType.BOOLEAN:
        if isinstance(raw, bool):
            return raw

        if isinstance(raw, str):
            text = raw.strip().lower()

            if text in _TRUE_TEXT:
                return True

            if text in _FALSE_TEXT:
                return False

        raise ValueError(f"expected a boolean, got {raw!r}")

    if wire_type is WireType.ISO_STRING:
        if isinstance(raw, str):
            return raw

        raise ValueError(f"expected an ISO-8601 string, got {raw!r}")

    if wire_type is WireType.JSON:
        if isinstance(raw, str):
            # A CSV cell's text for a JSON column is always the column's full
            # json.dumps() rendering (export_format.py's _csv_field), so this
            # succeeds for every well-formed CSV row. A JSON-sourced row,
            # however, may carry a jsonb column's own plain string value
            # directly (e.g. {"doc": "hello"} — "hello" is not itself valid
            # JSON) — from_import_scalar cannot tell the two apart (see its
            # docstring), so a parse failure here falls back to treating raw
            # as already the final scalar rather than raising, matching the
            # JSON-sourced case. This does mean a malformed CSV JSON cell (a
            # hand-edited file, unbalanced braces) is stored as a literal
            # jsonb string instead of rejected — an accepted trade-off, not a
            # silent data-loss risk, since jsonb can hold any scalar and the
            # alternative (rejecting every JSON-sourced plain string) is a
            # hard failure on the far more common case.
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return raw

        return raw  # dict/list/other JSON-native passthrough

    if wire_type is WireType.JSON_ARRAY:
        # Unlike JSON, no CSV/JSON-cell convention exists in this app to
        # invert for a Postgres array column (see the plan's Non-Goals):
        # from_wire_value has no JSON_ARRAY case of its own either, relying
        # on the value already being a native Python list, and there is no
        # per-element coercion here to turn e.g. a numeric[]/timestamp[]
        # column's array-literal text into correctly-typed elements. A
        # JSON-sourced row's array value already arrives as a native list and
        # passes through untouched; anything else — CSV text, or a
        # JSON-sourced value that isn't an array at all — is rejected rather
        # than guessed at.
        if isinstance(raw, list):
            return raw

        raise ValueError(f"array column: expected a JSON array value, got {raw!r}")

    if wire_type is WireType.BASE64:
        if isinstance(raw, str):
            return raw

        raise ValueError(f"expected a base64 string, got {raw!r}")

    return raw


def _to_utc(moment: datetime.datetime) -> datetime.datetime:
    """
    An aware datetime converted to UTC; a naive one returned unchanged (it
    carries no offset to convert).
    """
    return moment.astimezone(datetime.timezone.utc) if moment.tzinfo else moment


def from_wire_filter_operand(value: Any, column: ColumnMeta) -> Any:
    """
    Map one wire scalar to the Python value asyncpg binds for a FILTER
    comparison against ``column``.

    A temporal column's filter operand always arrives as a full ISO-8601
    instant: the grid's filter cell parses the typed text into a JS ``Date``,
    and ``JSON.stringify`` emits ``Date.toISOString()``. It is mapped to the
    Python type that keeps the comparison exact, which is NOT always the type
    ``from_wire_value`` binds for a write:

      * ``timestamp with time zone`` -> aware ``datetime`` (as for a write)
      * ``timestamp without time zone`` -> naive ``datetime``, the instant's
        UTC wall clock
      * ``date`` -> naive ``datetime``, NOT a ``date``: truncating would
        collapse the header row's minute-wide equality range to an empty one.
        ``FilterCompiler`` compares such a column as ``"col"::timestamp``.
      * ``time with time zone`` -> aware ``time``; the rest of the ``time``
        family -> naive ``time``

    Every non-temporal column returns ``value`` unchanged. Those operands are
    compared as text (``FilterCompiler._column`` casts the column), which is
    what lets a partial ``uuid`` or a plain-digit ``numeric`` operand match at
    all; ``from_wire_value``'s write-path coercion to ``UUID`` / ``Decimal``
    would reject or over-narrow it.

    Args:
        value: the wire scalar from the decoded ``filter=`` query param.
        column: the column the operand is compared against.

    Raises:
        ValueError: if the operand is not a parseable ISO-8601 instant.

    Returns:
        The Python value to bind for this comparison.
    """
    if column.wire_type is not WireType.ISO_STRING or not isinstance(value, str):
        return value

    moment = _to_utc(_parse_iso_datetime(value))
    data_type = column.data_type.lower()

    if data_type in _TIMETZ_TYPES:
        return moment.timetz()

    if data_type in _TIME_TYPES:
        return moment.replace(tzinfo=None).time()

    if data_type in _TIMESTAMPTZ_TYPES:
        return moment

    return moment.replace(tzinfo=None)


def rows_to_wire(rows: Iterable[dict], columns: list[ColumnMeta]) -> list[dict]:
    """
    Map every value in every row into its column's wire scalar.
    """
    by_name = {c.name: c.wire_type for c in columns}

    return [
        {k: to_wire_value(v, by_name.get(k, WireType.STRING)) for k, v in row.items()}
        for row in rows
    ]
