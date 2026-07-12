"""
DdlPreview / ExecuteDdlCommand: constructor validation and get_result()
classification, following the NO_CONN pure-logic style (see conftest.py,
test_run_query.py).
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.operations import DdlPreview, ExecuteDdlCommand
from tests.conftest import NO_CONN


# --- ExecuteDdlCommand -------------------------------------------------------


def test_empty_sql_raises() -> None:
    with pytest.raises(ValidationError):
        ExecuteDdlCommand(NO_CONN, "")


def test_whitespace_only_sql_raises() -> None:
    with pytest.raises(ValidationError):
        ExecuteDdlCommand(NO_CONN, "   ")


def test_get_result_before_apply_raises() -> None:
    op = ExecuteDdlCommand(NO_CONN, "CREATE TABLE t (id int)")

    with pytest.raises(RuntimeError):
        op.get_result()


def test_status_envelope_for_create_table() -> None:
    op = ExecuteDdlCommand(NO_CONN, "CREATE TABLE t (id int)")
    op._status = "CREATE TABLE"

    assert op.get_result() == {"kind": "status", "command": "CREATE TABLE", "rowCount": 0}


def test_status_envelope_for_drop_table() -> None:
    op = ExecuteDdlCommand(NO_CONN, "DROP TABLE t")
    op._status = "DROP TABLE"

    assert op.get_result() == {"kind": "status", "command": "DROP TABLE", "rowCount": 0}


# --- DdlPreview ---------------------------------------------------------------


class _FakePreview(DdlPreview):
    """A minimal DdlPreview subclass whose build() sets a fixed SQL string."""

    def build(self) -> None:
        self._sql = "CREATE TABLE t (id int)"


def test_preview_get_result_before_build_raises() -> None:
    op = _FakePreview()

    with pytest.raises(RuntimeError):
        op.get_result()


def test_preview_get_result_after_build() -> None:
    op = _FakePreview()
    op.build()

    assert op.get_result() == {"sql": "CREATE TABLE t (id int)"}


def test_preview_default_apply_calls_build() -> None:
    op = _FakePreview()

    import asyncio

    asyncio.run(op.apply())

    assert op.get_result() == {"sql": "CREATE TABLE t (id int)"}
