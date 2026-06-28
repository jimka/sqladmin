"""
ListRowsQuery: get_result() transform, temporal guard, constructor validation.
"""

from __future__ import annotations

import decimal

import pytest

from app.errors import ValidationError
from app.operations import ListRowsQuery
from tests.conftest import NO_CONN, ROW_COLS, TABLE


def _list_query(sort: list | None = None, filters: list | None = None) -> ListRowsQuery:
    """
    Build a ListRowsQuery over the shared fixture table (conn unused offline).
    """
    return ListRowsQuery(NO_CONN, TABLE, 1, 10, sort or [], filters or [], ROW_COLS)


def test_get_result_lifts_total_and_maps_scalars() -> None:
    op = _list_query()
    op._raw = [
        {"id": 1, "name": "Ada", "balance": decimal.Decimal("1.50"), "__total": 2},
        {"id": 2, "name": "Alan", "balance": decimal.Decimal("2.00"), "__total": 2},
    ]
    result = op.get_result()

    assert result["totalCount"] == 2
    assert result["rows"][0] == {"id": 1, "name": "Ada", "balance": "1.50"}
    assert "__total" not in result["rows"][0]


def test_get_result_empty() -> None:
    op = _list_query()
    op._raw = []

    assert op.get_result() == {"rows": [], "totalCount": 0}


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        _list_query().get_result()


def test_bad_sort_column_raises_in_constructor() -> None:
    with pytest.raises(ValidationError):
        _list_query(sort=[{"field": "ghost", "dir": "asc"}])


def test_bad_filter_column_raises_in_constructor() -> None:
    with pytest.raises(ValidationError):
        _list_query(filters=[{"type": "eq", "field": "ghost", "value": 1}])
