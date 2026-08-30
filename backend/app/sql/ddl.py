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

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from ..errors import ValidationError
from .compiler import quote_ident

__all__ = [
    "quote_ident",
    "qualify",
    "ident_list",
    "quote_literal",
    "require_text",
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
    "create_view",
    "drop_view",
    "create_materialized_view",
    "drop_materialized_view",
    "refresh_materialized_view",
    "replace_materialized_view",
    "RESTART_DEFAULT",
    "schema_create",
    "schema_drop",
    "schema_rename",
    "sequence_create",
    "sequence_alter",
    "sequence_set_owner",
    "sequence_drop",
    "FunctionArg",
    "CompositeAttr",
    "CreateRoutineSpec",
    "render_function_arg",
    "create_routine",
    "drop_routine",
    "create_enum_type",
    "create_composite_type",
    "drop_type",
    "alter_type_add_value",
    "alter_type_add_attribute",
    "alter_type_drop_attribute",
    "alter_type_alter_attribute_type",
    "alter_type_rename_attribute",
    "alter_type_rename_value",
    "EnumColumnDependency",
    "recreate_enum_type",
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


def ident_list(names: Iterable[str]) -> str:
    """
    Return a comma-separated list of double-quoted identifiers, for a
    ``(col1, col2, ...)`` clause.

    Args:
        names: the identifiers to quote and join, in order.

    Returns:
        Each name double-quoted, joined by ``", "`` — ``""`` for an empty input.
    """
    return ", ".join(quote_ident(n) for n in names)


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


def require_text(value: object, label: str) -> str:
    """
    Validate a required field is a non-blank string.

    Args:
        value: the field's value — accepts ``object`` so a caller can pass an
            unvalidated wire value straight through (a preview spec's field may
            be any JSON type) without checking its type first.
        label: the field name, used in the error message.

    Raises:
        ValidationError: if ``value`` is not a string, or is blank.

    Returns:
        ``value``, unchanged.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"'{label}' is required")

    return value


def _drop_statement(keyword: str, target: str, *, cascade: bool, if_exists: bool) -> str:
    """
    Build a ``DROP <keyword> [IF EXISTS] <target> [CASCADE]`` statement — the
    shape every ``DROP`` builder in this module shares.

    Args:
        keyword: the SQL keyword after ``DROP`` (e.g. ``"TABLE"``, ``"VIEW"``).
        target: the already-quoted/qualified object reference.
        cascade: emit ``CASCADE``; omitting it leaves Postgres's default
            ``RESTRICT`` (the keyword itself is never emitted).
        if_exists: emit ``IF EXISTS``.

    Returns:
        ``DROP <keyword> [IF EXISTS] <target> [CASCADE]``.
    """
    exists_clause = "IF EXISTS " if if_exists else ""
    cascade_clause = " CASCADE" if cascade else ""

    return f"DROP {keyword} {exists_clause}{target}{cascade_clause}"


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
        lines.append(f"PRIMARY KEY ({ident_list(pk_columns)})")

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
    return _drop_statement("TABLE", qualify(schema, name), cascade=cascade, if_exists=if_exists)


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


def _add_key_constraint(
    schema: str, name: str, columns: Sequence[str], keyword: str, *, constraint_name: str | None
) -> str:
    """
    Build an ``ADD [CONSTRAINT "name"] <keyword> (...)`` statement — the shape
    ``add_primary_key`` and ``add_unique`` share, differing only in keyword.

    Args:
        schema: the table's schema.
        name: the table's name.
        columns: the key's columns, in order (composite when several).
        keyword: ``"PRIMARY KEY"`` or ``"UNIQUE"``.
        constraint_name: an explicit constraint name, or ``None`` to let
            Postgres auto-name it.

    Raises:
        ValidationError: if ``columns`` is empty.

    Returns:
        ``ALTER TABLE "schema"."name" ADD [CONSTRAINT "name"] <keyword>
        ("c1", "c2")``.
    """
    if not columns:
        raise ValidationError(f"{keyword} requires at least one column")

    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"{_constraint_prefix(constraint_name)}{keyword} ({ident_list(columns)})"
    )


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
    return _add_key_constraint(schema, name, columns, "PRIMARY KEY", constraint_name=constraint_name)


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
    return _add_key_constraint(schema, name, columns, "UNIQUE", constraint_name=constraint_name)


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

    action_clause = "".join(
        f" {label} {action}"
        for action, label in ((on_update, "ON UPDATE"), (on_delete, "ON DELETE"))
        if action is not None
    )

    return (
        f"ALTER TABLE {qualify(schema, name)} "
        f"{_constraint_prefix(constraint_name)}FOREIGN KEY ({ident_list(columns)}) "
        f"REFERENCES {qualify(ref_schema, ref_table)} ({ident_list(ref_columns)}){action_clause}"
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

    tokens = [
        "CREATE",
        "UNIQUE" if unique else None,
        "INDEX",
        "IF NOT EXISTS" if if_not_exists else None,
        quote_ident(name) if name else None,
        "ON",
        qualify(schema, table),
        f"USING {method}" if method else None,
        f"({ident_list(columns)})",
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
    return _drop_statement("INDEX", qualify(schema, index_name), cascade=cascade, if_exists=if_exists)


# --- View / matview DDL ---------------------------------------------------------
#
# Builders for CREATE/DROP/RENAME VIEW and MATERIALIZED VIEW, REFRESH
# MATERIALIZED VIEW, and the DROP+CREATE matview "replace" pair a matview body
# edit runs as one previewed, semicolon-joined statement (view-matview-ddl
# phase). A regular view supports CREATE OR REPLACE in place; a materialized
# view does not, so editing its body is a DROP followed by a CREATE, run
# atomically through the shared ExecuteDdlCommand's transaction wrap (see
# plans/implemented/view-matview-ddl.md's "Matview edit strategy" decision).
# Names are quoted via quote_ident/qualify; the ``select`` SELECT body is a
# raw SQL fragment, inserted verbatim and reviewed in the editable preview
# before execute (the ddl-infrastructure trust model).


def create_view(
    schema: str,
    name: str,
    select: str,
    *,
    or_replace: bool = False,
    columns: Sequence[str] | None = None,
) -> str:
    """
    Build a ``CREATE [OR REPLACE] VIEW`` statement.

    Args:
        schema: the view's schema.
        name: the view's name.
        select: the backing ``SELECT``, raw (reviewed in the editable preview
            before execute).
        or_replace: emit ``OR REPLACE`` — the in-place way to edit an
            existing view's definition without dropping it.
        columns: optional column aliases, in order; ``None``/empty omits the
            clause and lets Postgres name the output columns from the query.

    Returns:
        ``CREATE [OR REPLACE] VIEW "schema"."name" [("c1", "c2")] AS
        <select>``.
    """
    replace_clause = "OR REPLACE " if or_replace else ""
    columns_clause = f" ({ident_list(columns)})" if columns else ""

    return f"CREATE {replace_clause}VIEW {qualify(schema, name)}{columns_clause} AS\n{select}"


def drop_view(schema: str, name: str, *, cascade: bool = False, if_exists: bool = False) -> str:
    """
    Build a ``DROP VIEW`` statement.

    Args:
        schema: the view's schema.
        name: the view's name.
        cascade: emit ``CASCADE``; omitting it leaves Postgres's default
            ``RESTRICT``.
        if_exists: emit ``IF EXISTS``.

    Returns:
        ``DROP VIEW [IF EXISTS] "schema"."name" [CASCADE]``.
    """
    return _drop_statement("VIEW", qualify(schema, name), cascade=cascade, if_exists=if_exists)


def create_materialized_view(schema: str, name: str, select: str, *, with_data: bool = True) -> str:
    """
    Build a ``CREATE MATERIALIZED VIEW`` statement.

    Args:
        schema: the matview's schema.
        name: the matview's name.
        select: the backing ``SELECT``, raw.
        with_data: populate the matview immediately (``WITH DATA``, the
            default); ``False`` emits ``WITH NO DATA`` (unscannable until a
            later ``REFRESH``).

    Returns:
        ``CREATE MATERIALIZED VIEW "schema"."name" AS
        <select>
        WITH [NO] DATA``.
    """
    data_clause = "WITH DATA" if with_data else "WITH NO DATA"

    return f"CREATE MATERIALIZED VIEW {qualify(schema, name)} AS\n{select}\n{data_clause}"


def drop_materialized_view(schema: str, name: str, *, cascade: bool = False, if_exists: bool = False) -> str:
    """
    Build a ``DROP MATERIALIZED VIEW`` statement.

    Args:
        schema: the matview's schema.
        name: the matview's name.
        cascade: emit ``CASCADE`` — also drops dependent objects, and (as the
            drop half of ``replace_materialized_view``) any dependents the
            CREATE half does not recreate.
        if_exists: emit ``IF EXISTS``.

    Returns:
        ``DROP MATERIALIZED VIEW [IF EXISTS] "schema"."name" [CASCADE]``.
    """
    return _drop_statement(
        "MATERIALIZED VIEW", qualify(schema, name), cascade=cascade, if_exists=if_exists
    )


def refresh_materialized_view(
    schema: str, name: str, *, concurrently: bool = False, with_no_data: bool = False
) -> str:
    """
    Build a ``REFRESH MATERIALIZED VIEW`` statement.

    ``CONCURRENTLY`` requires a unique index on the matview, and combining it
    with ``WITH NO DATA`` is rejected by Postgres — this builder does not
    guard either constraint (the form disables the illegal combination
    client-side; Postgres itself is authoritative for the unique-index
    requirement — see the view-matview-ddl plan's "Potential Challenges").

    Args:
        schema: the matview's schema.
        name: the matview's name.
        concurrently: emit ``CONCURRENTLY`` (refresh without locking readers
            out; needs a unique index).
        with_no_data: emit ``WITH NO DATA`` (clear the matview to
            unscannable instead of repopulating it).

    Returns:
        ``REFRESH MATERIALIZED VIEW [CONCURRENTLY] "schema"."name" [WITH NO
        DATA]``.
    """
    concurrently_clause = "CONCURRENTLY " if concurrently else ""
    data_clause = " WITH NO DATA" if with_no_data else ""

    return f"REFRESH MATERIALIZED VIEW {concurrently_clause}{qualify(schema, name)}{data_clause}"


def replace_materialized_view(
    schema: str, name: str, select: str, *, cascade: bool = False, with_data: bool = True
) -> str:
    """
    Build the ``DROP; CREATE`` pair that edits a materialized view's body —
    a matview cannot be ``CREATE OR REPLACE``d, so an edit drops it and
    recreates it under the same name, semicolon-joined into the one
    statement the matview-edit dialog previews and runs atomically through
    the shared ``ExecuteDdlCommand`` (its transaction wrap rolls the DROP
    back if the CREATE fails — see the view-matview-ddl plan's "Matview edit
    strategy" decision).

    Args:
        schema: the matview's schema.
        name: the matview's name (unchanged across the replace).
        select: the new backing ``SELECT``, raw.
        cascade: emit ``CASCADE`` on the DROP half — also drops dependent
            objects, which the CREATE half does not recreate.
        with_data: populate the recreated matview immediately (the CREATE
            half's ``WITH [NO] DATA``).

    Returns:
        ``drop_materialized_view(...) + ";\\n" + create_materialized_view(...)``
        — the single ``;``-joined statement.
    """
    drop_sql = drop_materialized_view(schema, name, cascade=cascade)
    create_sql = create_materialized_view(schema, name, select, with_data=with_data)

    return f"{drop_sql};\n{create_sql}"


# --- Schema / sequence DDL -------------------------------------------------------
#
# Builders for CREATE/DROP/RENAME SCHEMA and CREATE/ALTER/OWNER/DROP SEQUENCE
# (schema-sequence-ddl phase). Unlike the table/view builders above, every
# required identifier here is validated *in the builder itself* (raising
# ValidationError on a blank name), per this phase's Public API — schemas and
# sequences have no free-form expression slots to review in a preview editor
# (every numeric option is validated as an integer, not a raw fragment), so
# there is no equivalent "reviewed in the editable preview" trust boundary to
# lean on. Names are quoted via quote_ident/qualify; required identifiers are
# validated via the shared ``require_text``.


def schema_create(name: str, authorization: str | None = None) -> str:
    """
    Build a ``CREATE SCHEMA`` statement.

    Args:
        name: the new schema's name.
        authorization: an optional owning role for ``AUTHORIZATION``.

    Raises:
        ValidationError: if ``name`` is blank.

    Returns:
        ``CREATE SCHEMA "name" [AUTHORIZATION "owner"]``.
    """
    require_text(name, "name")

    auth_clause = f" AUTHORIZATION {quote_ident(authorization)}" if authorization else ""

    return f"CREATE SCHEMA {quote_ident(name)}{auth_clause}"


def schema_drop(name: str, *, cascade: bool = False, if_exists: bool = False) -> str:
    """
    Build a ``DROP SCHEMA`` statement.

    Args:
        name: the schema to drop.
        cascade: emit ``CASCADE`` — also drops every object the schema
            contains.
        if_exists: emit ``IF EXISTS``.

    Raises:
        ValidationError: if ``name`` is blank.

    Returns:
        ``DROP SCHEMA [IF EXISTS] "name" [CASCADE]``.
    """
    require_text(name, "name")

    return _drop_statement("SCHEMA", quote_ident(name), cascade=cascade, if_exists=if_exists)


def schema_rename(name: str, new_name: str) -> str:
    """
    Build a schema-rename ``ALTER SCHEMA ... RENAME TO`` statement.

    Args:
        name: the schema's current name.
        new_name: the schema's new name.

    Raises:
        ValidationError: if ``name`` or ``new_name`` is blank.

    Returns:
        ``ALTER SCHEMA "name" RENAME TO "new_name"``.
    """
    require_text(name, "name")
    require_text(new_name, "newName")

    return f"ALTER SCHEMA {quote_ident(name)} RENAME TO {quote_ident(new_name)}"


# A sentinel for `sequence_alter`'s `restart` parameter, distinguishing a bare
# `RESTART` (reset to the sequence's start value) from `RESTART WITH n`.
# Compared via `is`, never `==`, so it can never collide with a real int.
class _RestartDefaultType:
    """
    The type of the ``RESTART_DEFAULT`` sentinel (see module docstring).
    """

    def __repr__(self) -> str:
        return "RESTART_DEFAULT"


RESTART_DEFAULT = _RestartDefaultType()

# The data types PostgreSQL permits for a sequence's `AS <type>` clause
# (`sequence_alter`'s `data_type`), including its short aliases. Fixed by
# Postgres's own sequence grammar — not project-tunable (mirrors
# `_REFERENTIAL_ACTIONS`/`_INDEX_METHODS`'s allowlist style).
_SEQUENCE_TYPES: frozenset[str] = frozenset(
    {"smallint", "integer", "bigint", "int2", "int4", "int8"}
)


def _sequence_bound_clauses(
    *,
    increment: int | None,
    min_value: int | None,
    max_value: int | None,
    start: int | None,
    cache: int | None,
) -> list[str]:
    """
    Build the sequence option clauses CREATE and ALTER share, in Postgres's
    documented clause order, skipping every option left unset.
    """
    parts: list[str] = []

    if increment is not None:
        parts.append(f"INCREMENT BY {int(increment)}")
    if min_value is not None:
        parts.append(f"MINVALUE {int(min_value)}")
    if max_value is not None:
        parts.append(f"MAXVALUE {int(max_value)}")
    if start is not None:
        parts.append(f"START WITH {int(start)}")
    if cache is not None:
        parts.append(f"CACHE {int(cache)}")

    return parts


def sequence_create(
    schema: str,
    name: str,
    *,
    increment: int | None = None,
    start: int | None = None,
    min_value: int | None = None,
    max_value: int | None = None,
    cache: int | None = None,
    cycle: bool = False,
    owned_by: tuple[str, str, str] | None = None,
) -> str:
    """
    Build a ``CREATE SEQUENCE`` statement.

    Args:
        schema: the new sequence's schema.
        name: the new sequence's name.
        increment: ``INCREMENT BY`` — omitted lets Postgres default to 1.
        start: ``START WITH`` — omitted lets Postgres default to min/1.
        min_value: ``MINVALUE`` — omitted lets Postgres pick its default.
        max_value: ``MAXVALUE`` — omitted lets Postgres pick its default.
        cache: ``CACHE`` — omitted lets Postgres default to 1.
        cycle: emit ``CYCLE``; omitting it leaves Postgres's default
            (no cycling — an exhausted sequence raises).
        owned_by: an optional ``(schema, table, column)`` triple rendered as
            ``OWNED BY "schema"."table"."column"``.

    Raises:
        ValidationError: if ``name`` is blank.

    Returns:
        ``CREATE SEQUENCE "schema"."name"`` with each provided option, in
        canonical grammar order: ``INCREMENT BY``, ``MINVALUE``, ``MAXVALUE``,
        ``START WITH``, ``CACHE``, ``CYCLE``, ``OWNED BY``.
    """
    require_text(name, "name")

    parts = [f"CREATE SEQUENCE {qualify(schema, name)}"]
    parts.extend(_sequence_bound_clauses(
        increment=increment, min_value=min_value, max_value=max_value, start=start, cache=cache,
    ))

    if cycle:
        parts.append("CYCLE")
    if owned_by:
        owner_schema, owner_table, owner_column = owned_by
        parts.append(f"OWNED BY {qualify(owner_schema, owner_table)}.{quote_ident(owner_column)}")

    return " ".join(parts)


def sequence_alter(
    schema: str,
    name: str,
    *,
    data_type: str | None = None,
    restart: int | _RestartDefaultType | None = None,
    increment: int | None = None,
    start: int | None = None,
    min_value: int | None = None,
    max_value: int | None = None,
    cache: int | None = None,
    cycle: bool | None = None,
) -> str:
    """
    Build an ``ALTER SEQUENCE`` parameter-form statement.

    Args:
        schema: the sequence's schema.
        name: the sequence's name.
        data_type: ``AS <type>`` — ``None`` omits the clause; otherwise
            validated case-insensitively against ``_SEQUENCE_TYPES``.
        restart: ``None`` omits the clause; ``RESTART_DEFAULT`` emits a bare
            ``RESTART`` (reset to the sequence's start value); an ``int``
            emits ``RESTART WITH n``.
        increment: ``INCREMENT BY`` — ``None`` omits the clause.
        start: ``START WITH`` — ``None`` omits the clause.
        min_value: ``MINVALUE`` — ``None`` omits the clause.
        max_value: ``MAXVALUE`` — ``None`` omits the clause.
        cache: ``CACHE`` — ``None`` omits the clause.
        cycle: ``None`` omits the clause; ``True`` emits ``CYCLE``; ``False``
            emits ``NO CYCLE``.

    Raises:
        ValidationError: if ``name`` is blank, if ``data_type`` is not a
            recognized sequence type, or if every option is omitted (an
            empty ``ALTER SEQUENCE`` is meaningless).

    Returns:
        ``ALTER SEQUENCE "schema"."name"`` with each provided option, in
        canonical grammar order: ``AS``, ``INCREMENT BY``, ``MINVALUE``,
        ``MAXVALUE``, ``START WITH``, ``RESTART``, ``CACHE``, ``CYCLE``.
    """
    require_text(name, "name")

    parts = [f"ALTER SEQUENCE {qualify(schema, name)}"]

    if data_type is not None:
        if data_type.lower() not in _SEQUENCE_TYPES:
            raise ValidationError(f"Unsupported sequence data type '{data_type}'")
        parts.append(f"AS {data_type}")

    # RESTART sits between START WITH and CACHE in the canonical clause order,
    # so the five shared bound clauses are built in two calls rather than one
    # contiguous block: increment/min/max/start first, then RESTART, then cache.
    parts.extend(_sequence_bound_clauses(
        increment=increment, min_value=min_value, max_value=max_value, start=start, cache=None,
    ))

    if restart is RESTART_DEFAULT:
        parts.append("RESTART")
    elif restart is not None:
        parts.append(f"RESTART WITH {int(restart)}")  # type: ignore[arg-type]

    parts.extend(_sequence_bound_clauses(
        increment=None, min_value=None, max_value=None, start=None, cache=cache,
    ))

    if cycle is True:
        parts.append("CYCLE")
    elif cycle is False:
        parts.append("NO CYCLE")

    if len(parts) == 1:
        raise ValidationError("ALTER SEQUENCE requires at least one option")

    return " ".join(parts)


def sequence_set_owner(schema: str, name: str, owner: str) -> str:
    """
    Build a sequence ``OWNER TO`` statement — a separate grammar variant from
    the parameter form (see ``sequence_alter``), since Postgres cannot
    combine them in one ``ALTER SEQUENCE`` statement.

    Args:
        schema: the sequence's schema.
        name: the sequence's name.
        owner: the new owning role.

    Raises:
        ValidationError: if ``name`` or ``owner`` is blank.

    Returns:
        ``ALTER SEQUENCE "schema"."name" OWNER TO "owner"``.
    """
    require_text(name, "name")
    require_text(owner, "owner")

    return f"ALTER SEQUENCE {qualify(schema, name)} OWNER TO {quote_ident(owner)}"


def sequence_drop(schema: str, name: str, *, cascade: bool = False, if_exists: bool = False) -> str:
    """
    Build a ``DROP SEQUENCE`` statement.

    Args:
        schema: the sequence's schema.
        name: the sequence's name.
        cascade: emit ``CASCADE``.
        if_exists: emit ``IF EXISTS``.

    Raises:
        ValidationError: if ``name`` is blank.

    Returns:
        ``DROP SEQUENCE [IF EXISTS] "schema"."name" [CASCADE]``.
    """
    require_text(name, "name")

    return _drop_statement("SEQUENCE", qualify(schema, name), cascade=cascade, if_exists=if_exists)


# --- Function/procedure & custom-type DDL ----------------------------------------
#
# Builders for CREATE [OR REPLACE] FUNCTION|PROCEDURE, DROP FUNCTION|PROCEDURE
# (by full identity signature, disambiguating overloads), CREATE TYPE (enum and
# composite), DROP TYPE, ALTER TYPE ADD VALUE, the four composite ALTER
# ATTRIBUTE actions (add/drop/retype/rename), ALTER TYPE RENAME VALUE, and the
# enum recreate-and-migrate script (type-panel-inline-editing phase — Postgres
# has no ALTER TYPE ... DROP VALUE, so deleting an enum label recreates the
# type and migrates every dependent column instead). Identifiers
# (schema/name/arg-name/attr-name) are quoted via quote_ident/
# qualify and validated here, same as schema/sequence DDL. Raw type strings,
# defaults, function bodies, and enum labels are NOT identifiers — a function
# body is inherently opaque SQL and cannot be parameterized — so they pass
# through as the user typed them, reviewed in the editable preview before
# execute (the ddl-infrastructure trust model). Enum labels are string
# literals, quoted via quote_literal.

# The argument modes PostgreSQL's CREATE FUNCTION/PROCEDURE grammar accepts. A
# mode is a keyword (not a passthrough expression), so it is validated against
# this fixed allowlist rather than inserted raw.
_ARG_MODES: frozenset[str] = frozenset({"IN", "OUT", "INOUT", "VARIADIC"})

# The routine languages this app's function form offers. LANGUAGE is a
# keyword (not a passthrough expression, like a function's raw type strings/
# defaults/body), so it is validated against this fixed allowlist rather than
# inserted raw — adding another language is a one-line change with a test.
_ROUTINE_LANGUAGES: frozenset[str] = frozenset({"sql", "plpgsql"})

# The volatility categories PostgreSQL's CREATE FUNCTION grammar accepts. Also
# a keyword, validated the same way as _ROUTINE_LANGUAGES above.
_VOLATILITIES: frozenset[str] = frozenset({"IMMUTABLE", "STABLE", "VOLATILE"})


@dataclass(frozen=True)
class FunctionArg:
    """
    One CREATE FUNCTION/PROCEDURE argument.
    """

    type: str
    name: str | None = None
    mode: str | None = None
    default: str | None = None


@dataclass(frozen=True)
class CompositeAttr:
    """
    One composite-type attribute.
    """

    name: str
    type: str


@dataclass(frozen=True)
class CreateRoutineSpec:
    """
    A CREATE [OR REPLACE] FUNCTION|PROCEDURE request.
    """

    schema: str
    name: str
    kind: str
    args: list[FunctionArg] = field(default_factory=list)
    language: str = "sql"
    body: str = ""
    returns: str | None = None
    volatility: str | None = None
    replace: bool = False


def render_function_arg(arg: FunctionArg) -> str:
    """
    Build one argument clause for a CREATE FUNCTION/PROCEDURE argument list.

    Args:
        arg: the argument's mode/name/type/default.

    Raises:
        ValidationError: if ``arg.mode`` is set but not one of IN/OUT/INOUT/
            VARIADIC (case-insensitive).

    Returns:
        ``[MODE ]["name" ]type[ DEFAULT expr]`` — ``type``/``default`` are raw;
        ``name`` is quoted.
    """
    tokens: list[str] = []

    if arg.mode:
        mode = arg.mode.upper()

        if mode not in _ARG_MODES:
            raise ValidationError(f"Unknown argument mode '{arg.mode}'")

        tokens.append(mode)

    if arg.name:
        tokens.append(quote_ident(arg.name))

    tokens.append(arg.type)

    if arg.default:
        tokens.append(f"DEFAULT {arg.default}")

    return " ".join(tokens)


def _dollar_quote(body: str) -> str:
    """
    Wrap a function/procedure body in a dollar-quote tag not present in it.

    Tries ``$function$`` first, falling back to ``$func_1$``, ``$func_2$``, …
    until a tag that does not collide with the body's own text is found — a
    body that happens to contain a dollar-quote tag (rare, but not
    impossible in hand-written SQL) would otherwise terminate the string
    early.

    Args:
        body: the raw function/procedure body text.

    Returns:
        The body wrapped as ``<tag>\\n<body>\\n<tag>``.
    """
    tag = "$function$"
    suffix = 1

    while tag in body:
        tag = f"$func_{suffix}$"
        suffix += 1

    return f"{tag}\n{body}\n{tag}"


def create_routine(spec: CreateRoutineSpec) -> str:
    """
    Build a ``CREATE [OR REPLACE] FUNCTION|PROCEDURE`` statement.

    Args:
        spec: the routine's schema/name/kind/args/language/body and (for a
            function) its optional return type/volatility.

    Raises:
        ValidationError: if ``spec.schema``/``spec.name`` is blank, an
            argument's mode is invalid (see ``render_function_arg``),
            ``spec.language`` is not a recognized routine language, or
            ``spec.volatility`` is set and not a recognized volatility.

    Returns:
        A multi-line, human-reviewable ``CREATE [OR REPLACE]
        FUNCTION|PROCEDURE "schema"."name"(args) [RETURNS type] LANGUAGE lang
        [volatility] AS <dollar-quoted body>`` statement. No trailing
        semicolon (matches ``pg_get_functiondef``).
    """
    require_text(spec.schema, "schema")
    require_text(spec.name, "name")

    if spec.language.lower() not in _ROUTINE_LANGUAGES:
        raise ValidationError(f"Unknown routine language '{spec.language}'")

    if spec.kind == "function" and spec.volatility and spec.volatility.upper() not in _VOLATILITIES:
        raise ValidationError(f"Unknown volatility '{spec.volatility}'")

    keyword = "FUNCTION" if spec.kind == "function" else "PROCEDURE"
    replace_clause = "OR REPLACE " if spec.replace else ""
    args_sql = ", ".join(render_function_arg(a) for a in spec.args)

    lines = [f"CREATE {replace_clause}{keyword} {qualify(spec.schema, spec.name)}({args_sql})"]

    if spec.kind == "function" and spec.returns:
        lines.append(f"RETURNS {spec.returns}")

    lines.append(f" LANGUAGE {spec.language}")

    if spec.kind == "function" and spec.volatility:
        lines.append(spec.volatility)

    lines.append(f"AS {_dollar_quote(spec.body)}")

    return "\n".join(lines)


def drop_routine(
    schema: str, name: str, kind: str, signature: str, *, cascade: bool = False, if_exists: bool = False
) -> str:
    """
    Build a ``DROP FUNCTION|PROCEDURE`` statement, disambiguating overloads by
    the routine's full identity-argument signature.

    Args:
        schema: the routine's schema.
        name: the routine's name.
        kind: ``"function"`` or ``"procedure"``.
        signature: the raw identity-argument list from introspection (e.g.
            ``pg_get_function_identity_arguments``); may be ``""`` for a
            zero-argument routine.
        cascade: emit ``CASCADE``.
        if_exists: emit ``IF EXISTS``.

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``DROP FUNCTION|PROCEDURE [IF EXISTS] "schema"."name"(signature)
        [CASCADE]``.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    keyword = "FUNCTION" if kind == "function" else "PROCEDURE"

    return _drop_statement(
        keyword, f"{qualify(schema, name)}({signature})", cascade=cascade, if_exists=if_exists
    )


def create_enum_type(schema: str, name: str, labels: Sequence[str]) -> str:
    """
    Build a ``CREATE TYPE ... AS ENUM`` statement.

    Args:
        schema: the new type's schema.
        name: the new type's name.
        labels: the enum's labels, in order.

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``CREATE TYPE "schema"."name" AS ENUM ('l1', 'l2', ...)`` — labels are
        quoted via ``quote_literal``.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    labels_sql = ", ".join(quote_literal(label) for label in labels)

    return f"CREATE TYPE {qualify(schema, name)} AS ENUM ({labels_sql})"


# Indentation for each attribute line inside a multi-line CREATE TYPE ... AS
# (...) body — matches _CREATE_TABLE_INDENT's 4-space readable-preview width.
_CREATE_TYPE_INDENT = _CREATE_TABLE_INDENT


def create_composite_type(schema: str, name: str, attrs: Sequence[CompositeAttr]) -> str:
    """
    Build a ``CREATE TYPE ... AS (...)`` composite-type statement.

    Args:
        schema: the new type's schema.
        name: the new type's name.
        attrs: the composite's attributes, in order.

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``CREATE TYPE "schema"."name" AS (\\n    "a1" t1,\\n    "a2" t2\\n)`` —
        attribute names are quoted; types are raw.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    lines = [f"{quote_ident(a.name)} {a.type}" for a in attrs]
    body = ",\n".join(f"{_CREATE_TYPE_INDENT}{line}" for line in lines)

    return f"CREATE TYPE {qualify(schema, name)} AS (\n{body}\n)"


def drop_type(schema: str, name: str, *, cascade: bool = False, if_exists: bool = False) -> str:
    """
    Build a ``DROP TYPE`` statement.

    Args:
        schema: the type's schema.
        name: the type's name.
        cascade: emit ``CASCADE``.
        if_exists: emit ``IF EXISTS``.

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``DROP TYPE [IF EXISTS] "schema"."name" [CASCADE]``.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    return _drop_statement("TYPE", qualify(schema, name), cascade=cascade, if_exists=if_exists)


def alter_type_add_value(
    schema: str, name: str, value: str, position: tuple[str, str] | None = None
) -> str:
    """
    Build an ``ALTER TYPE ... ADD VALUE`` statement, appending one label to an
    existing enum type.

    Args:
        schema: the enum type's schema.
        name: the enum type's name.
        value: the new label to add.
        position: ``("before"|"after", existing_label)`` to place the new
            label relative to an existing one, or ``None`` to append it at
            the end (Postgres's default ``ADD VALUE`` placement).

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``ALTER TYPE "schema"."name" ADD VALUE 'value' [BEFORE|AFTER
        'existing']`` — ``value``/``existing`` are quoted via
        ``quote_literal``.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    position_clause = ""

    if position is not None:
        placement, existing = position
        keyword = "BEFORE" if placement == "before" else "AFTER"
        position_clause = f" {keyword} {quote_literal(existing)}"

    return f"ALTER TYPE {qualify(schema, name)} ADD VALUE {quote_literal(value)}{position_clause}"


def alter_type_add_attribute(schema: str, name: str, attr: CompositeAttr) -> str:
    """
    Build an ``ALTER TYPE ... ADD ATTRIBUTE`` statement.

    Args:
        schema: the composite type's schema.
        name: the composite type's name.
        attr: the attribute to add.

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``ALTER TYPE "schema"."name" ADD ATTRIBUTE "attr.name" attr.type`` —
        the attribute name is quoted; its type is raw.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    return f"ALTER TYPE {qualify(schema, name)} ADD ATTRIBUTE {quote_ident(attr.name)} {attr.type}"


def alter_type_drop_attribute(schema: str, name: str, attribute: str) -> str:
    """
    Build an ``ALTER TYPE ... DROP ATTRIBUTE`` statement.

    Args:
        schema: the composite type's schema.
        name: the composite type's name.
        attribute: the attribute to drop.

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``ALTER TYPE "schema"."name" DROP ATTRIBUTE "attribute"``.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    return f"ALTER TYPE {qualify(schema, name)} DROP ATTRIBUTE {quote_ident(attribute)}"


def alter_type_alter_attribute_type(schema: str, name: str, attribute: str, new_type: str) -> str:
    """
    Build an ``ALTER TYPE ... ALTER ATTRIBUTE ... TYPE`` statement.

    Args:
        schema: the composite type's schema.
        name: the composite type's name.
        attribute: the attribute to retype.
        new_type: the attribute's new type, raw.

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``ALTER TYPE "schema"."name" ALTER ATTRIBUTE "attribute" TYPE
        new_type``.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    return f"ALTER TYPE {qualify(schema, name)} ALTER ATTRIBUTE {quote_ident(attribute)} TYPE {new_type}"


def alter_type_rename_attribute(schema: str, name: str, attribute: str, new_name: str) -> str:
    """
    Build an ``ALTER TYPE ... RENAME ATTRIBUTE`` statement.

    Args:
        schema: the composite type's schema.
        name: the composite type's name.
        attribute: the attribute's current name.
        new_name: the attribute's new name.

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``ALTER TYPE "schema"."name" RENAME ATTRIBUTE "attribute" TO
        "new_name"``.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    return (
        f"ALTER TYPE {qualify(schema, name)} RENAME ATTRIBUTE "
        f"{quote_ident(attribute)} TO {quote_ident(new_name)}"
    )


def alter_type_rename_value(schema: str, name: str, value: str, new_value: str) -> str:
    """
    Build an ``ALTER TYPE ... RENAME VALUE`` statement, renaming one existing
    enum label in place.

    Args:
        schema: the enum type's schema.
        name: the enum type's name.
        value: the label as the database currently has it.
        new_value: the label's new text.

    Raises:
        ValidationError: if ``schema``/``name`` is blank.

    Returns:
        ``ALTER TYPE "schema"."name" RENAME VALUE 'value' TO 'new_value'`` —
        both labels are quoted via ``quote_literal``.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    return (
        f"ALTER TYPE {qualify(schema, name)} RENAME VALUE "
        f"{quote_literal(value)} TO {quote_literal(new_value)}"
    )


# The temporary name an enum recreate renames the old type to before creating
# the replacement under its original name — see recreate_enum_type. No
# collision check: if a type by this name already exists, the recreate's
# first statement fails outright and nothing has run (see that function's
# docstring).
_ENUM_RECREATE_SUFFIX = "__old"


@dataclass(frozen=True)
class EnumColumnDependency:
    """
    One table column whose type is an enum being recreated.
    """

    schema: str
    table: str
    column: str
    is_array: bool
    default_expr: str | None


# One complete SQL string literal, single-quoted with `''`-doubled embedded
# quotes (e.g. `'ok'`, or `'a''b'` for the one-token literal "a'b") — matches
# greedily, so an embedded `''` is consumed as part of the same literal
# rather than closing it early. `_rewrite_default_expr` uses this to find
# every literal in a DEFAULT expression without needing to understand the
# surrounding expression's shape (a plain cast, a CASE, a function call —
# the "raw passthrough" trust model this module's Function/type-DDL section
# already applies to defaults).
_SQL_STRING_LITERAL_RE = re.compile(r"'(?:[^']|'')*'")

# One Postgres array-literal element: a `"`-quoted element (with `\`-escaped
# `\`/`"`), or a run of characters excluding the delimiters `,`, `{`, `}` —
# see https://www.postgresql.org/docs/current/arrays.html#ARRAYS-IO. Postgres
# always double-quotes an element needing escaping, so this never has to
# guess which form a given element takes. Left untouched by design: a nested
# `{`/`}` (a multi-dimensional array's inner braces) matches neither
# alternative, so `_PG_ARRAY_ELEMENT_RE.sub()` passes it through unchanged
# while still finding and rewriting every leaf element inside it.
_PG_ARRAY_ELEMENT_RE = re.compile(r'"(?:[^"\\]|\\.)*"|[^,{}]+')

# An optional leading explicit-bounds prefix Postgres may deparse before an
# array literal's `{...}` body, e.g. `[2:3]={ok,sad}` for a non-default lower
# bound, or `[0:1][0:1]={{a,b},{c,d}}` for a multi-dimensional array — see
# https://www.postgresql.org/docs/current/arrays.html#ARRAYS-IO. Captured
# separately so `_rewrite_default_expr` can pass the ``{...}`` body alone to
# the element rewriter and reattach the (label-free, so never itself
# rewritten) bounds prefix verbatim.
_PG_ARRAY_DIMS_RE = re.compile(r"^((?:\[-?\d+:-?\d+\])+=)?(\{.*\})$", re.DOTALL)


def _unescape_pg_array_element(raw: str) -> str | None:
    """
    Undo ``_escape_pg_array_element``'s quoting/escaping.

    Returns:
        ``None`` for an unquoted ``NULL`` — Postgres's array-literal syntax
        has no other way to write a genuine SQL null element, and (per
        ``_escape_pg_array_element``) always `"`-quotes a *label* whose text
        happens to be ``NULL``, so an unquoted occurrence is unambiguously
        the null itself. Otherwise the element's text, unescaped if it was
        `"`-quoted.
    """
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        return re.sub(r"\\(.)", r"\1", raw[1:-1])

    if raw.upper() == "NULL":
        return None

    return raw


def _escape_pg_array_element(value: str | None) -> str:
    """
    Render ``value`` as Postgres's own array-literal output format would:
    the bare token ``NULL`` for the SQL-null sentinel (``None``); otherwise
    the label unquoted where that round-trips unambiguously, `"`-quoted with
    `\\`/`"` backslash-escaped otherwise (empty, case-insensitively
    ``NULL``, leading/trailing whitespace, or containing a delimiter/brace/
    quote/backslash) — see ``_unescape_pg_array_element`` for why a label
    spelled ``NULL`` must always be quoted, never left bare.
    """
    if value is None:
        return "NULL"

    needs_quoting = (
        value == "" or value.upper() == "NULL" or value != value.strip() or any(c in value for c in '{}",\\')
    )

    if not needs_quoting:
        return value

    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _removed_label_sentinel(removed_label: str) -> str:
    """
    A text value used to force a stored row still holding ``removed_label``
    to fail its migration cast (see ``_collision_aware_case_expr``'s doc)
    rather than silently collapse onto a same-text rename target.

    Not collision-checked against the recreated type's real labels. Unlike
    this module's ``__old`` recreate suffix or ``EnumEditPlan``'s
    ``__rename_tmp_N__`` temporary rename labels — where a real label
    matching the synthetic one makes the *statement itself* fail loudly —
    a real label that happens to match this sentinel's exact text would
    make the row *silently* migrate onto that real label instead, since the
    whole point of the sentinel is to be a valid-looking value the CASE
    falls through to. Accepted anyway: an application label spelled
    ``__removed_label_<name>__`` is vanishingly unlikely, and every other
    label-collision risk in this recreate carries the same kind of
    unenforced assumption (e.g. a real label spelled exactly like another
    label's rename target).
    """
    return f"__removed_label_{removed_label}__"


def _rewrite_default_expr(
    default_expr: str, is_array: bool, renames: Sequence[tuple[str, str]],
    colliding_renames: Sequence[tuple[str, str]] = (),
) -> str:
    """
    Rewrite every occurrence of a renamed label inside a dependent column's
    DEFAULT expression, so it names the label's *post*-rename spelling — see
    ``recreate_enum_type``'s doc for why this rewrite is needed at all (the
    introspection that captures ``default_expr`` always runs before any
    rename, live or not, has touched the database). Also rewrites a
    colliding rename's target text — when it appears *unrenamed* — to the
    same sentinel ``_collision_aware_case_expr`` routes a stored row holding
    that value to: without this, a DEFAULT spelled exactly as the label
    being removed (not the rename's own pre-rename spelling — see
    ``colliding_renames``) would pass through unmatched, and since that text
    is now a valid label of the recreated type (the rename's target),
    ``SET DEFAULT`` would silently succeed under the wrong meaning instead
    of failing per ``recreate_enum_type``'s "a stored row still holds a
    removed label" contract — the same silent-relabeling risk
    ``_migration_using_clause`` guards a dependent's stored *data* against.

    Works token-by-token over every complete SQL string literal in
    ``default_expr`` (``_SQL_STRING_LITERAL_RE``), so it doesn't need to
    understand the surrounding expression's shape. Most literals — a scalar
    dependent's label, or one element of an array dependent's default
    written as an ``ARRAY['a'::t, 'b'::t]`` constructor (each element its
    own, separately-matched literal) — are rewritten as a whole-token match
    against the rename map. The one different shape: Postgres may instead
    deparse an array default as a single literal holding its *own* nested
    array-literal syntax, e.g. ``'{ok,sad}'`` — recognized by its ``{``/``}``
    wrapping and, only then, rewritten element-by-element
    (``_PG_ARRAY_ELEMENT_RE``) instead of as one opaque token, since a label
    there is almost never individually SQL-quoted the way a whole-token
    literal's is.

    Being shape-agnostic cuts both ways: it also rewrites a string literal
    that isn't an enum label at all, if its text happens to exactly match a
    renamed value (e.g. a `CASE` default comparing ``CURRENT_USER = 'ok'``
    where this same edit renames label ``ok``). Rare in practice for an enum
    label's typical alphabetic spelling, and — like every other DDL preview
    — recoverable: the generated script is reviewed and editable before
    Execute (see the "raw passthrough" trust model this module's
    Function/type-DDL section already applies to defaults).

    Args:
        default_expr: the dependent's current DEFAULT expression, as
            ``pg_get_expr`` deparsed it.
        is_array: whether the dependent column (and so its default) is an
            array of the enum — gates the ``{...}``-literal branch, so an
            ordinary scalar label that happens to *look* like ``{text}`` is
            never misparsed as an array. Further narrowed to a plain
            ``'...'``-quoted array literal (see ``is_array_literal_shape``
            below): an ``ARRAY[...]`` constructor's elements are always
            independently-quoted SQL literals, never nested array-literal
            syntax, even when a label's own text happens to look
            brace-wrapped (e.g. a label literally spelled ``{x}``).
        renames: this same edit's kept label renames, each a ``(value,
            new_value)`` pair.
        colliding_renames: the subset of ``renames`` whose target collides
            with a same-edit removal — see this function's own doc above and
            ``_migration_using_clause``'s doc.

    Returns:
        ``default_expr`` unchanged if ``renames`` is empty or names nothing
        this default references; otherwise with every matching label
        rewritten to its post-rename spelling (or, for a colliding rename's
        target found unrenamed, to the removed-label sentinel).
    """
    if not renames:
        return default_expr

    rename_map = dict(renames)

    for _, new_value in colliding_renames:
        rename_map.setdefault(new_value, _removed_label_sentinel(new_value))
    # Only a plain quoted array literal (`'{ok,sad}'`, optionally dimension-
    # prefixed) can legitimately hold `{...}` array-literal syntax as one
    # token's content; an `ARRAY[...]` constructor's own elements never do,
    # regardless of their own text (see the Args note above).
    is_array_literal_shape = is_array and not default_expr.lstrip().upper().startswith("ARRAY[")

    def rewrite_literal(match: re.Match[str]) -> str:
        content = match.group(0)[1:-1].replace("''", "'")
        dims_match = _PG_ARRAY_DIMS_RE.match(content) if is_array_literal_shape else None

        if dims_match:
            dims_prefix = dims_match.group(1) or ""
            array_body = dims_match.group(2)

            def rewrite_element(elem_match: re.Match[str]) -> str:
                label = _unescape_pg_array_element(elem_match.group(0))

                if label is not None:
                    label = rename_map.get(label, label)

                return _escape_pg_array_element(label)

            content = dims_prefix + "{" + _PG_ARRAY_ELEMENT_RE.sub(rewrite_element, array_body[1:-1]) + "}"
        else:
            content = rename_map.get(content, content)

        return "'" + content.replace("'", "''") + "'"

    return _SQL_STRING_LITERAL_RE.sub(rewrite_literal, default_expr)


def _collision_aware_case_expr(elem_ref: str, old_enum_ref: str, colliding_renames: Sequence[tuple[str, str]]) -> str:
    """
    Build a ``CASE`` expression that maps ``elem_ref`` (an expression typed
    as the *old* enum) through ``colliding_renames``, so a row holding a
    rename's pre-rename value migrates to its post-rename text while a row
    holding the *removed* label the rename's target text collides with
    fails loudly instead of silently taking on that same text — see
    ``_migration_using_clause``'s doc for why a blind ``::text`` round-trip
    can't tell the two apart.

    Args:
        elem_ref: a SQL expression, typed as ``old_enum_ref``, to migrate —
            either the dependent column reference itself (scalar) or an
            ``unnest()`` alias (array).
        old_enum_ref: the enum's schema-qualified, quoted *old* (renamed-
            aside) name — every comparison below runs against it, since at
            migration time the old type still has both a colliding rename's
            pre-rename label and the distinct, about-to-be-removed label its
            target text collides with (neither was ever renamed away: the
            rename never ran live, and Postgres has no ``DROP VALUE``).
        colliding_renames: this same edit's renames whose target collides
            with a same-edit removal (never run live — see
            ``EnumEditPlan.liveRenames``'s doc).

    Returns:
        A ``CASE ... END`` expression yielding text: a colliding rename's
        post-rename spelling for its pre-rename value, a sentinel
        (``_removed_label_sentinel``) for the removed label's own value, or
        ``elem_ref::text`` unchanged for everything else.
    """
    when_clauses = []

    for value, new_value in colliding_renames:
        when_clauses.append(
            f"WHEN {elem_ref} = {quote_literal(value)}::{old_enum_ref} THEN {quote_literal(new_value)}"
        )
        when_clauses.append(
            f"WHEN {elem_ref} = {quote_literal(new_value)}::{old_enum_ref} "
            f"THEN {quote_literal(_removed_label_sentinel(new_value))}"
        )

    return "CASE " + " ".join(when_clauses) + f" ELSE {elem_ref}::text END"


def _migration_using_clause(
    enum_ref: str,
    old_enum_ref: str,
    column: str,
    is_array: bool,
    colliding_renames: Sequence[tuple[str, str]],
    migrate_function_ref: str,
) -> tuple[list[str], str]:
    """
    Build the statements (if any) and ``USING`` clause expression that carry
    a dependent column's stored data across the recreate.

    Ordinarily a plain ``::text::newtype`` round-trip, no preamble statement.
    When a same-edit rename's target collides with a same-edit removal, that
    plain round-trip is wrong: a stored row holding the rename's *pre*-rename
    value and one holding the *removed* label's own value both read back as
    the exact same text once cast through ``::text`` (Postgres has already
    discarded which of the two distinct old-type oids the row held), so the
    round-trip would silently relabel the removed label's rows as the
    rename's target instead of failing per ``recreate_enum_type``'s "a
    stored row still holds a removed label" contract. In that case, use a
    rename-aware ``CASE`` cast instead (``_collision_aware_case_expr``),
    keyed on the *old* type's oids (still distinct at migration time) rather
    than text.

    A scalar column's ``CASE`` is a plain expression, usable directly in
    ``USING``. An array column's isn't: Postgres refuses a subquery in a
    column-type "transform expression" (confirmed empirically against the
    project's own ``postgres:16-alpine`` container — both the plain
    ``ARRAY(SELECT ...)`` and scalar-subquery forms of an element-wise
    ``unnest()``/``array_agg()`` mapping raise "cannot use subquery in
    transform expression"), so the per-element ``CASE`` is wrapped in a
    ``pg_temp`` SQL function instead — a plain function call *is* usable in
    ``USING``. The function is still explicitly dropped once used (see
    ``_migrate_dependent_column``): a session-temporary function would
    otherwise outlive the statement that calls it, and because it is typed
    over the *old* enum, that would block the script's own final
    ``DROP TYPE``.

    Args:
        enum_ref: the recreated enum's schema-qualified, quoted name (its
            final name, not the temporary ``__old`` one — this runs after
            the ``CREATE TYPE`` step).
        old_enum_ref: the enum's schema-qualified, quoted *old* name.
        column: the dependent column's quoted identifier.
        is_array: whether the column (and so the cast) is an array of the
            enum. A colliding-rename-aware array cast maps each element,
            preserving ``NULL``-ness, emptiness, and element order — but not
            a non-default lower bound (e.g. ``'[2:3]={a,b}'`` comes back
            ``'[1:2]={c,b}'``) or a dimension beyond the first (``unnest()``
            flattens every dimension). Both are accepted residual
            limitations for this narrow combination (a colliding rename
            *and* one of these array shapes on the same dependent column) —
            see the type-panel-inline-editing plan's ``## Implementation
            Notes`` for the full reasoning; the ordinary, far more common
            shapes (``NULL``, ``'{}'``, a plain 1-D 1-based array) are exact.
        colliding_renames: this same edit's renames whose target collides
            with a same-edit removal.
        migrate_function_ref: a ``pg_temp``-schema-qualified, quoted name
            unique to this dependent, used only when ``is_array`` and
            ``colliding_renames`` are both non-empty.

    Returns:
        A ``(preamble_statements, using_expression)`` pair: zero or one
        ``CREATE FUNCTION`` statement, and the ``USING`` clause's expression
        (the part after ``USING``).
    """
    suffix = "[]" if is_array else ""

    if not colliding_renames:
        return [], f"{column}::text{suffix}::{enum_ref}{suffix}"

    if is_array:
        case_expr = _collision_aware_case_expr("elem", old_enum_ref, colliding_renames)
        # array_agg() over unnest() of a NULL or empty array both return no
        # rows, so array_agg() itself returns NULL either way — silently
        # turning a stored empty array into a NULL column value unless
        # distinguished up front. array_length(arr, 1) is NULL for an empty
        # array (it has no elements in dimension 1) but not for a NULL
        # argument (the whole CASE short-circuits on the WHEN arr IS NULL
        # arm first), so it's the right test for "empty, not null".
        function_body = (
            "SELECT CASE "
            "WHEN arr IS NULL THEN NULL "
            "WHEN array_length(arr, 1) IS NULL THEN '{}'::text[] "
            f"ELSE (SELECT array_agg({case_expr} ORDER BY elem_ord) FROM unnest(arr) WITH ORDINALITY AS u(elem, elem_ord)) "
            "END"
        )
        preamble = [
            f"CREATE FUNCTION {migrate_function_ref}(arr {old_enum_ref}[]) RETURNS text[] LANGUAGE sql AS "
            f"{_dollar_quote(function_body)}"
        ]

        return preamble, f"{migrate_function_ref}({column})::{enum_ref}[]"

    case_expr = _collision_aware_case_expr(column, old_enum_ref, colliding_renames)

    return [], f"({case_expr})::{enum_ref}"


def _migrate_dependent_column(
    enum_ref: str,
    old_enum_ref: str,
    dependent: EnumColumnDependency,
    renames: Sequence[tuple[str, str]],
    colliding_renames: Sequence[tuple[str, str]],
    index: int,
) -> list[str]:
    """
    Build the statements that carry one dependent column across an enum
    recreate: drop its default (if any — Postgres refuses to retype a
    column whose default it cannot cast), retype it to the recreated enum
    (see ``_migration_using_clause``, which may prepend a helper function),
    then restore the default.

    Args:
        enum_ref: the recreated enum's schema-qualified, quoted name (its
            final name, not the temporary ``__old`` one — this runs after the
            ``CREATE TYPE`` step).
        old_enum_ref: the enum's schema-qualified, quoted *old* name — see
            ``_migration_using_clause``'s doc.
        dependent: the column, its array-ness, and its current default.
        renames: this same edit's kept label renames, each a
            ``(value, new_value)`` pair — see ``recreate_enum_type``'s doc for
            why the default's literal needs rewriting through this map.
        colliding_renames: this same edit's renames whose target collides
            with a same-edit removal — see ``_migration_using_clause``'s doc.
        index: this dependent's position among every dependent this recreate
            is migrating — makes its helper function's name (if any) unique
            within the script.

    Returns:
        The dependent's migration statements, in execution order.
    """
    table_ref = qualify(dependent.schema, dependent.table)
    column = quote_ident(dependent.column)
    migrate_function_ref = f"pg_temp.{quote_ident(f'__enum_recreate_migrate_{index}__')}"
    preamble, using = _migration_using_clause(
        enum_ref, old_enum_ref, column, dependent.is_array, colliding_renames, migrate_function_ref,
    )
    suffix = "[]" if dependent.is_array else ""
    type_clause = f"{enum_ref}{suffix} USING {using}"

    default_expr = dependent.default_expr

    if default_expr is not None:
        default_expr = _rewrite_default_expr(default_expr, dependent.is_array, renames, colliding_renames)

    statements = list(preamble)

    if default_expr is not None:
        statements.append(f"ALTER TABLE {table_ref} ALTER COLUMN {column} DROP DEFAULT")

    statements.append(f"ALTER TABLE {table_ref} ALTER COLUMN {column} TYPE {type_clause}")

    if preamble:
        # The helper function _migration_using_clause prepended is typed
        # over the *old* enum (its one argument is old_enum_ref[]), so it
        # would otherwise keep DROP TYPE old_enum_ref (recreate_enum_type's
        # final statement) from succeeding — Postgres refuses to drop a type
        # something still depends on. Its job ends the moment the ALTER
        # COLUMN ... TYPE above has run.
        statements.append(f"DROP FUNCTION {migrate_function_ref}({old_enum_ref}[])")

    if default_expr is not None:
        statements.append(f"ALTER TABLE {table_ref} ALTER COLUMN {column} SET DEFAULT {default_expr}")

    return statements


def recreate_enum_type(
    schema: str,
    name: str,
    labels: Sequence[str],
    dependents: Sequence[EnumColumnDependency],
    renames: Sequence[tuple[str, str]] = (),
    colliding_renames: Sequence[tuple[str, str]] = (),
) -> str:
    """
    Build the rename/create/migrate/drop script that replaces an enum type
    with a fresh one under the same name — Postgres has no ``ALTER TYPE ...
    DROP VALUE``, so removing a label goes through this recreate instead (see
    the type-panel-inline-editing plan's "Enum labels: deleting a label
    routes the whole Save through a recreate" Architecture Decision).

    The whole script is meant to run inside one transaction (``";\\n"``-joined
    into the single statement ``ExecuteDdlCommand`` wraps), so a failure
    anywhere — a stored row still holding a removed label, a view or a
    ``CHECK`` constraint depending on a migrated column — rolls the lot back
    and leaves the original type untouched.

    Args:
        schema: the enum type's schema.
        name: the enum type's name (unchanged across the recreate).
        labels: the recreated type's full label list, in order — already
            reflecting every rename (the caller resolves renames into
            ``labels`` before calling this; see ``diffEnumLabels``).
        dependents: every table column whose type is this enum (or its array
            type), each carrying its current default expression (if any) —
            see ``RecreateEnumTypePreview``'s two catalog reads. That default
            expression was introspected before this script (or any live
            ``RENAME VALUE``) has run, so it may still carry a label's
            pre-rename spelling.
        renames: this same edit's kept label renames, each a ``(value,
            new_value)`` pair, used to rewrite a dependent's default literal
            from its pre-rename spelling to its post-rename one (e.g. a
            default of ``'ok'::mood`` becomes ``'fine'::mood`` when this
            edit also renames label ``ok`` to ``fine``) — see
            ``_migrate_dependent_column``.
        colliding_renames: the subset of ``renames`` whose ``new_value``
            collides with a label this same edit removes — a strict subset,
            never a superset, of ``renames`` (see ``EnumEditPlan.
            liveRenames``'s doc for why that pair is never run live). Passed
            separately from ``renames`` because a dependent's *stored data*
            (not just its DEFAULT literal) needs rename-aware handling for
            exactly this subset: see ``_migration_using_clause``'s doc for
            why a plain ``::text`` round-trip can't tell a row holding the
            rename's pre-rename value apart from one holding the removed
            label's own value once their text collides.

    Raises:
        ValidationError: if ``schema``/``name`` is blank, or ``labels`` is
            empty.

    Returns:
        ``ALTER TYPE ... RENAME TO "name__old"``, then ``CREATE TYPE`` under
        the original name, then each dependent's migration statements (see
        ``_migrate_dependent_column``), then ``DROP TYPE "name__old"`` —
        ``";\\n"``-joined into one script, no trailing semicolon.
    """
    require_text(schema, "schema")
    require_text(name, "name")

    if not labels:
        raise ValidationError("'labels' must not be empty")

    old_name = f"{name}{_ENUM_RECREATE_SUFFIX}"
    enum_ref = qualify(schema, name)
    old_enum_ref = qualify(schema, old_name)

    statements = [
        f"ALTER TYPE {enum_ref} RENAME TO {quote_ident(old_name)}",
        create_enum_type(schema, name, labels),
    ]

    for index, dependent in enumerate(dependents):
        statements.extend(
            _migrate_dependent_column(enum_ref, old_enum_ref, dependent, renames, colliding_renames, index)
        )

    statements.append(f"DROP TYPE {old_enum_ref}")

    return ";\n".join(statements)
