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

from collections.abc import Mapping, Sequence
from typing import Any

from ..errors import ValidationError
from .compiler import quote_ident

__all__ = [
    "quote_ident",
    "qualify",
    "quote_literal",
    "create_table",
    "drop_table",
    "rename_table",
    "add_column",
    "drop_column",
    "rename_column",
    "alter_column_type",
    "set_not_null",
    "drop_not_null",
    "set_default",
    "drop_default",
    "add_primary_key",
    "add_unique",
    "add_check",
    "add_foreign_key",
    "drop_constraint",
    "create_index",
    "drop_index",
]


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


# --- Table DDL ----------------------------------------------------------------
#
# Builders for CREATE/DROP/RENAME TABLE, ALTER-column operations, constraint
# add/drop, and index create/drop (table-ddl phase). Names are quoted via
# ``quote_ident``/``qualify``; column ``type``, ``default``, check
# ``expression``, and a type-change ``using`` clause are raw SQL fragments —
# inserted verbatim and reviewed in the editable preview before execute (see
# ``plans/implemented/ddl-infrastructure.md``'s trust model). Referential
# actions and index methods are validated against the fixed allowlists below.

# The referential actions PostgreSQL accepts for ``ON UPDATE``/``ON DELETE``.
# Fixed by Postgres's own FK grammar — not project-tunable.
_REFERENTIAL_ACTIONS: frozenset[str] = frozenset(
    {"NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"}
)

# The index access methods PostgreSQL ships with (``CREATE INDEX ... USING``).
# Fixed by Postgres's own catalog of built-in index AMs.
_INDEX_METHODS: frozenset[str] = frozenset({"btree", "hash", "gin", "gist", "spgist", "brin"})

# Indentation for each column line inside a multi-line CREATE TABLE body — four
# spaces, matching this module's own docstring/PEP 8 indent width, purely for a
# readable generated-SQL preview (Postgres does not care about whitespace).
_CREATE_TABLE_INDENT = "    "


def _column_clause(col: Mapping[str, Any]) -> str:
    """
    Build one column definition line for CREATE/ALTER TABLE.

    Args:
        col: a mapping with ``name`` (identifier), ``type`` (raw type string),
            ``nullable`` (bool), and ``default`` (raw expression, or falsy for
            none).

    Returns:
        ``"name" <type> [NOT NULL] [DEFAULT <expr>]`` — ``type``/``default``
        are inserted raw; ``name`` is quoted.
    """
    clause = f"{quote_ident(col['name'])} {col['type']}"

    if not col.get("nullable", True):
        clause += " NOT NULL"

    default = col.get("default")

    if default:
        clause += f" DEFAULT {default}"

    return clause


def create_table(
    schema: str,
    name: str,
    columns: Sequence[Mapping[str, Any]],
    *,
    if_not_exists: bool = False,
) -> str:
    """
    Build a ``CREATE TABLE`` statement from a column-definition list.

    Args:
        schema: the new table's schema.
        name: the new table's name.
        columns: each column's ``{name, type, nullable, default, primary_key}``
            (see ``_column_clause`` for the raw/quoted split). Columns flagged
            ``primary_key=True`` collect into one trailing table-level
            ``PRIMARY KEY`` clause (composite when several); no flagged column
            omits the clause entirely.
        if_not_exists: emit ``IF NOT EXISTS``.

    Raises:
        ValidationError: if ``columns`` is empty.

    Returns:
        A multi-line, human-reviewable ``CREATE TABLE "schema"."name" ( ... )``
        statement.
    """
    if not columns:
        raise ValidationError("CREATE TABLE requires at least one column")

    lines = [_column_clause(c) for c in columns]
    pk_columns = [c["name"] for c in columns if c.get("primary_key")]

    if pk_columns:
        pk_list = ", ".join(quote_ident(c) for c in pk_columns)
        lines.append(f"PRIMARY KEY ({pk_list})")

    body = ",\n".join(f"{_CREATE_TABLE_INDENT}{line}" for line in lines)
    exists_clause = "IF NOT EXISTS " if if_not_exists else ""

    return f"CREATE TABLE {exists_clause}{qualify(schema, name)} (\n{body}\n)"


