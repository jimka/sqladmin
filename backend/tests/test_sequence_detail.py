"""
SequenceDetailQuery: get_result() shape (numeric fields stringified, nullable
last_value, boolean cycle passed through, nullable ownedBy), the
NotFound-on-empty case, and the temporal guard.
"""

from __future__ import annotations

from typing import Any

import pytest

from app.contract import TableRef
from app.errors import NotFound
from app.operations import SequenceDetailQuery
from tests.conftest import NO_CONN

_SEQUENCE = TableRef("sqladmin", "sales", "products_id_seq")


def _row(**overrides: Any) -> dict:
    """
    Build one ``pg_sequences``-shaped raw row, owned by ``sales.products.id``.

    Args:
        overrides: column values to replace in the default row.

    Returns:
        The raw row dict ``get_result()`` reads.
    """
    return {
        "owner": "sqladmin",
        "data_type": "bigint",
        "start_value": 1,
        "min_value": 1,
        "max_value": 9223372036854775807,
        "increment_by": 1,
        "cache_size": 1,
        "cycle": False,
        "last_value": 6,
        "owned_by_schema": "sales",
        "owned_by_table": "products",
        "owned_by_column": "id",
        **overrides,
    }


def _standalone_row(**overrides: Any) -> dict:
    """
    Build a raw row for a sequence no column owns — the LEFT JOIN's NULL case.

    Args:
        overrides: column values to replace in the default row.

    Returns:
        The raw row dict, with every ``owned_by_*`` column NULL.
    """
    return _row(owned_by_schema=None, owned_by_table=None, owned_by_column=None, **overrides)


def test_get_result_stringifies_numerics_and_keeps_full_precision() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = [_row()]

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
        "ownedBy": {"schema": "sales", "table": "products", "column": "id"},
    }


def test_get_result_maps_null_last_value_to_none() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = [_row(last_value=None)]

    assert op.get_result()["lastValue"] is None


def test_get_result_keeps_cycle_true() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = [_row(cycle=True)]

    assert op.get_result()["cycle"] is True


def test_get_result_maps_owning_column() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = [_row()]

    assert op.get_result()["ownedBy"] == {"schema": "sales", "table": "products", "column": "id"}


def test_get_result_maps_unowned_sequence_to_none() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = [_standalone_row()]

    assert op.get_result()["ownedBy"] is None


def test_standalone_sequence_is_not_not_found() -> None:
    # The owner lookup is a LEFT JOIN LATERAL precisely so an ownerless
    # sequence still returns its row; an inner join would 404 every one of
    # them through the NotFound-on-empty guard below.
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = [_standalone_row()]

    assert op.get_result()["startValue"] == "1"


def test_get_result_raises_not_found_when_absent() -> None:
    op = SequenceDetailQuery(NO_CONN, _SEQUENCE)
    op._raw = []

    with pytest.raises(NotFound):
        op.get_result()


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        SequenceDetailQuery(NO_CONN, _SEQUENCE).get_result()
