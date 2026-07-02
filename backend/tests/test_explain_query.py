"""
ExplainQueryCommand: constructor validation, and get_result() shaping of the
captured plan into the {kind:"explain"} envelope for FORMAT TEXT / FORMAT JSON.

All pure-logic (no database): the constructor validates and get_result() purely
transforms a hand-set captured plan, mirroring the NO_CONN style of
test_run_query.py. The ANALYZE rollback net needs a real connection and is
covered by the integration checks, not here.
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.operations import ExplainQueryCommand
from tests.conftest import NO_CONN


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
