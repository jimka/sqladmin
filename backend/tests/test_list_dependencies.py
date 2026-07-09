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
            "dependent_schema": "public",
            "dependent_name": "customer_totals",
            "dependent_kind": "v",
            "source_schema": "public",
            "source_name": "orders",
            "source_kind": "r",
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
            "dependent_schema": "public",
            "dependent_name": "mv_totals",
            "dependent_kind": "m",
            "source_schema": "public",
            "source_name": "orders",
            "source_kind": "r",
        }
    ]

    assert op.get_result()[0]["source"]["kind"] == "materializedView"


def test_matview_source_kind_maps_to_materialized_view() -> None:
    op = ListDependenciesQuery(NO_CONN, "public")
    op._raw = [
        {
            "dependent_schema": "public",
            "dependent_name": "v_over_mv",
            "dependent_kind": "v",
            "source_schema": "public",
            "source_name": "mv_base",
            "source_kind": "m",
        }
    ]

    assert op.get_result()[0]["target"]["kind"] == "materializedView"


def test_partitioned_and_foreign_source_kinds_collapse_to_table() -> None:
    op = ListDependenciesQuery(NO_CONN, "public")
    op._raw = [
        {
            "dependent_schema": "public",
            "dependent_name": "v_over_partitioned",
            "dependent_kind": "v",
            "source_schema": "public",
            "source_name": "events",
            "source_kind": "p",
        },
        {
            "dependent_schema": "public",
            "dependent_name": "v_over_foreign",
            "dependent_kind": "v",
            "source_schema": "public",
            "source_name": "remote_events",
            "source_kind": "f",
        },
    ]

    kinds = [r["target"]["kind"] for r in op.get_result()]

    assert kinds == ["table", "table"]


def test_cross_schema_row_preserves_both_schemas() -> None:
    op = ListDependenciesQuery(NO_CONN, "a")
    op._raw = [
        {
            "dependent_schema": "a",
            "dependent_name": "v_cross",
            "dependent_kind": "v",
            "source_schema": "b",
            "source_name": "base_table",
            "source_kind": "r",
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
