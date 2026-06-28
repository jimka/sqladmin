"""
ListDatabasesQuery: get_result() shape and the temporal guard.
"""

from __future__ import annotations

import pytest

from app.operations import ListDatabasesQuery
from tests.conftest import NO_CONN


def test_get_result_shape() -> None:
    op = ListDatabasesQuery(NO_CONN)
    op._raw = [{"name": "postgres"}, {"name": "sqladmin"}]

    assert op.get_result() == [{"name": "postgres"}, {"name": "sqladmin"}]


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        ListDatabasesQuery(NO_CONN).get_result()
