"""
SequenceDetailQuery: get_result() shape (numeric fields stringified, nullable
last_value, boolean cycle passed through), the NotFound-on-empty case, and
the temporal guard.
"""

from __future__ import annotations

import pytest

from app.contract import TableRef
from app.errors import NotFound
from app.operations import SequenceDetailQuery
from tests.conftest import NO_CONN

_SEQUENCE = TableRef("sqladmin", "sales", "products_id_seq")


def test_get_result_stringifies_numerics_and_keeps_full_precision() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = [
        {
            "owner": "sqladmin",
            "data_type": "bigint",
            "start_value": 1,
            "min_value": 1,
            "max_value": 9223372036854775807,
            "increment_by": 1,
            "cache_size": 1,
            "cycle": False,
            "last_value": 6,
        }
    ]

    assert op.get_result() == {
        "owner": "sqladmin",
        "dataType": "bigint",
        "startValue": "1",
        "minValue": "1",
        "maxValue": "9223372036854775807",
        "increment": "1",
        "cacheSize": "1",
        "cycle": False,
        "lastValue": "6",
    }


def test_get_result_maps_null_last_value_to_none() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = [
        {
            "owner": "sqladmin",
            "data_type": "bigint",
            "start_value": 1,
            "min_value": 1,
            "max_value": 9223372036854775807,
            "increment_by": 1,
            "cache_size": 1,
            "cycle": False,
            "last_value": None,
        }
    ]

    assert op.get_result()["lastValue"] is None


def test_get_result_keeps_cycle_true() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = [
        {
            "owner": "sqladmin",
            "data_type": "bigint",
            "start_value": 1,
            "min_value": 1,
            "max_value": 9223372036854775807,
            "increment_by": 1,
            "cache_size": 1,
            "cycle": True,
            "last_value": 6,
        }
    ]

    assert op.get_result()["cycle"] is True


def test_get_result_raises_not_found_when_absent() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = []

    with pytest.raises(NotFound):
        op.get_result()


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        SequenceDetailQuery(NO_CONN, _SEQUENCE).get_result()
