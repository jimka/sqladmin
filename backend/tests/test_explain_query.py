"""
ExplainQueryCommand: constructor validation, get_result() shaping of the
captured plan into the {kind:"explain"} envelope for FORMAT TEXT / FORMAT JSON,
and apply()'s shift of a driver error's position past the ``EXPLAIN (…)`` prefix.

All pure-logic (no database): the constructor validates and get_result() purely
transforms a hand-set captured plan, mirroring the NO_CONN style of
test_run_query.py; the apply() cases run against a fake connection that fails.
The ANALYZE rollback net needs a real connection and is covered by the
integration checks, not here.
"""

from __future__ import annotations

import contextlib

import asyncpg
import pytest

from app.errors import BadRequest, ValidationError
from app.operations import ExplainQueryCommand
from app.operations.explain_query import _explain_options
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

    async def fetch(self, sql: str, *args: object) -> object:
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


def test_explain_options_with_no_flags() -> None:
    assert _explain_options(False, False, "text") == "FORMAT TEXT"


def test_explain_options_with_analyze_only() -> None:
    assert _explain_options(True, False, "json") == "ANALYZE, FORMAT JSON"


def test_explain_options_with_verbose_only() -> None:
    assert _explain_options(False, True, "json") == "VERBOSE, FORMAT JSON"


def test_explain_options_with_analyze_and_verbose() -> None:
    assert _explain_options(True, True, "json") == "ANALYZE, VERBOSE, FORMAT JSON"


def test_empty_sql_raises() -> None:
    with pytest.raises(ValidationError):
        ExplainQueryCommand(NO_CONN, "   ", analyze=False, fmt="text")


def test_unsupported_format_raises() -> None:
    with pytest.raises(ValidationError):
        ExplainQueryCommand(NO_CONN, "select 1", analyze=False, fmt="xml")


def test_get_result_before_apply_raises() -> None:
    op = ExplainQueryCommand(NO_CONN, "select 1", analyze=False, fmt="text")

    with pytest.raises(RuntimeError):
        op.get_result()


# asyncpg Records are positional (indexable by column position), so the captured
# plan fixtures below are tuples — get_result reads r[0] for each plan line.
def test_text_plan_joins_rows_into_one_block() -> None:
    op = ExplainQueryCommand(NO_CONN, "select 1", analyze=False, fmt="text")
    op._plan = [("Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)",), ("  Filter: (id = 1)",)]

    assert op.get_result() == {
        "kind": "explain",
        "format": "text",
        "analyze": False,
        "plan": "Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)\n  Filter: (id = 1)",
    }


def test_text_plan_echoes_analyze_flag() -> None:
    op = ExplainQueryCommand(NO_CONN, "select 1", analyze=True, fmt="text")
    op._plan = [("Result  (actual time=0.001..0.001 rows=1 loops=1)",)]

    result = op.get_result()

    assert result["analyze"] is True
    assert result["plan"] == "Result  (actual time=0.001..0.001 rows=1 loops=1)"


def test_json_plan_passes_tree_through_planjson() -> None:
    tree = [{"Plan": {"Node Type": "Seq Scan", "Relation Name": "t"}}]
    op = ExplainQueryCommand(NO_CONN, "select 1", analyze=False, fmt="json")
    # FORMAT JSON returns a single row whose one column is the plan array.
    op._plan = [(tree,)]

    assert op.get_result() == {
        "kind": "explain",
        "format": "json",
        "analyze": False,
        "plan": "",
        "planJson": tree,
    }


def test_json_plan_with_no_rows_yields_none() -> None:
    op = ExplainQueryCommand(NO_CONN, "select 1", analyze=False, fmt="json")
    op._plan = []

    result = op.get_result()

    assert result["planJson"] is None
    assert result["kind"] == "explain"


@pytest.mark.parametrize(
    "analyze,prefix,raw_position",
    [
        (False, "EXPLAIN (FORMAT TEXT) ", "23"),
        (True, "EXPLAIN (ANALYZE, FORMAT TEXT) ", "32"),
    ],
)
async def test_apply_shifts_the_position_past_the_explain_prefix(
    analyze: bool, prefix: str, raw_position: str
) -> None:
    conn = _FailingConn(_syntax_error(raw_position))
    op = ExplainQueryCommand(conn, "SELEC 1", analyze=analyze, fmt="text")  # type: ignore[arg-type]

    with pytest.raises(BadRequest) as caught:
        await op.apply()

    assert caught.value.position == 1
    assert conn.queries == [prefix + "SELEC 1"]
