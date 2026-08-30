"""
TypeDefinitionQuery: get_result() shape for an enum ({category: "enum",
labels, attributes: [], owner}) and a composite ({category: "composite",
labels: [], attributes, owner}), the not-found rule keyed on ``_owner`` (an
empty-but-real enum/composite is not a 404), the temporal guard, and apply()'s
own type-row classification (the guard against a table's row type, and the
SQL-filter's own exclusion of every typtype outside 'e'/'c').
"""

from __future__ import annotations

import pytest

from app.errors import NotFound
from app.operations import TypeDefinitionQuery
from tests.conftest import NO_CONN


class _FakeConn:
    """
    Records each query and returns pre-seeded rows in call order — mirrors
    test_list_columns.py's _FakeConn, one response per fetchrow/fetch call.
    """

    def __init__(self, responses: list) -> None:
        self._responses: list = responses
        self.queries: list[str] = []

    async def fetchrow(self, sql: str, *args: object) -> object:
        """
        Return the next seeded response, recording the SQL that was run.
        """
        self.queries.append(sql)

        return self._responses.pop(0)

    async def fetch(self, sql: str, *args: object) -> list:
        """
        Return the next seeded response, recording the SQL that was run.
        """
        self.queries.append(sql)

        return self._responses.pop(0)


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


async def test_apply_treats_a_row_type_typtype_as_not_found() -> None:
    # _TYPE_SQL's own WHERE clause excludes a typtype='c' row whose typrelid
    # names a real table (list_types.py's own filter): from apply()'s
    # perspective that is indistinguishable from no matching row at all.
    conn = _FakeConn(responses=[None])
    op = TypeDefinitionQuery(conn, "public", "customers")  # type: ignore[arg-type]

    await op.apply()

    with pytest.raises(NotFound):
        op.get_result()


async def test_apply_treats_an_excluded_typtype_as_not_found() -> None:
    # A base/domain/range/pseudo type ('b'/'d'/'r'/'p') never matches
    # _TYPE_SQL's "t.typtype IN ('e', 'c')" filter, so fetchrow reports no row.
    conn = _FakeConn(responses=[None])
    op = TypeDefinitionQuery(conn, "public", "citext")  # type: ignore[arg-type]

    await op.apply()

    with pytest.raises(NotFound):
        op.get_result()


async def test_apply_classifies_an_enum_row() -> None:
    type_row = {"oid": 1, "typtype": "e", "typrelid": 0, "owner": "sqladmin"}
    conn = _FakeConn(responses=[type_row, [{"enumlabel": "sad"}, {"enumlabel": "happy"}]])
    op = TypeDefinitionQuery(conn, "public", "mood")  # type: ignore[arg-type]

    await op.apply()

    assert op.get_result() == {
        "category": "enum",
        "labels": ["sad", "happy"],
        "attributes": [],
        "owner": "sqladmin",
    }


async def test_apply_classifies_a_standalone_composite_row() -> None:
    type_row = {"oid": 2, "typtype": "c", "typrelid": 99, "owner": "sqladmin"}
    conn = _FakeConn(responses=[type_row, [{"name": "street", "type": "text"}]])
    op = TypeDefinitionQuery(conn, "public", "addr")  # type: ignore[arg-type]

    await op.apply()

    assert op.get_result() == {
        "category": "composite",
        "labels": [],
        "attributes": [{"name": "street", "type": "text"}],
        "owner": "sqladmin",
    }


async def test_apply_reports_not_found_for_an_unrecognized_typtype_defensively() -> None:
    # A defense-in-depth case that _TYPE_SQL's own filter should make
    # unreachable in practice: were a row to slip through with a typtype
    # outside 'e'/'c' anyway, apply()'s classification must not silently
    # mislabel it as a composite — it clears _owner so get_result() 404s.
    type_row = {"oid": 3, "typtype": "x", "typrelid": 0, "owner": "sqladmin"}
    conn = _FakeConn(responses=[type_row])
    op = TypeDefinitionQuery(conn, "public", "mystery")  # type: ignore[arg-type]

    await op.apply()

    with pytest.raises(NotFound):
        op.get_result()
