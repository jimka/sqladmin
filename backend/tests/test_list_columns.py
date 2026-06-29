"""
ListColumnsQuery: get_columns_result() typing (incl. wire_type), get_result()
contract shape, and the temporal guard.
"""

from __future__ import annotations

import pytest

from app.contract import WireType
from app.operations import ListColumnsQuery
from tests.conftest import NO_CONN, TABLE

_RAW = [
    {"name": "id", "data_type": "integer", "nullable": False, "is_primary_key": True, "is_generated": True, "has_default": True},
    {"name": "balance", "data_type": "numeric", "nullable": False, "is_primary_key": False, "is_generated": False, "has_default": False},
]


def _query() -> ListColumnsQuery:
    """
    Build a ListColumnsQuery over the shared fixture table (conn unused offline).
    """
    return ListColumnsQuery(NO_CONN, TABLE)


def test_columns_derives_wire_type() -> None:
    op = _query()
    op._raw = _RAW
    metas = op.get_columns_result()

    assert metas[0].wire_type is WireType.NUMBER  # integer
    assert metas[1].wire_type is WireType.STRING  # numeric -> precision-preserving string


def test_get_result_contract_shape() -> None:
    op = _query()
    op._raw = _RAW

    assert op.get_result()[0] == {
        "name": "id",
        "dataType": "integer",
        "nullable": False,
        "isPrimaryKey": True,
        "isGenerated": True,
        "hasDefault": True,
        "wireType": "number",
    }


def test_columns_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        _query().get_columns_result()
