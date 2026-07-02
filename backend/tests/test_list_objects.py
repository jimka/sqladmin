"""
ListObjectsQuery: get_result() shape (name + kind) and the temporal guard.
"""

from __future__ import annotations

import pytest

from app.operations import ListObjectsQuery
from tests.conftest import NO_CONN


def test_get_result_shape() -> None:
    op = ListObjectsQuery(NO_CONN,"public")
    op._raw = [
        {"name": "customers", "kind": "table"},
        {"name": "active_customers", "kind": "view"},
        {"name": "customer_totals", "kind": "materializedView"},
    ]

    assert op.get_result() == [
        {"name": "customers", "kind": "table"},
        {"name": "active_customers", "kind": "view"},
        {"name": "customer_totals", "kind": "materializedView"},
    ]


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        ListObjectsQuery(NO_CONN,"public").get_result()
