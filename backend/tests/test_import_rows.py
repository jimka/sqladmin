"""
PreviewImportRowsQuery / ImportRowsCommand: constructor validation and the
preview's per-row ok/error results, following the NO_CONN pure-logic style
(see conftest.py, test_insert_row.py).
"""

from __future__ import annotations

import pytest

from app.contract import WireType
from app.errors import ValidationError
from app.operations import ImportRowsCommand, PreviewImportRowsQuery
from tests.conftest import NO_CONN, TABLE, col

# A table with a generated PK, a required (NOT NULL) column, a NUMBER
# column, a JSON column, and a uuid-typed STRING column — enough surface to
# exercise every constructor/preview rule without reusing ROW_COLS (whose
# "name"/"balance" are both nullable text, so neither a required-column miss
# nor a bad-numeric-value case can be built from it).
COLS = [
    col("id", WireType.NUMBER, pk=True, generated=True, data_type="integer"),
    col("name", nullable=False),
    col("age", WireType.NUMBER, data_type="integer"),
    col("meta", WireType.JSON, data_type="jsonb"),
    col("ref_id", WireType.STRING, data_type="uuid"),
]


# --- PreviewImportRowsQuery: constructor validation --------------------------


def test_preview_rejects_oversized_rows() -> None:
    rows = [{"name": "x"}] * 1001

    with pytest.raises(ValidationError):
        PreviewImportRowsQuery(TABLE, rows, COLS)


def test_preview_rejects_unknown_column_at_construction() -> None:
    with pytest.raises(ValidationError):
        PreviewImportRowsQuery(TABLE, [{"ghost": 1}], COLS)


def test_preview_get_result_before_apply_raises() -> None:
    op = PreviewImportRowsQuery(TABLE, [{"name": "ada"}], COLS)

    with pytest.raises(RuntimeError):
        op.get_result()


# --- PreviewImportRowsQuery: apply()'s per-row results ------------------------


async def test_preview_reports_ok_for_a_valid_row() -> None:
    op = PreviewImportRowsQuery(TABLE, [{"name": "ada", "age": 30}], COLS)
    await op.apply()

    result = op.get_result()

    assert result["totalRows"] == 1
    assert result["errorRows"] == 0
    assert result["rows"] == [{"rowNumber": 1, "ok": True, "values": {"name": "ada", "age": 30}}]


async def test_preview_accepts_a_json_sourced_plain_string_value() -> None:
    # A JSON-sourced row's "meta" (jsonb) value can legitimately be a plain
    # string, arriving pre-decoded (not itself further JSON-encoded) — e.g.
    # {"name": "ada", "meta": "hello"} from a hand-authored JSON import file,
    # or from this app's own JSON export of a jsonb column holding "hello".
    # from_import_scalar cannot invent a json.loads("hello") success, so it
    # must fall back to the literal string rather than raising.
    op = PreviewImportRowsQuery(TABLE, [{"name": "ada", "meta": "hello"}], COLS)
    await op.apply()

    row = op.get_result()["rows"][0]

    assert row["ok"] is True
    assert row["values"]["meta"] == "hello"


async def test_preview_drops_generated_column_silently() -> None:
    # "id" names a real, generated column: it must not appear in the coerced
    # values, and must not be treated as unknown either.
    op = PreviewImportRowsQuery(TABLE, [{"id": 5, "name": "ada", "age": 30}], COLS)
    await op.apply()

    row = op.get_result()["rows"][0]

    assert row["ok"] is True
    assert "id" not in row["values"]


async def test_preview_reports_bad_value_independently_per_row() -> None:
    rows = [{"name": "ada", "age": "30"}, {"name": "bob", "age": "abc"}]
    op = PreviewImportRowsQuery(TABLE, rows, COLS)
    await op.apply()

    result = op.get_result()

    assert result["errorRows"] == 1
    assert result["rows"][0]["ok"] is True
    assert result["rows"][1]["ok"] is False
    assert "age" in result["rows"][1]["error"]


async def test_preview_reports_a_value_from_wire_value_rejects_but_coercion_accepted() -> None:
    # from_import_scalar passes a uuid-typed STRING column's text through
    # unvalidated (see its coercion table — uuid format is "validated later"),
    # so a malformed UUID clears _coerce_row but must still be caught by
    # PreviewImportRowsQuery.apply()'s from_wire_value dry run.
    op = PreviewImportRowsQuery(TABLE, [{"name": "ada", "ref_id": "not-a-uuid"}], COLS)
    await op.apply()

    row = op.get_result()["rows"][0]

    assert row["ok"] is False


async def test_preview_reports_missing_required_column() -> None:
    op = PreviewImportRowsQuery(TABLE, [{"age": 30}], COLS)  # "name" (NOT NULL) absent
    await op.apply()

    row = op.get_result()["rows"][0]

    assert row["ok"] is False
    assert "name" in row["error"]


async def test_preview_reports_required_column_left_null() -> None:
    op = PreviewImportRowsQuery(TABLE, [{"name": None, "age": 30}], COLS)
    await op.apply()

    row = op.get_result()["rows"][0]

    assert row["ok"] is False
    assert "name" in row["error"]


# --- ImportRowsCommand: constructor validation --------------------------------


def test_import_rejects_oversized_rows() -> None:
    rows = [{"name": "x"}] * 1001

    with pytest.raises(ValidationError):
        ImportRowsCommand(NO_CONN, TABLE, rows, COLS)


def test_import_rejects_unknown_column_at_construction() -> None:
    with pytest.raises(ValidationError):
        ImportRowsCommand(NO_CONN, TABLE, [{"ghost": 1}], COLS)


def test_import_rejects_bad_value_at_construction() -> None:
    # A bad value must fail the whole construction (before any INSERT could
    # run), not surface as a per-row result the way preview's apply() does.
    with pytest.raises(ValidationError):
        ImportRowsCommand(NO_CONN, TABLE, [{"name": "ada", "age": "abc"}], COLS)


def test_import_drops_generated_column_without_treating_it_as_unknown() -> None:
    # Must not raise: "id" is a known, generated column, silently dropped.
    ImportRowsCommand(NO_CONN, TABLE, [{"id": 5, "name": "ada", "age": 30}], COLS)


def test_import_get_result_before_apply_raises() -> None:
    op = ImportRowsCommand(NO_CONN, TABLE, [{"name": "ada"}], COLS)

    with pytest.raises(RuntimeError):
        op.get_result()
