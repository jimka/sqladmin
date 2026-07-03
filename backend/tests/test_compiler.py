"""
Pure SQL-compiler tests: quote_ident, FilterCompiler, OrderCompiler.
"""

from __future__ import annotations

import pytest

from app.contract import WireType
from app.errors import ValidationError
from app.sql.compiler import FilterCompiler, OrderCompiler, quote_ident
from tests.conftest import col

COLS = [col("id", WireType.NUMBER, pk=True), col("name"), col("balance")]


# --- quote_ident ----------------------------------------------------------


def test_quote_ident_wraps() -> None:
    assert quote_ident("name") == '"name"'


def test_quote_ident_escapes_embedded_quote() -> None:
    assert quote_ident('we"ird') == '"we""ird"'


# --- OrderCompiler --------------------------------------------------------


def test_order_empty_yields_no_clause() -> None:
    assert OrderCompiler([], COLS).compile() == ""
    assert OrderCompiler(None, COLS).compile() == ""


def test_order_single_desc() -> None:
    assert OrderCompiler([{"field": "balance", "dir": "desc"}], COLS).compile() == 'ORDER BY "balance" DESC'


def test_order_defaults_to_asc() -> None:
    assert OrderCompiler([{"field": "name"}], COLS).compile() == 'ORDER BY "name" ASC'


def test_order_multiple_preserves_order() -> None:
    out = OrderCompiler(
        [{"field": "name", "dir": "asc"}, {"field": "balance", "dir": "desc"}], COLS
    ).compile()

    assert out == 'ORDER BY "name" ASC, "balance" DESC'


def test_order_unknown_column_raises() -> None:
    with pytest.raises(ValidationError):
        OrderCompiler([{"field": "ghost", "dir": "asc"}], COLS).compile()


# --- FilterCompiler -------------------------------------------------------


def test_filter_empty() -> None:
    assert FilterCompiler([], COLS).compile() == ("", [])


@pytest.mark.parametrize(
    "ftype,op",
    [("eq", "="), ("neq", "<>"), ("gt", ">"), ("gte", ">="), ("lt", "<"), ("lte", "<=")],
)
def test_filter_comparators(ftype: str, op: str) -> None:
    where, params = FilterCompiler([{"type": ftype, "field": "balance", "value": 10}], COLS).compile()

    assert where == f'WHERE "balance" {op} $1'
    assert params == [10]


def test_filter_contains_uses_ilike_and_wraps_pattern() -> None:
    where, params = FilterCompiler([{"type": "contains", "field": "name", "value": "ada"}], COLS).compile()

    assert where == r"""WHERE "name" ILIKE $1 ESCAPE '\'"""
    assert params == ["%ada%"]


def test_filter_contains_case_sensitive_uses_like() -> None:
    where, _ = FilterCompiler(
        [{"type": "contains", "field": "name", "value": "ada", "caseSensitive": True}], COLS
    ).compile()

    assert where == r"""WHERE "name" LIKE $1 ESCAPE '\'"""


def test_filter_starts_with_pattern() -> None:
    _, params = FilterCompiler([{"type": "startsWith", "field": "name", "value": "ad"}], COLS).compile()

    assert params == ["ad%"]


def test_filter_like_special_chars_escaped() -> None:
    _, params = FilterCompiler([{"type": "contains", "field": "name", "value": "a%b_c"}], COLS).compile()

    assert params == [r"%a\%b\_c%"]


def test_filter_like_escapes_backslash() -> None:
    # A literal backslash in the value must be doubled before the %/_ escaping, so
    # the `ESCAPE '\'` clause treats it as data and not as an escape introducer.
    _, params = FilterCompiler([{"type": "contains", "field": "name", "value": r"a\b"}], COLS).compile()

    assert params == [r"%a\\b%"]


def test_filter_in() -> None:
    where, params = FilterCompiler([{"type": "in", "field": "id", "values": [1, 2, 3]}], COLS).compile()

    assert where == 'WHERE "id" = ANY($1)'
    assert params == [[1, 2, 3]]


def test_filter_top_level_list_is_anded_with_sequential_binds() -> None:
    where, params = FilterCompiler(
        [
            {"type": "eq", "field": "name", "value": "x"},
            {"type": "gt", "field": "balance", "value": 5},
        ],
        COLS,
    ).compile()

    assert where == 'WHERE "name" = $1 AND "balance" > $2'
    assert params == ["x", 5]


def test_filter_composite_and_or_nest() -> None:
    where, params = FilterCompiler(
        [
            {
                "type": "or",
                "filters": [
                    {"type": "eq", "field": "name", "value": "x"},
                    {"type": "eq", "field": "name", "value": "y"},
                ],
            }
        ],
        COLS,
    ).compile()

    assert where == 'WHERE ("name" = $1 OR "name" = $2)'
    assert params == ["x", "y"]


def test_filter_not() -> None:
    where, params = FilterCompiler(
        [{"type": "not", "filter": {"type": "eq", "field": "id", "value": 1}}], COLS
    ).compile()

    assert where == 'WHERE NOT ("id" = $1)'
    assert params == [1]


def test_filter_unknown_column_raises() -> None:
    with pytest.raises(ValidationError):
        FilterCompiler([{"type": "eq", "field": "ghost", "value": 1}], COLS).compile()


def test_filter_unsupported_type_raises() -> None:
    with pytest.raises(ValidationError):
        FilterCompiler([{"type": "weird", "field": "id", "value": 1}], COLS).compile()