def drop_table(schema: str, name: str, *, cascade: bool = False, if_exists: bool = False) -> str:
    """
    Build a ``DROP TABLE`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        cascade: emit ``CASCADE``; omitting it leaves Postgres's default
            ``RESTRICT`` (the keyword itself is never emitted).
        if_exists: emit ``IF EXISTS``.

    Returns:
        ``DROP TABLE [IF EXISTS] "schema"."name" [CASCADE]``.
    """
    exists_clause = "IF EXISTS " if if_exists else ""
    cascade_clause = " CASCADE" if cascade else ""

    return f"DROP TABLE {exists_clause}{qualify(schema, name)}{cascade_clause}"


def rename_table(schema: str, name: str, new_name: str) -> str:
    """
    Build a table-rename ``ALTER TABLE ... RENAME TO`` statement.

    Args:
        schema: the table's current schema.
        name: the table's current name.
        new_name: the new (unqualified) table name.

    Returns:
        ``ALTER TABLE "schema"."name" RENAME TO "new_name"``.
    """
    return f"ALTER TABLE {qualify(schema, name)} RENAME TO {quote_ident(new_name)}"


def add_column(schema: str, name: str, col: Mapping[str, Any]) -> str:
    """
    Build an ``ADD COLUMN`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        col: the new column's ``{name, type, nullable, default}`` (see
            ``_column_clause``).

    Returns:
        ``ALTER TABLE "schema"."name" ADD COLUMN <column clause>``.
    """
    return f"ALTER TABLE {qualify(schema, name)} ADD COLUMN {_column_clause(col)}"


def drop_column(schema: str, name: str, column: str, *, cascade: bool = False) -> str:
    """
    Build a ``DROP COLUMN`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        column: the column to drop.
        cascade: emit ``CASCADE``.

    Returns:
        ``ALTER TABLE "schema"."name" DROP COLUMN "column" [CASCADE]``.
    """
    cascade_clause = " CASCADE" if cascade else ""

    return f"ALTER TABLE {qualify(schema, name)} DROP COLUMN {quote_ident(column)}{cascade_clause}"


def rename_column(schema: str, name: str, column: str, new_name: str) -> str:
    """
    Build a ``RENAME COLUMN`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        column: the column's current name.
        new_name: the column's new name.

    Returns:
        ``ALTER TABLE "schema"."name" RENAME COLUMN "column" TO "new_name"``.
    """
    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"RENAME COLUMN {quote_ident(column)} TO {quote_ident(new_name)}"
    )


def alter_column_type(
    schema: str, name: str, column: str, new_type: str, *, using: str | None = None
) -> str:
    """
    Build an ``ALTER COLUMN ... TYPE`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        column: the column to retype.
        new_type: the new type, raw (e.g. ``numeric(10,2)``).
        using: an optional raw ``USING`` expression for a cast Postgres cannot
            infer automatically.

    Returns:
        ``ALTER TABLE "schema"."name" ALTER COLUMN "column" TYPE <new_type>
        [USING <using>]``.
    """
    using_clause = f" USING {using}" if using else ""

    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"ALTER COLUMN {quote_ident(column)} TYPE {new_type}{using_clause}"
    )


def set_not_null(schema: str, name: str, column: str) -> str:
    """
    Build a ``SET NOT NULL`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        column: the column to constrain.

    Returns:
        ``ALTER TABLE "schema"."name" ALTER COLUMN "column" SET NOT NULL``.
    """
    return f"ALTER TABLE {qualify(schema, name)} ALTER COLUMN {quote_ident(column)} SET NOT NULL"


def drop_not_null(schema: str, name: str, column: str) -> str:
    """
    Build a ``DROP NOT NULL`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        column: the column to relax.

    Returns:
        ``ALTER TABLE "schema"."name" ALTER COLUMN "column" DROP NOT NULL``.
    """
    return f"ALTER TABLE {qualify(schema, name)} ALTER COLUMN {quote_ident(column)} DROP NOT NULL"


def set_default(schema: str, name: str, column: str, default: str) -> str:
    """
    Build a ``SET DEFAULT`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        column: the column to default.
        default: the new default, raw (e.g. ``now()``).

    Returns:
        ``ALTER TABLE "schema"."name" ALTER COLUMN "column" SET DEFAULT
        <default>``.
    """
    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"ALTER COLUMN {quote_ident(column)} SET DEFAULT {default}"
    )


