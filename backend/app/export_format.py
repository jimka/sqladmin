"""
The pure CSV/JSON export dialect, mirroring the frontend ``serialize.ts``.
Values fed to these formatters are already wire scalars (the operation runs each
raw asyncpg row through ``to_wire_value`` first), so a numeric is its precision
string, a timestamptz is ISO, a bytea is base64.

A streamed full-table CSV is byte-identical to a query-result CSV of the same
data for every wire type EXCEPT floating-point ``number`` values. This side sees
the native asyncpg float (``str(1.0) == "1.0"``, ``str(1e16) == "1e+16"``), while
the frontend's query rows have already crossed JSON transport and arrive as JS
numbers (``String(1) == "1"``, ``String(1e16) == "10000000000000000"``). That
loss is inherent to the query path, not this serializer, so this full-table
export is the authoritative full-fidelity surface; the string-based types
(numeric/decimal as precision strings, timestamps, bytea, booleans, and
non-float json — with ``ensure_ascii=False`` for raw UTF-8) stay byte-identical.

Neither function touches a database, so both are trivially unit-testable; only
the cursor iteration in ``ExportRowsQuery.stream`` is I/O.
"""

from __future__ import annotations

import json

from .contract import ColumnMeta, WireType

# The CSV dialect (RFC 4180): comma delimiter, CRLF record separator. Every line
# (the header included) is CRLF-terminated, matching serialize.ts.
_DELIM = ","
_EOL = "\r\n"


def _csv_field(value: object, wire_type: WireType) -> str:
    """
    Render one wire value to its escaped CSV field.

    A SQL ``None`` renders as a bare empty field; an empty string renders as a
    quoted ``""`` so the two stay distinguishable. A field containing the
    delimiter, a quote, a CR, or an LF is quoted with embedded quotes doubled.

    Args:
        value: the already-wire-mapped value (or ``None`` for a SQL NULL).
        wire_type: the column's wire type, selecting the rendering.

    Returns:
        The escaped CSV field text.
    """
    if value is None:
        return ""

    if wire_type is WireType.BOOLEAN:
        text = "true" if value else "false"
    elif wire_type in (WireType.JSON, WireType.JSON_ARRAY):
        # ensure_ascii=False so non-ASCII stays raw UTF-8, byte-matching JS
        # JSON.stringify — the CSV byte-identity contract with serialize.ts
        # breaks if Python escapes é/emoji to \uXXXX while JS emits raw bytes.
        text = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    else:
        # number / string (incl. precision numerics) / isoString / base64. A
        # native float renders with Python's repr (str(1.0) == "1.0"), which may
        # differ from the frontend's JS-number rendering for floats (see the
        # module docstring's byte-identity note); every other case is a string.
        text = str(value)

    if text == "" or any(ch in text for ch in ('"', ",", "\r", "\n")):
        return '"' + text.replace('"', '""') + '"'

    return text


def csv_header(columns: list[ColumnMeta]) -> str:
    """
    Render the CSV header row: the column names, each field-escaped, CRLF-ended.
    """
    return _DELIM.join(_csv_field(c.name, WireType.STRING) for c in columns) + _EOL


def csv_row(row: dict, columns: list[ColumnMeta]) -> str:
    """
    Render one CSV data record from a wire-mapped row, CRLF-terminated.

    Args:
        row: the row keyed by column name (a missing key is treated as NULL).
        columns: the columns to emit, in order.

    Returns:
        The comma-joined, CRLF-terminated CSV record.
    """
    return _DELIM.join(_csv_field(row.get(c.name), c.wire_type) for c in columns) + _EOL


def _row_object(row: dict, columns: list[ColumnMeta]) -> dict:
    """
    Project a wire-mapped row into an ordered object with one key per column, a
    missing key becoming ``None`` (JSON ``null``).
    """
    return {c.name: row.get(c.name) for c in columns}


def json_open() -> str:
    """
    Open the JSON export array.
    """
    return "["


def json_row(row: dict, columns: list[ColumnMeta], first: bool) -> str:
    """
    Render one row object for the JSON export, prefixed with ``,\\n`` unless it
    is the first (so the streamed chunks concatenate into a valid array).

    Args:
        row: the wire-mapped row keyed by column name.
        columns: the columns to emit, in key order.
        first: whether this is the first row (no leading separator).

    Returns:
        The (optionally separator-prefixed) serialized row object.
    """
    prefix = "" if first else ",\n"

    # ensure_ascii=False keeps non-ASCII raw UTF-8, matching the frontend's
    # JSON.stringify output so the two JSON surfaces stay representationally
    # consistent (not a hard byte-identity requirement, but the honest encoding).
    return prefix + json.dumps(_row_object(row, columns), ensure_ascii=False)


def json_close() -> str:
    """
    Close the JSON export array.
    """
    return "]"
