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
            "parent_schema": "public",
            "parent_name": "events",
            "parent_kind": "p",
            "child_schema": "public",
            "child_name": "events_2024",
            "child_kind": "r",
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
            "parent_schema": "public",
            "parent_name": "vehicles",
            "parent_kind": "r",
            "child_schema": "public",
            "child_name": "cars",
            "child_kind": "r",
        }
    ]

    result = op.get_result()

    assert result[0]["source"]["kind"] == "table"
    assert result[0]["target"]["kind"] == "table"


def test_source_is_parent_target_is_child() -> None:
    op = ListInheritanceQuery(NO_CONN, "public")
    op._raw = [
        {
            "parent_schema": "public",
            "parent_name": "events",
            "parent_kind": "p",
            "child_schema": "public",
            "child_name": "events_2024",
            "child_kind": "r",
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