def drop_default(schema: str, name: str, column: str) -> str:
    """
    Build a ``DROP DEFAULT`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        column: the column whose default to drop.

    Returns:
        ``ALTER TABLE "schema"."name" ALTER COLUMN "column" DROP DEFAULT``.
    """
    return f"ALTER TABLE {qualify(schema, name)} ALTER COLUMN {quote_ident(column)} DROP DEFAULT"


def _constraint_prefix(constraint_name: str | None) -> str:
    """
    Build the ``ADD [CONSTRAINT "name"] `` prefix shared by every ``ADD``
    constraint builder.

    Args:
        constraint_name: an explicit constraint name, or ``None`` to let
            Postgres auto-name it.

    Returns:
        ``"ADD "`` or ``'ADD CONSTRAINT "name" '``.
    """
    if constraint_name:
        return f"ADD CONSTRAINT {quote_ident(constraint_name)} "

    return "ADD "


def add_primary_key(
    schema: str, name: str, columns: Sequence[str], *, constraint_name: str | None = None
) -> str:
    """
    Build an ``ADD PRIMARY KEY`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        columns: the key's columns, in order (composite when several).
        constraint_name: an explicit constraint name, or ``None`` to let
            Postgres auto-name it.

    Raises:
        ValidationError: if ``columns`` is empty.

    Returns:
        ``ALTER TABLE "schema"."name" ADD [CONSTRAINT "name"] PRIMARY KEY
        ("c1", "c2")``.
    """
    if not columns:
        raise ValidationError("PRIMARY KEY requires at least one column")

    col_list = ", ".join(quote_ident(c) for c in columns)

    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"{_constraint_prefix(constraint_name)}PRIMARY KEY ({col_list})"
    )


def add_unique(
    schema: str, name: str, columns: Sequence[str], *, constraint_name: str | None = None
) -> str:
    """
    Build an ``ADD UNIQUE`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        columns: the unique key's columns, in order.
        constraint_name: an explicit constraint name, or ``None`` to let
            Postgres auto-name it.

    Raises:
        ValidationError: if ``columns`` is empty.

    Returns:
        ``ALTER TABLE "schema"."name" ADD [CONSTRAINT "name"] UNIQUE ("c1",
        "c2")``.
    """
    if not columns:
        raise ValidationError("UNIQUE requires at least one column")

    col_list = ", ".join(quote_ident(c) for c in columns)

    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"{_constraint_prefix(constraint_name)}UNIQUE ({col_list})"
    )


def add_check(schema: str, name: str, expression: str, *, constraint_name: str | None = None) -> str:
    """
    Build an ``ADD CHECK`` statement.

    Args:
        schema: the table's schema.
        name: the table's name.
        expression: the check expression, raw (e.g. ``balance >= 0``).
        constraint_name: an explicit constraint name, or ``None`` to let
            Postgres auto-name it.

    Raises:
        ValidationError: if ``expression`` is blank.

    Returns:
        ``ALTER TABLE "schema"."name" ADD [CONSTRAINT "name"] CHECK
        (<expression>)``.
    """
    if not expression or not expression.strip():
        raise ValidationError("CHECK requires a non-blank expression")

    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"{_constraint_prefix(constraint_name)}CHECK ({expression})"
    )


