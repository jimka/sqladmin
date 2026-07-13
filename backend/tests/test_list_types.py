"""
ListTypesQuery: get_result() shape ({name}) and the temporal guard.
"""

from __future__ import annotations

import pytest

from app.operations import ListTypesQuery
from tests.conftest import NO_CONN


def test_get_result_shape() -> None:
    op = ListTypesQuery(NO_CONN, "public")
    op._raw = [{"name": "mood"}, {"name": "addr"}]

    assert op.get_result() == [{"name": "mood"}, {"name": "addr"}]


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        ListTypesQuery(NO_CONN, "public").get_result()
