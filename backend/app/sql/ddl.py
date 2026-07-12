"""
Pure DDL SQL-builder primitives shared by every object-specific builder.

Identifiers (schema/table/column/type *names*) are always double-quoted via
``quote_ident`` here or in a phase's own builder — never interpolated raw. Raw
type strings, defaults, and check/SQL expressions cannot be parameterized or
quoted as identifiers (they are SQL fragments by nature); those are inserted
as the user typed them and reviewed in the editable preview before execute
(see ``plans/implemented/ddl-infrastructure.md``). No database access here.
"""

from __future__ import annotations

from .compiler import quote_ident

__all__ = ["quote_ident", "qualify", "quote_literal"]


def qualify(schema: str, name: str) -> str:
    """
    Return a schema-qualified, double-quoted object name.

    Generalizes ``operations.common.qualified`` (which is ``TableRef``-specific)
    to any ``(schema, name)`` pair, for use across every DDL object kind
    (tables, views, sequences, types, functions, ...).

    Args:
        schema: the object's schema name.
        name: the object's own name.

    Returns:
        ``"schema"."name"``, with each part independently quoted.
    """
    return f"{quote_ident(schema)}.{quote_ident(name)}"


def quote_literal(value: str) -> str:
    """
    Single-quote a string literal for a DDL fragment (e.g. a COMMENT body),
    escaping embedded quotes.

    NOT for identifiers (use ``quote_ident``) and NOT a substitute for a bound
    parameter — DDL statements cannot bind params, so a literal that must
    appear inline (a default value, a comment) is quoted this way instead.

    Args:
        value: the raw string to quote.

    Returns:
        The value wrapped in single quotes, with embedded ``'`` doubled.
    """
    return "'" + value.replace("'", "''") + "'"
