"""
ListInheritanceQuery: the pure get_result() transform backing the schema
inheritance/partitioning-graph endpoint. Exercised offline by setting `_raw`
by hand (no database), mirroring the table_structure test style.
"""

from __future__ import annotations

import pytest

from app.operations import ListInheritanceQuery
from tests.conftest import NO_CONN


def test_declarative_partitioning_maps_both_sides_to_table() -> None:
    op = ListInheritanceQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "events",
            "source_kind": "p",
            "target_schema": "public",
            "target_name": "events_2024",
            "target_kind": "r",
        }
    ]

    assert op.get_result() == [
        {
            "source": {"schema": "public", "name": "events", "kind": "table"},
            "target": {"schema": "public", "name": "events_2024", "kind": "table"},
        }
    ]


def test_classic_inheritance_maps_both_sides_to_table() -> None:
    op = ListInheritanceQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "vehicles",
            "source_kind": "r",
            "target_schema": "public",
            "target_name": "cars",
            "target_kind": "r",
        }
    ]

    result = op.get_result()

    assert result[0]["source"]["kind"] == "table"
    assert result[0]["target"]["kind"] == "table"


def test_source_is_parent_target_is_child() -> None:
    op = ListInheritanceQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "events",
            "source_kind": "p",
            "target_schema": "public",
            "target_name": "events_2024",
            "target_kind": "r",
        }
    ]

    result = op.get_result()

    assert result[0]["source"]["name"] == "events"
    assert result[0]["target"]["name"] == "events_2024"


def test_empty_raw_returns_empty_list() -> None:
    op = ListInheritanceQuery(NO_CONN, "public")
    op._raw = []

    assert op.get_result() == []


def test_get_result_before_apply_raises() -> None:
    op = ListInheritanceQuery(NO_CONN, "public")

    with pytest.raises(RuntimeError):
        op.get_result()


def test_partitioned_index_row_is_dropped_not_a_key_error() -> None:
    # The live bug this plan fixes: pg_inherits carries 'I'/'i' (partitioned
    # index) rows Postgres 11+ records for a partitioned index's own child
    # indexes. Neither code is in RELKIND_KIND, so the row must be silently
    # dropped by edge_rows() rather than raise KeyError.
    op = ListInheritanceQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "t_d_idx",
            "source_kind": "I",
            "target_schema": "public",
            "target_name": "t_2024_d_idx",
            "target_kind": "i",
        }
    ]

    assert op.get_result() == []


def test_mixed_list_keeps_only_the_mappable_edge() -> None:
    op = ListInheritanceQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "t",
            "source_kind": "p",
            "target_schema": "public",
            "target_name": "t_2024",
            "target_kind": "r",
        },
        {
            "source_schema": "public",
            "source_name": "t_d_idx",
            "source_kind": "I",
            "target_schema": "public",
            "target_name": "t_2024_d_idx",
            "target_kind": "i",
        },
    ]

    result = op.get_result()

    assert len(result) == 1
    assert result[0]["source"]["name"] == "t"
    assert result[0]["target"]["name"] == "t_2024"


def test_constructor_binds_relkind_codes() -> None:
    op = ListInheritanceQuery(NO_CONN, "public")

    assert op._args == ("public", ["r", "p", "f", "v", "m"])
