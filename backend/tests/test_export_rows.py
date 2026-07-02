"""
ExportRowsQuery: construct-time validation (no DB). The cursor streaming needs a
real relation and is exercised by the live/manual smoke, not here.
"""

from __future__ import annotations

import pytest

from app.contract import TableRef, WireType
from app.errors import ValidationError
from app.operations import ExportRowsQuery
from tests.conftest import NO_CONN, col

_TABLE = TableRef("sqladmin", "public", "customers")
_COLS = [col("id", WireType.NUMBER), col("name", WireType.STRING)]


def test_rejects_an_unknown_format_before_any_io() -> None:
    with pytest.raises(ValidationError):
        ExportRowsQuery(NO_CONN, _TABLE, "xlsx", _COLS)


def test_accepts_csv_and_json() -> None:
    # Construction must succeed for both supported formats without touching I/O
    # (NO_CONN is a null connection; only stream() would use it).
    assert ExportRowsQuery(NO_CONN, _TABLE, "csv", _COLS) is not None
    assert ExportRowsQuery(NO_CONN, _TABLE, "json", _COLS) is not None
