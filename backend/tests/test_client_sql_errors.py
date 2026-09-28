"""
client_sql_position / client_sql_errors: reading Postgres's 1-based error
position off a driver error (shifted past a server-added prefix, dropped when it
points into that prefix or is unparseable), and translating a driver error raised
inside the context manager into the typed taxonomy with that position attached.

All pure-logic (no database): errors are built by hand, with ``position`` set as
the string asyncpg stores the protocol's ``P`` field as.
"""

from __future__ import annotations

import asyncpg
import pytest

from app.errors import BadRequest, ConflictError, ValidationError
from app.operations.common import client_sql_errors, client_sql_position


def _syntax_error(position: str | None) -> asyncpg.PostgresSyntaxError:
    """
    A driver syntax error carrying ``position`` the way asyncpg stores it.

    Args:
        position: the raw ``P`` field value, or None for an error without one.

    Returns:
        A ``PostgresSyntaxError`` whose message is ``"msg"``.
    """
    exc = asyncpg.PostgresSyntaxError("msg")
    # asyncpg fills its error fields from the server message at runtime, so the
    # type checker does not see `position` as a declared attribute.
    setattr(exc, "position", position)

    return exc


# --- client_sql_position (B1-B5) ------------------------------------------


def test_position_is_parsed_from_the_driver_string() -> None:
    assert client_sql_position(_syntax_error("8")) == 8


def test_missing_position_is_none() -> None:
    assert client_sql_position(_syntax_error(None)) is None


def test_position_is_shifted_past_the_prefix() -> None:
    assert client_sql_position(_syntax_error("23"), prefix_length=22) == 1


def test_position_inside_the_prefix_is_dropped() -> None:
    assert client_sql_position(_syntax_error("22"), prefix_length=22) is None


def test_unparseable_position_is_none() -> None:
    assert client_sql_position(_syntax_error("abc")) is None


# --- client_sql_errors (B6-B8) --------------------------------------------


def test_syntax_error_becomes_bad_request_with_position() -> None:
    original = _syntax_error("8")

    with pytest.raises(BadRequest) as caught:
        with client_sql_errors():
            raise original

    assert caught.value.detail == "msg"
    assert caught.value.position == 8
    assert caught.value.__cause__ is original


def test_integrity_violation_becomes_conflict_without_position() -> None:
    with pytest.raises(ConflictError) as caught:
        with client_sql_errors():
            raise asyncpg.UniqueViolationError("dup")

    assert caught.value.position is None


def test_domain_error_passes_through_untouched() -> None:
    original = ValidationError("x")

    with pytest.raises(ValidationError) as caught:
        with client_sql_errors():
            raise original

    assert caught.value is original
