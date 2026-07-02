"""
export_format: the pure CSV/JSON dialect that mirrors the frontend serialize.ts,
so a streamed full-table CSV is byte-identical to a query-result CSV of the same
wire data (NULL vs empty, quoting, each wire type, header).
"""

from __future__ import annotations

import json

from app.contract import WireType
from app.export_format import (
    csv_header,
    csv_row,
    json_close,
    json_open,
    json_row,
)
from tests.conftest import col

CRLF = "\r\n"


def test_csv_header_is_comma_joined_and_crlf_terminated() -> None:
    cols = [col("id", WireType.NUMBER), col("name", WireType.STRING)]

    assert csv_header(cols) == f"id,name{CRLF}"


def test_csv_row_renders_values_in_column_order() -> None:
    cols = [col("id", WireType.NUMBER), col("name", WireType.STRING)]

    assert csv_row({"id": 1, "name": "ada"}, cols) == f"1,ada{CRLF}"


def test_csv_null_is_bare_empty_but_empty_string_is_quoted() -> None:
    cols = [col("n", WireType.STRING), col("e", WireType.STRING)]

    # None (and a missing key) render bare-empty (NULL); an empty string renders
    # as the quoted "" so the two stay distinguishable.
    assert csv_row({"n": None, "e": ""}, cols) == f',""{CRLF}'
    assert csv_row({"e": ""}, cols) == f',""{CRLF}'


def test_csv_quotes_comma_quote_cr_and_lf() -> None:
    c = [col("c", WireType.STRING)]

    assert csv_row({"c": "a,b"}, c) == f'"a,b"{CRLF}'
    assert csv_row({"c": 'a"b'}, c) == f'"a""b"{CRLF}'
    assert csv_row({"c": "a\nb"}, c) == f'"a\nb"{CRLF}'
    assert csv_row({"c": "a\rb"}, c) == f'"a\rb"{CRLF}'


def test_csv_booleans_are_lowercase() -> None:
    c = [col("b", WireType.BOOLEAN)]

    assert csv_row({"b": True}, c) == f"true{CRLF}"
    assert csv_row({"b": False}, c) == f"false{CRLF}"


def test_csv_numeric_as_string_is_verbatim() -> None:
    c = [col("amount", WireType.STRING)]

    assert csv_row({"amount": "123.45000"}, c) == f"123.45000{CRLF}"


def test_csv_iso_and_base64_are_verbatim() -> None:
    cols = [col("ts", WireType.ISO_STRING), col("b", WireType.BASE64)]

    assert csv_row({"ts": "2026-07-02T10:00:00+00:00", "b": "AQID"}, cols) == (
        f"2026-07-02T10:00:00+00:00,AQID{CRLF}"
    )


def test_csv_json_is_compact_stringified_then_escaped() -> None:
    cols = [col("j", WireType.JSON), col("a", WireType.JSON_ARRAY)]

    # {"a":1} is compact-serialized then CSV-escaped into one quoted field with
    # doubled quotes — byte-identical to the frontend serializer.
    assert csv_row({"j": {"a": 1}, "a": [1, 2]}, cols) == f'"{{""a"":1}}","[1,2]"{CRLF}'


def test_json_open_and_close() -> None:
    assert json_open() == "["
    assert json_close() == "]"


def test_json_row_emits_object_with_column_order_and_null_for_missing() -> None:
    cols = [col("id", WireType.NUMBER), col("name", WireType.STRING)]

    first = json_row({"id": 1, "name": "ada"}, cols, first=True)

    # The first row carries no leading separator; a later row is prefixed ",\n".
    assert not first.startswith(",")
    assert json.loads(first) == {"id": 1, "name": "ada"}

    later = json_row({"name": "bob"}, cols, first=False)

    assert later.startswith(",\n")
    assert json.loads(later[2:]) == {"id": None, "name": "bob"}


def test_json_document_round_trips_to_native_types() -> None:
    cols = [
        col("id", WireType.NUMBER),
        col("ok", WireType.BOOLEAN),
        col("meta", WireType.JSON),
        col("note", WireType.STRING),
    ]

    rows = [
        {"id": 1, "ok": True, "meta": {"x": 1}, "note": None},
        {"id": 2, "ok": False, "meta": [1, 2], "note": "hi"},
    ]

    body = json_open()
    for i, row in enumerate(rows):
        body += json_row(row, cols, first=(i == 0))
    body += json_close()

    assert json.loads(body) == [
        {"id": 1, "ok": True, "meta": {"x": 1}, "note": None},
        {"id": 2, "ok": False, "meta": [1, 2], "note": "hi"},
    ]
