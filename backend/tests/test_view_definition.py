"""
ViewDefinitionQuery: get_result() shape ({definition}), the NotFound-on-empty
case, and the temporal guard.
"""

from __future__ import annotations

import pytest

from app.contract import TableRef
from app.errors import NotFound
from app.operations import ViewDefinitionQuery
from tests.conftest import NO_CONN

_VIEW = TableRef("sqladmin", "public", "active_customers")


def test_get_result_returns_definition() -> None:
    op = ViewDefinitionQuery(NO_CONN, _VIEW)
    op._raw = [{"definition": "SELECT id, name FROM customers WHERE active"}]

    assert op.get_result() == {"definition": "SELECT id, name FROM customers WHERE active"}


def test_get_result_raises_not_found_when_absent() -> None:
    op = ViewDefinitionQuery(NO_CONN, _VIEW)
    op._raw = []

    with pytest.raises(NotFound):
        op.get_result()


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        ViewDefinitionQuery(NO_CONN, _VIEW).get_result()