def add_foreign_key(
    schema: str,
    name: str,
    columns: Sequence[str],
    ref_schema: str,
    ref_table: str,
    ref_columns: Sequence[str],
    *,
    constraint_name: str | None = None,
    on_update: str | None = None,
    on_delete: str | None = None,
) -> str:
    """
    Build an ``ADD FOREIGN KEY`` statement, possibly across schemas.

    Args:
        schema: the referencing table's schema.
        name: the referencing table's name.
        columns: the local foreign-key columns, in order.
        ref_schema: the referenced table's schema.
        ref_table: the referenced table's name.
        ref_columns: the referenced columns, positionally paired with
            ``columns``.
        constraint_name: an explicit constraint name, or ``None`` to let
            Postgres auto-name it.
        on_update: an ``ON UPDATE`` action, validated against
            ``_REFERENTIAL_ACTIONS``, or ``None`` to omit the clause.
        on_delete: an ``ON DELETE`` action, validated the same way.

    Raises:
        ValidationError: if ``columns``/``ref_columns`` is empty, their
            lengths differ, or ``on_update``/``on_delete`` is not a known
            referential action.

    Returns:
        ``ALTER TABLE "schema"."name" ADD [CONSTRAINT "name"] FOREIGN KEY
        ("c1") REFERENCES "ref_schema"."ref_table" ("rc1") [ON UPDATE <a>]
        [ON DELETE <a>]``.
    """
    if not columns or not ref_columns:
        raise ValidationError("FOREIGN KEY requires at least one column")

    if len(columns) != len(ref_columns):
        raise ValidationError("FOREIGN KEY columns and referenced columns must match in count")

    for action, label in ((on_update, "ON UPDATE"), (on_delete, "ON DELETE")):
        if action is not None and action not in _REFERENTIAL_ACTIONS:
            raise ValidationError(f"Unknown {label} action '{action}'")

    col_list = ", ".join(quote_ident(c) for c in columns)
    ref_col_list = ", ".join(quote_ident(c) for c in ref_columns)
    action_clause = "".join(
        f" {label} {action}"
        for action, label in ((on_update, "ON UPDATE"), (on_delete, "ON DELETE"))
        if action is not None
    )

    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"{_constraint_prefix(constraint_name)}FOREIGN KEY ({col_list}) "
        f"REFERENCES {qualify(ref_schema, ref_table)} ({ref_col_list}){action_clause}"
    )


def drop_constraint(schema: str, name: str, constraint_name: str, *, cascade: bool = False) -> str:
    """
    Build a ``DROP CONSTRAINT`` statement, dropping any constraint kind
    (primary key, unique, check, or foreign key) uniformly by name.

    Args:
        schema: the table's schema.
        name: the table's name.
        constraint_name: the constraint to drop.
        cascade: emit ``CASCADE``.

    Returns:
        ``ALTER TABLE "schema"."name" DROP CONSTRAINT "constraint_name"
        [CASCADE]``.
    """
    cascade_clause = " CASCADE" if cascade else ""

    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"DROP CONSTRAINT {quote_ident(constraint_name)}{cascade_clause}"
    )


def create_index(
    schema: str,
    table: str,
    columns: Sequence[str],
    *,
    name: str | None = None,
    unique: bool = False,
    method: str | None = None,
    if_not_exists: bool = False,
) -> str:
    """
    Build a ``CREATE INDEX`` statement.

    Args:
        schema: the table's schema.
        table: the table to index.
        columns: the indexed columns, in order.
        name: an explicit index name, or ``None`` to let Postgres auto-name it.
        unique: emit ``UNIQUE``.
        method: an index access method, validated against ``_INDEX_METHODS``,
            or ``None`` to use Postgres's default (btree).
        if_not_exists: emit ``IF NOT EXISTS`` (requires a ``name``, same as
            Postgres itself).

    Raises:
        ValidationError: if ``columns`` is empty or ``method`` is not a known
            access method.

    Returns:
        ``CREATE [UNIQUE] INDEX [IF NOT EXISTS] ["name"] ON "schema"."table"
        [USING <method>] ("c1", "c2")``.
    """
    if not columns:
        raise ValidationError("CREATE INDEX requires at least one column")

    if method is not None and method not in _INDEX_METHODS:
        raise ValidationError(f"Unknown index method '{method}'")

    col_list = ", ".join(quote_ident(c) for c in columns)

    tokens = [
        "CREATE",
        "UNIQUE" if unique else None,
        "INDEX",
        "IF NOT EXISTS" if if_not_exists else None,
        quote_ident(name) if name else None,
        "ON",
        qualify(schema, table),
        f"USING {method}" if method else None,
        f"({col_list})",
    ]

    return " ".join(t for t in tokens if t is not None)


def drop_index(schema: str, index_name: str, *, cascade: bool = False, if_exists: bool = False) -> str:
    """
    Build a ``DROP INDEX`` statement. Indexes are schema-scoped objects in
    Postgres, so they are dropped by qualified index name, not by table.

    Args:
        schema: the index's schema.
        index_name: the index to drop.
        cascade: emit ``CASCADE``.
        if_exists: emit ``IF EXISTS``.

    Returns:
        ``DROP INDEX [IF EXISTS] "schema"."index_name" [CASCADE]``.
    """
    exists_clause = "IF EXISTS " if if_exists else ""
    cascade_clause = " CASCADE" if cascade else ""

    return f"DROP INDEX {exists_clause}{qualify(schema, index_name)}{cascade_clause}"
