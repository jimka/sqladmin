"""
FunctionDefinitionQuery: get_result() shape ({definition, isProcedure,
signature, language}), the NotFound-on-empty case, and the temporal guard.
Mirrors test_view_definition.py's hand-set-`_raw` style.
"""

from __future__ import annotations

import pytest

from app.errors import NotFound
from app.operations import FunctionDefinitionQuery
from tests.conftest import NO_CONN


def test_get_result_returns_definition() -> None:
    op = FunctionDefinitionQuery(NO_CONN, "public", "add", "integer, integer")
    op._raw = [{
        "definition": 'CREATE OR REPLACE FUNCTION "public"."add"(integer, integer) ...',
        "is_procedure": False,
        "signature": "integer, integer",
        "language": "plpgsql",
    }]

    assert op.get_result() == {
        "definition": 'CREATE OR REPLACE FUNCTION "public"."add"(integer, integer) ...',
        "isProcedure": False,
        "signature": "integer, integer",
        "language": "plpgsql",
    }


def test_get_result_returns_procedure() -> None:
    op = FunctionDefinitionQuery(NO_CONN, "public", "log_action", "text")
    op._raw = [{
        "definition": 'CREATE OR REPLACE PROCEDURE "public"."log_action"(text) ...',
        "is_procedure": True,
        "signature": "text",
        "language": "plpgsql",
    }]

    assert op.get_result()["isProcedure"] is True


def test_get_result_raises_not_found_when_absent() -> None:
    op = FunctionDefinitionQuery(NO_CONN, "public", "add", "integer, integer")
    op._raw = []

    with pytest.raises(NotFound):
        op.get_result()


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        FunctionDefinitionQuery(NO_CONN, "public", "add", "integer, integer").get_result()
