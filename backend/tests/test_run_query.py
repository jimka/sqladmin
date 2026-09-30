"""
RunQueryCommand: constructor validation, get_result() classification + transform,
column-name dedup, short-name type mapping, affected-count parsing, temporal guard,
and apply()'s translation of a driver error into a positioned BadRequest.

All pure-logic (no database): the constructor validates and get_result() purely
transforms hand-set raw results, mirroring the NO_CONN style of the other
operation tests; the apply() case runs against a fake connection that fails.
"""

from __future__ import annotations

import contextlib
import datetime
import decimal
from types import SimpleNamespace

import asyncpg
import pytest

from app.errors import BadRequest, ValidationError
from app.operations import RunQueryCommand
from tests.conftest import NO_CONN


class _FailingConn:
    """
    Records the SQL each call executes and raises the seeded driver error from
    it — mirrors test_type_definition.py's _FakeConn, but every query fails.
    """

    def __init__(self, error: asyncpg.PostgresError) -> None:
        self._error: asyncpg.PostgresError = error
        self.queries: list[str] = []

    def transaction(self) -> contextlib.nullcontext:
        """
        A no-op stand-in for asyncpg's transaction context manager.
        """
        return contextlib.nullcontext()

    async def prepare(self, sql: str, *args: object) -> object:
        """
        Record the SQL, then raise the seeded error.
        """
        self.queries.append(sql)

        raise self._error


def _syntax_error(position: str) -> asyncpg.PostgresSyntaxError:
    """
    A driver syntax error carrying ``position`` the way asyncpg stores it.
    """
    exc = asyncpg.PostgresSyntaxError("msg")
    # asyncpg fills its error fields from the server message at runtime, so the
    # type checker does not see `position` as a declared attribute.
    setattr(exc, "position", position)

    return exc


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


# asyncpg Records are positional (indexable by column position), so the row
# fixtures below are tuples — get_result reads values by position, which is what
# lets duplicate/unnamed result columns keep distinct values (see the dedup test).
def test_rows_result_maps_columns_and_scalars() -> None:
    op = RunQueryCommand(NO_CONN, "select id, amount from t")
    op._attrs = [_attr("id", "int4"), _attr("amount", "numeric")]
    op._records = [(1, decimal.Decimal("5.00"))]
    op._status = "SELECT 1"

    assert op.get_result() == {
        "kind": "rows",
        "columns": [
            {"name": "id", "wireType": "number"},
            {"name": "amount", "wireType": "string"},
        ],
        "rows": [{"id": 1, "amount": "5.00"}],
        "rowCount": 1,
        "truncated": False,
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


def test_result_capped_at_max_rows_sets_truncated() -> None:
    # apply() fetches MAX_ROWS_PER_REQUEST + 1; that extra row marks the result
    # truncated, and get_result keeps only the first MAX_ROWS_PER_REQUEST.
    from app.operations.common import MAX_ROWS_PER_REQUEST

    op = RunQueryCommand(NO_CONN, "select n from t")
    op._attrs = [_attr("n", "int4")]
    op._records = [(i,) for i in range(MAX_ROWS_PER_REQUEST + 1)]
    op._status = f"SELECT {MAX_ROWS_PER_REQUEST + 1}"

    result = op.get_result()

    assert result["truncated"] is True
    assert result["rowCount"] == MAX_ROWS_PER_REQUEST
    assert len(result["rows"]) == MAX_ROWS_PER_REQUEST


def test_result_at_cap_is_not_truncated() -> None:
    # Exactly MAX_ROWS_PER_REQUEST fetched (apply's +1 found nothing more): not truncated.
    from app.operations.common import MAX_ROWS_PER_REQUEST

    op = RunQueryCommand(NO_CONN, "select n from t")
    op._attrs = [_attr("n", "int4")]
    op._records = [(i,) for i in range(MAX_ROWS_PER_REQUEST)]
    op._status = f"SELECT {MAX_ROWS_PER_REQUEST}"

    result = op.get_result()

    assert result["truncated"] is False
    assert result["rowCount"] == MAX_ROWS_PER_REQUEST


def test_duplicate_and_unnamed_columns_keep_distinct_values() -> None:
    # `SELECT 1, 1`: both result columns report the unnamed marker "?column?".
    # The names disambiguate to column/column_2 AND each keeps its own value —
    # positional row-building is what prevents the second value being dropped.
    op = RunQueryCommand(NO_CONN, "select 1, 2")
    op._attrs = [_attr("?column?", "int4"), _attr("?column?", "int4")]
    op._records = [(1, 2)]
    op._status = "SELECT 1"

    result = op.get_result()

    assert [c["name"] for c in result["columns"]] == ["column", "column_2"]
    assert result["rows"] == [{"column": 1, "column_2": 2}]
    assert result["rowCount"] == 1


def test_short_name_type_mapping() -> None:
    op = RunQueryCommand(NO_CONN, "select a, b, c")
    op._attrs = [_attr("a", "int4"), _attr("b", "bool"), _attr("c", "timestamptz")]
    op._records = [(1, True, datetime.datetime(2020, 1, 1))]
    op._status = "SELECT 1"

    by_name = {c["name"]: c["wireType"] for c in op.get_result()["columns"]}

    assert by_name == {"a": "number", "b": "boolean", "c": "isoString"}


def test_short_name_temporal_type_mapping() -> None:
    # A query result carries no Postgres type, so date and time get their own
    # wire types rather than sharing isoString with timestamp.
    op = RunQueryCommand(NO_CONN, "select d, t, ts")
    op._attrs = [_attr("d", "date"), _attr("t", "time"), _attr("ts", "timestamp")]
    op._records = [(datetime.date(2020, 1, 1), datetime.time(9, 30), datetime.datetime(2020, 1, 1, 9, 30))]
    op._status = "SELECT 1"

    result = op.get_result()
    by_name = {c["name"]: c["wireType"] for c in result["columns"]}

    assert by_name == {"d": "isoDate", "t": "isoTime", "ts": "isoString"}
    assert result["rows"] == [{"d": "2020-01-01", "t": "09:30:00", "ts": "2020-01-01T09:30:00"}]


def test_short_name_text_decoded_types() -> None:
    # connections._init_connection decodes interval/timetz as Postgres text, so
    # both result columns are strings that keep that text.
    op = RunQueryCommand(NO_CONN, "select iv, ttz")
    op._attrs = [_attr("iv", "interval"), _attr("ttz", "timetz")]
    op._records = [("1 mon", "09:30:00+02")]
    op._status = "SELECT 1"

    result = op.get_result()
    by_name = {c["name"]: c["wireType"] for c in result["columns"]}

    assert by_name == {"iv": "string", "ttz": "string"}
    assert result["rows"] == [{"iv": "1 mon", "ttz": "09:30:00+02"}]


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


async def test_apply_attaches_the_postgres_position_to_the_bad_request() -> None:
    conn = _FailingConn(_syntax_error("1"))
    op = RunQueryCommand(conn, "SELEC 1")  # type: ignore[arg-type]

    with pytest.raises(BadRequest) as caught:
        await op.apply()

    assert caught.value.position == 1
    assert conn.queries == ["SELEC 1"]
