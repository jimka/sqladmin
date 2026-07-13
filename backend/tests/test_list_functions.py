"""
ListFunctionsQuery: get_result() shape ({name, signature, isProcedure}) and
the temporal guard.
"""

from __future__ import annotations

import pytest

from app.operations import ListFunctionsQuery
from tests.conftest import NO_CONN


def test_get_result_shape() -> None:
    op = ListFunctionsQuery(NO_CONN, "public")
    op._raw = [
        {"name": "add", "signature": "integer, integer", "is_procedure": False},
        {"name": "log_action", "signature": "text", "is_procedure": True},
    ]

    assert op.get_result() == [
        {"name": "add", "signature": "integer, integer", "isProcedure": False},
        {"name": "log_action", "signature": "text", "isProcedure": True},
    ]


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        ListFunctionsQuery(NO_CONN, "public").get_result()
