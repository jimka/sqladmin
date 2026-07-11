"""
TablePrivilegesQuery: the pure get_result() transform backing the /privileges
endpoint that gates the table editor's write actions.
"""

from __future__ import annotations

import pytest

from app.contract import TableRef
from app.operations import TablePrivilegesQuery
from tests.conftest import NO_CONN


def _op() -> TablePrivilegesQuery:
    return TablePrivilegesQuery(NO_CONN, TableRef("db", "public", "customers"))


def test_maps_the_four_flags() -> None:
    op = _op()
    op._raw = [{"can_select": True, "can_insert": True, "can_update": False, "can_delete": False}]

    assert op.get_result() == {
        "select": True,
        "insert": True,
        "update": False,
        "delete": False,
    }


def test_all_true() -> None:
    op = _op()
    op._raw = [{"can_select": True, "can_insert": True, "can_update": True, "can_delete": True}]

    assert op.get_result() == {"select": True, "insert": True, "update": True, "delete": True}


def test_missing_table_reports_all_false() -> None:
    # No catalog row (table gone) -> every privilege false, so the editor
    # disables all writes rather than erroring the tab.
    op = _op()
    op._raw = []

    assert op.get_result() == {"select": False, "insert": False, "update": False, "delete": False}


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        _op().get_result()
