"""
DeleteRowCommand: the single-primary-key requirement (validated in the constructor).
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.operations import DeleteRowCommand
from tests.conftest import NO_CONN, TABLE, col


def test_no_primary_key_raises() -> None:
    with pytest.raises(ValidationError):
        DeleteRowCommand(NO_CONN,TABLE, 1, [col("name"), col("balance")])


def test_composite_primary_key_raises() -> None:
    cols = [col("a", pk=True), col("b", pk=True)]

    with pytest.raises(ValidationError):
        DeleteRowCommand(NO_CONN,TABLE, 1, cols)
