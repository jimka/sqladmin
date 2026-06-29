"""
RunQueryCommand: constructor validation, get_result() classification + transform,
column-name dedup, short-name type mapping, affected-count parsing, temporal guard.

All pure-logic (no database): the constructor validates and get_result() purely
transforms hand-set raw results, mirroring the NO_CONN style of the other
operation tests.
"""

from __future__ import annotations

import datetime
import decimal
from types import SimpleNamespace

import pytest

from app.errors import ValidationError
from app.operations import RunQueryCommand
from tests.conftest import NO_CONN


def _attr(name: str, type_name: str) -> SimpleNamespace:
    """A stand-in for an asyncpg result Attribute: it exposes name + type.name."""
    return SimpleNamespace(name=name, type=SimpleNamespace(name=type_name))


def test_empty_sql_raises() -> None:
    with pytest.raises(ValidationError):
        RunQueryCommand(NO_CONN, "   ")


def test_get_result_before_apply_raises() -> None:
    op = RunQueryCommand(NO_CONN, "select 1")

    with pytest.raises(RuntimeError):
        op.get_result()


def test_rows_result_maps_columns_and_scalars() -> None:
    op = RunQueryCommand(NO_CONN, "select id, amount from t")
    op._attrs = [_attr("id", "int4"), _attr("amount", "numeric")]
    op._records = [{"id": 1, "amount": decimal.Decimal("5.00")}]
    op._status = "SELECT 1"

    assert op.get_result() == {
        "kind": "rows",
        "columns": [
            {"name": "id", "wireType": "number"},
            {"name": "amount", "wireType": "string"},
        ],
        "rows": [{"id": 1, "amount": "5.00"}],
        "rowCount": 1,
    }


def test_empty_rowset_with_description_is_rows_not_status() -> None:
    op = RunQueryCommand(NO_CONN, "select id from t where false")
    op._attrs = [_attr("id", "int4")]
    op._records = []
    op._status = "SELECT 0"

    result = op.get_result()

    assert result["kind"] == "rows"
    assert result["rows"] == []
    assert result["columns"] == [{"name": "id", "wireType": "number"}]
    assert result["rowCount"] == 0


def test_duplicate_and_unnamed_columns_disambiguated() -> None:
    op = RunQueryCommand(NO_CONN, "select 1, 1")
    op._attrs = [_attr("?column?", "int4"), _attr("?column?", "int4")]
    op._records = []
    op._status = "SELECT 1"

    cols = op.get_result()["columns"]

    assert [c["name"] for c in cols] == ["column", "column_2"]


def test_short_name_type_mapping() -> None:
    op = RunQueryCommand(NO_CONN, "select a, b, c")
    op._attrs = [_attr("a", "int4"), _attr("b", "bool"), _attr("c", "timestamptz")]
    op._records = [{"a": 1, "b": True, "c": datetime.datetime(2020, 1, 1)}]
    op._status = "SELECT 1"

    by_name = {c["name"]: c["wireType"] for c in op.get_result()["columns"]}

    assert by_name == {"a": "number", "b": "boolean", "c": "isoString"}


def test_status_result_classifies_non_row_statement() -> None:
    op = RunQueryCommand(NO_CONN, "update t set x = 1")
    op._attrs = []
    op._records = []
    op._status = "UPDATE 5"

    assert op.get_result() == {"kind": "status", "command": "UPDATE 5", "rowCount": 5}


@pytest.mark.parametrize(
    "status,expected",
    [
        ("INSERT 0 3", 3),
        ("UPDATE 5", 5),
        ("DELETE 2", 2),
        ("CREATE TABLE", 0),
        ("", 0),
    ],
)
def test_affected_count_parsing(status: str, expected: int) -> None:
    op = RunQueryCommand(NO_CONN, "x")
    op._attrs = []
    op._status = status

    assert op.get_result()["rowCount"] == expected
