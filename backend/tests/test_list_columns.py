"""
ListColumnsQuery: get_columns_result() typing (incl. wire_type), get_result()
contract shape, and the temporal guard.
"""

from __future__ import annotations

import pytest

from app.contract import SequenceRef, WireType
from app.operations import ListColumnsQuery
from tests.conftest import NO_CONN, TABLE

# "id" is a serial: backed by a sequence, and its default is the nextval()
# expression that supplies it. "balance" is a plain column with a modifier on
# its declared type (full_type differs from data_type) and no default, so its
# sequence_schema/sequence_name/default_expr all arrive NULL from the query.
_RAW = [
    {"name": "id", "data_type": "integer", "full_type": "integer", "nullable": False, "is_primary_key": True,
     "is_generated": True, "has_default": True, "default_expr": "nextval('customers_id_seq'::regclass)",
     "sequence_schema": "public", "sequence_name": "customers_id_seq"},
    {"name": "balance", "data_type": "numeric", "full_type": "numeric(12,2)", "nullable": False, "is_primary_key": False,
     "is_generated": False, "has_default": False, "default_expr": None,
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
        "fullType": "integer",
        "defaultExpr": "nextval('customers_id_seq'::regclass)",
        "sequence": {"schema": "public", "name": "customers_id_seq"},
    }


def test_get_result_carries_full_type_and_default_expr() -> None:
    # "balance" carries a modifier its data_type (the SQL-standard type name)
    # drops, and has no default.
    op = _query()
    op._raw = _RAW

    assert op.get_result()[1]["fullType"] == "numeric(12,2)"
    assert op.get_result()[1]["defaultExpr"] is None


def test_get_result_leaves_data_type_has_default_and_wire_type_unchanged() -> None:
    op = _query()
    op._raw = _RAW
    result = op.get_result()[1]

    assert result["dataType"] == "numeric"
    assert result["hasDefault"] is False
    assert result["wireType"] == "string"


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
        # _MATVIEW_SQL computes full_type with the same format_type() call as
        # data_type (see list_columns.py), so the two agree in this fixture.
        "full_type": "numeric",
        "nullable": True,
        "is_primary_key": False,
        "is_generated": False,
        "has_default": False,
        "default_expr": None,
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
    # A matview column never has a default either — no DEFAULT clause to call
    # nextval() from, and nothing OWNED BY a matview column.
    assert meta.full_type == "numeric"
    assert meta.default_expr is None


async def test_apply_skips_fallback_when_information_schema_has_rows() -> None:
    # A table/regular view is fully covered by information_schema, so the catalog
    # fallback must not run (a single query only).
    conn = _FakeConn(responses=[_RAW])
    op = ListColumnsQuery(conn, TABLE)  # type: ignore[arg-type]

    await op.apply()

    assert len(conn.queries) == 1
