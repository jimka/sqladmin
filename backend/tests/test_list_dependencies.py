"""
ListDependenciesQuery: the pure get_result() transform backing the schema
dependency-graph endpoint. Exercised offline by setting `_raw` by hand (no
database), mirroring the table_structure test style.
"""

from __future__ import annotations

import pytest

from app.operations import ListDependenciesQuery
from tests.conftest import NO_CONN


def test_view_depends_on_table() -> None:
    op = ListDependenciesQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "customer_totals",
            "source_kind": "v",
            "target_schema": "public",
            "target_name": "orders",
            "target_kind": "r",
        }
    ]

    assert op.get_result() == [
        {
            "source": {"schema": "public", "name": "customer_totals", "kind": "view"},
            "target": {"schema": "public", "name": "orders", "kind": "table"},
        }
    ]


def test_matview_dependent_kind_maps_to_materialized_view() -> None:
    op = ListDependenciesQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "mv_totals",
            "source_kind": "m",
            "target_schema": "public",
            "target_name": "orders",
            "target_kind": "r",
        }
    ]

    assert op.get_result()[0]["source"]["kind"] == "materializedView"


def test_matview_source_kind_maps_to_materialized_view() -> None:
    op = ListDependenciesQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "v_over_mv",
            "source_kind": "v",
            "target_schema": "public",
            "target_name": "mv_base",
            "target_kind": "m",
        }
    ]

    assert op.get_result()[0]["target"]["kind"] == "materializedView"


def test_partitioned_and_foreign_source_kinds_collapse_to_table() -> None:
    op = ListDependenciesQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "v_over_partitioned",
            "source_kind": "v",
            "target_schema": "public",
            "target_name": "events",
            "target_kind": "p",
        },
        {
            "source_schema": "public",
            "source_name": "v_over_foreign",
            "source_kind": "v",
            "target_schema": "public",
            "target_name": "remote_events",
            "target_kind": "f",
        },
    ]

    kinds = [r["target"]["kind"] for r in op.get_result()]

    assert kinds == ["table", "table"]


def test_cross_schema_row_preserves_both_schemas() -> None:
    op = ListDependenciesQuery(NO_CONN, "a")
    op._raw = [
        {
            "source_schema": "a",
            "source_name": "v_cross",
            "source_kind": "v",
            "target_schema": "b",
            "target_name": "base_table",
            "target_kind": "r",
        }
    ]

    result = op.get_result()

    assert result[0]["source"]["schema"] == "a"
    assert result[0]["target"]["schema"] == "b"


def test_empty_raw_returns_empty_list() -> None:
    op = ListDependenciesQuery(NO_CONN, "public")
    op._raw = []

    assert op.get_result() == []


def test_get_result_before_apply_raises() -> None:
    op = ListDependenciesQuery(NO_CONN, "public")

    with pytest.raises(RuntimeError):
        op.get_result()


def test_partitioned_index_row_is_dropped_not_a_key_error() -> None:
    # The live bug this plan fixes: pg_depend can surface a relation whose
    # relkind is 'I'/'i' (a partitioned index's own child index), which is not
    # in RELKIND_KIND. edge_rows() must drop the row, not raise KeyError.
    op = ListDependenciesQuery(NO_CONN, "public")
    op._raw = [
        {
            "source_schema": "public",
            "source_name": "some_idx",
            "source_kind": "I",
            "target_schema": "public",
            "target_name": "some_idx_2024",
            "target_kind": "i",
        }
    ]

    assert op.get_result() == []


def test_constructor_binds_relkind_codes() -> None:
    op = ListDependenciesQuery(NO_CONN, "public")

    assert op._args == ("public", ["r", "p", "f", "v", "m"])
