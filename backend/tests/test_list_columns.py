"""
ListColumnsQuery: get_columns_result() typing (incl. wire_type), get_result()
contract shape, and the temporal guard.
"""

from __future__ import annotations

import pytest

from app.contract import SequenceRef, WireType
from app.operations import ListColumnsQuery
from tests.conftest import NO_CONN, TABLE

# "id" is a serial: backed by a sequence. "balance" is a plain column, so its
# sequence_schema/sequence_name arrive NULL from the query's LEFT JOIN.
_RAW = [
    {"name": "id", "data_type": "integer", "nullable": False, "is_primary_key": True, "is_generated": True, "has_default": True,
     "sequence_schema": "public", "sequence_name": "customers_id_seq"},
    {"name": "balance", "data_type": "numeric", "nullable": False, "is_primary_key": False, "is_generated": False, "has_default": False,
     "sequence_schema": None, "sequence_name": None},
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
        "sequence": {"schema": "public", "name": "customers_id_seq"},
    }


def test_columns_maps_backing_sequence() -> None:
    op = _query()
    op._raw = _RAW
    metas = op.get_columns_result()

    assert metas[0].sequence == SequenceRef(schema="public", name="customers_id_seq")


def test_columns_without_sequence_map_to_none() -> None:
    op = _query()
    op._raw = _RAW

    assert op.get_columns_result()[1].sequence is None


def test_get_result_emits_null_sequence_key_when_unbacked() -> None:
    # The key is always present, so the frontend never has to distinguish
    # "absent" from "no sequence".
    op = _query()
    op._raw = _RAW

    assert op.get_result()[1]["sequence"] is None


def test_columns_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        _query().get_columns_result()


class _FakeConn:
    """
    Records each ``fetch`` query and returns pre-seeded rows in call order.
    """

    def __init__(self, responses: list) -> None:
        self._responses: list = responses
        self.queries: list[str] = []

    async def fetch(self, sql: str, *args: object) -> list:
        """
        Return the next seeded response, recording the SQL that was run.
        """
        self.queries.append(sql)

        return self._responses.pop(0)


async def test_apply_falls_back_to_catalog_for_matview() -> None:
    # information_schema.columns returns nothing for a materialized view, so a
    # second pg_catalog query must supply its columns.
    matview_row = {
        "name": "total",
        "data_type": "numeric",
        "nullable": True,
        "is_primary_key": False,
        "is_generated": False,
        "has_default": False,
        "sequence_schema": None,
        "sequence_name": None,
    }
    conn = _FakeConn(responses=[[], [matview_row]])
    op = ListColumnsQuery(conn, TABLE)  # type: ignore[arg-type]

    await op.apply()

    assert len(conn.queries) == 2
    assert "pg_attribute" in conn.queries[1]

    meta = op.get_columns_result()[0]

    assert meta.name == "total"
    # A matview column never has a sequence — the fallback query selects the
    # sequence columns as constant NULLs.
    assert meta.sequence is None


async def test_apply_skips_fallback_when_information_schema_has_rows() -> None:
    # A table/regular view is fully covered by information_schema, so the catalog
    # fallback must not run (a single query only).
    conn = _FakeConn(responses=[_RAW])
    op = ListColumnsQuery(conn, TABLE)  # type: ignore[arg-type]

    await op.apply()

    assert len(conn.queries) == 1
