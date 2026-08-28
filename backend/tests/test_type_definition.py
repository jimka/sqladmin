"""
TypeDefinitionQuery: get_result() shape for an enum ({category: "enum",
labels, attributes: [], owner}) and a composite ({category: "composite",
labels: [], attributes, owner}), the not-found rule keyed on ``_owner`` (an
empty-but-real enum/composite is not a 404), and the temporal guard.
"""

from __future__ import annotations

import pytest

from app.errors import NotFound
from app.operations import TypeDefinitionQuery
from tests.conftest import NO_CONN


def test_get_result_enum() -> None:
    op = TypeDefinitionQuery(NO_CONN, "public", "mood")
    op._owner = "sqladmin"
    op._category = "enum"
    op._raw = [{"enumlabel": "sad"}, {"enumlabel": "ok"}, {"enumlabel": "happy"}]

    assert op.get_result() == {
        "category": "enum",
        "labels": ["sad", "ok", "happy"],
        "attributes": [],
        "owner": "sqladmin",
    }


def test_get_result_composite() -> None:
    op = TypeDefinitionQuery(NO_CONN, "public", "addr")
    op._owner = "sqladmin"
    op._category = "composite"
    op._raw = [{"name": "street", "type": "text"}, {"name": "zip", "type": "varchar(10)"}]

    assert op.get_result() == {
        "category": "composite",
        "labels": [],
        "attributes": [{"name": "street", "type": "text"}, {"name": "zip", "type": "varchar(10)"}],
        "owner": "sqladmin",
    }


def test_get_result_enum_with_no_labels() -> None:
    # CREATE TYPE t AS ENUM () is valid Postgres — a real, empty enum, not a
    # missing type. Only the captured owner (unset when no pg_type row
    # matched) should decide NotFound, not an empty child-row list.
    op = TypeDefinitionQuery(NO_CONN, "public", "empty_mood")
    op._owner = "sqladmin"
    op._category = "enum"
    op._raw = []

    assert op.get_result() == {"category": "enum", "labels": [], "attributes": [], "owner": "sqladmin"}


def test_get_result_raises_not_found_when_absent() -> None:
    op = TypeDefinitionQuery(NO_CONN, "public", "mood")
    op._owner = None
    op._raw = []

    with pytest.raises(NotFound):
        op.get_result()


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        TypeDefinitionQuery(NO_CONN, "public", "mood").get_result()
