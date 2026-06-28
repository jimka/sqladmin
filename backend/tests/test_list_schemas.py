"""
ListSchemasQuery: get_result() shape and the temporal guard.
"""

from __future__ import annotations

import pytest

from app.operations import ListSchemasQuery
from tests.conftest import NO_CONN


def test_get_result_shape() -> None:
    op = ListSchemasQuery(NO_CONN,"sqladmin")
    op._raw = [{"name": "public"}, {"name": "reporting"}]

    assert op.get_result() == [{"name": "public"}, {"name": "reporting"}]


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        ListSchemasQuery(NO_CONN,"sqladmin").get_result()
