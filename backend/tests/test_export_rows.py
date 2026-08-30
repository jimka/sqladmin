"""
ExportRowsQuery: construct-time validation (no DB). The cursor streaming needs a
real relation and is exercised by the live/manual smoke, not here.
"""

from __future__ import annotations

import re

import pytest

from app.contract import TableRef, WireType
from app.errors import ValidationError
from app.export_format import EXPORT_MEDIA
from app.operations import ExportRowsQuery
from tests.conftest import NO_CONN, col

_TABLE = TableRef("sqladmin", "public", "customers")
_COLS = [col("id", WireType.NUMBER), col("name", WireType.STRING)]


def test_rejects_an_unknown_format_before_any_io() -> None:
    # The message names the formats _VALID_FORMATS actually holds, derived from
    # EXPORT_MEDIA — pinned exactly so a future third format changes this
    # assertion instead of silently drifting from what the client is told.
    with pytest.raises(ValidationError, match=re.escape("Unsupported export format: 'xlsx' (expected csv or json)")):
        ExportRowsQuery(NO_CONN, _TABLE, "xlsx", _COLS)


@pytest.mark.parametrize("fmt", sorted(EXPORT_MEDIA))
def test_accepts_every_format_in_the_media_map(fmt) -> None:
    # Construction must succeed for every format EXPORT_MEDIA names, without
    # touching I/O (NO_CONN is a null connection; only stream() would use it).
    assert ExportRowsQuery(NO_CONN, _TABLE, fmt, _COLS) is not None
