"""
Pure DDL SQL-builder tests: qualify, quote_literal, require_text, ident_list.
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.sql.ddl import ident_list, qualify, quote_literal, require_text


# --- qualify ----------------------------------------------------------------


def test_qualify_quotes_schema_and_name() -> None:
    assert qualify("public", "my table") == '"public"."my table"'


def test_qualify_escapes_embedded_quote_and_dot() -> None:
    assert qualify('s"x', "t") == '"s""x"."t"'
    assert qualify("public", "a.b") == '"public"."a.b"'


# --- ident_list ---------------------------------------------------------------


def test_ident_list_quotes_and_joins_each_name() -> None:
    assert ident_list(["a", 'b"c']) == '"a", "b""c"'


def test_ident_list_empty_is_empty_string() -> None:
    assert ident_list([]) == ""


# --- quote_literal ------------------------------------------------------------


def test_quote_literal_wraps_in_single_quotes() -> None:
    assert quote_literal("hello") == "'hello'"


def test_quote_literal_doubles_embedded_single_quote() -> None:
    assert quote_literal("a'b") == "'a''b'"


# --- require_text --------------------------------------------------------------


def test_require_text_blank_raises() -> None:
    with pytest.raises(ValidationError, match="'name' is required"):
        require_text("", "name")


def test_require_text_whitespace_only_raises() -> None:
    with pytest.raises(ValidationError, match="'name' is required"):
        require_text("   ", "name")


def test_require_text_non_string_raises() -> None:
    with pytest.raises(ValidationError, match="'name' is required"):
        require_text(42, "name")


def test_require_text_returns_value_unchanged() -> None:
    assert require_text(" x ", "name") == " x "
