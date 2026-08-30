"""
Function/procedure & custom-type DDL preview operations: CREATE [OR REPLACE]
FUNCTION|PROCEDURE, DROP FUNCTION|PROCEDURE, CREATE TYPE (enum/composite),
DROP TYPE, ALTER TYPE ADD VALUE, the four composite ALTER ATTRIBUTE actions,
ALTER TYPE RENAME VALUE, and the enum recreate-and-migrate script. Mirrors
ddl_schema_sequence.py's layout: one pure DdlPreview subclass per statement
(``AlterCompositeTypePreview`` action-dispatches like ``PreviewAlterTable``),
each mapping an already-validated spec straight to a ddl.py builder call —
except ``RecreateEnumTypePreview``, whose ``apply()`` reads the enum's
dependent columns first (see its own docstring).

Every op but ``RecreateEnumTypePreview`` is pure — build() reads the parsed
spec and calls a ddl.py builder, with no catalog read. Raw type strings,
defaults, function bodies, and enum labels pass through as the user typed
them (ddl-infrastructure's trust model); only the required identifier fields
(schema/name) are validated here.
"""

from __future__ import annotations

from typing import Any, Mapping

import asyncpg

from ..errors import NotFound, ValidationError
from ..sql import ddl
from .ddl import DdlPreview, require_field


def _parse_args(raw_args: Any) -> list[ddl.FunctionArg]:
    """
    Parse a CreateFunctionSpec's ``args`` list into ``FunctionArg``s.

    Args:
        raw_args: the spec's ``args`` field — a list of ``{type, name?,
            mode?, default?}`` mappings, or ``None``/absent for no arguments.

    Raises:
        ValidationError: if an argument's ``type`` is missing/blank.

    Returns:
        The parsed ``FunctionArg`` list, in order.
    """
    parsed: list[ddl.FunctionArg] = []

    for raw in raw_args or []:
        parsed.append(ddl.FunctionArg(
            type=require_field(raw, "type"),
            name=raw.get("name") or None,
            mode=raw.get("mode") or None,
            default=raw.get("default") or None,
        ))

    return parsed


def _parse_position(raw: Any) -> tuple[str, str] | None:
    """
    Read an AlterTypeAddValueSpec's optional ``position`` object.

    Args:
        raw: the spec's ``position`` field — ``{placement, label}``, or
            ``None``/absent to append the value with no explicit placement.

    Raises:
        ValidationError: if ``position`` is present but its ``placement``
            is not ``"before"``/``"after"``, or its ``label`` is blank.

    Returns:
        ``(placement, label)``, or ``None``.
    """
    if not raw:
        return None

    placement = raw.get("placement")
    label = require_field(raw, "label")

    if placement not in ("before", "after"):
        raise ValidationError("'position.placement' must be 'before' or 'after'")

    return (placement, label)


class CreateFunctionPreview(DdlPreview):
    """
    Preview a CREATE [OR REPLACE] FUNCTION|PROCEDURE statement.

    Spec: ``{schema, name, kind, args, language, body, returns?,
    volatility?, replace?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers and parse its argument list.

        Args:
            conn: unused (this preview is pure) — kept for a uniform op
                signature across every DDL preview.
            spec: the ``CreateFunctionSpec`` wire payload.
        """
        super().__init__()
        self._spec_obj = ddl.CreateRoutineSpec(
            schema=require_field(spec, "schema"),
            name=require_field(spec, "name"),
            kind=str(spec.get("kind", "function")),
            args=_parse_args(spec.get("args")),
            language=str(spec.get("language", "sql")),
            body=str(spec.get("body", "")),
            returns=spec.get("returns") or None,
            volatility=spec.get("volatility") or None,
            replace=bool(spec.get("replace", False)),
        )

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated CREATE FUNCTION/PROCEDURE statement.
        """
        self._sql = ddl.create_routine(self._spec_obj)


class DropFunctionPreview(DdlPreview):
    """
    Preview a DROP FUNCTION|PROCEDURE statement, disambiguating overloads by
    the routine's full identity-argument signature.

    Spec: ``{schema, name, kind, signature, cascade?, ifExists?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``DropFunctionSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = require_field(spec, "schema")
        self._name: str = require_field(spec, "name")
        self._kind: str = str(spec.get("kind", "function"))
        self._signature: str = str(spec.get("signature", ""))
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated DROP FUNCTION/PROCEDURE statement.
        """
        self._sql = ddl.drop_routine(
            self._schema,
            self._name,
            self._kind,
            self._signature,
            cascade=bool(self._spec.get("cascade", False)),
            if_exists=bool(self._spec.get("ifExists", False)),
        )


class CreateEnumTypePreview(DdlPreview):
    """
    Preview a CREATE TYPE ... AS ENUM statement.

    Spec: ``{schema, name, labels}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``CreateEnumTypeSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = require_field(spec, "schema")
        self._name: str = require_field(spec, "name")
        self._labels: list[str] = list(spec.get("labels", []))

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated CREATE TYPE ... AS ENUM statement.
        """
        self._sql = ddl.create_enum_type(self._schema, self._name, self._labels)


class CreateCompositeTypePreview(DdlPreview):
    """
    Preview a CREATE TYPE ... AS (...) composite-type statement.

    Spec: ``{schema, name, attributes}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers and attribute list.

        Args:
            conn: unused (this preview is pure).
            spec: the ``CreateCompositeTypeSpec`` wire payload.

        Raises:
            ValidationError: on a blank schema/name/attribute name/type.
        """
        super().__init__()
        self._schema: str = require_field(spec, "schema")
        self._name: str = require_field(spec, "name")
        self._attrs: list[ddl.CompositeAttr] = [
            ddl.CompositeAttr(name=require_field(a, "name"), type=require_field(a, "type"))
            for a in spec.get("attributes", [])
        ]

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated CREATE TYPE ... AS (...) statement.
        """
        self._sql = ddl.create_composite_type(self._schema, self._name, self._attrs)


class DropTypePreview(DdlPreview):
    """
    Preview a DROP TYPE statement.

    Spec: ``{schema, name, cascade?, ifExists?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``DropTypeSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = require_field(spec, "schema")
        self._name: str = require_field(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated DROP TYPE statement.
        """
        self._sql = ddl.drop_type(
            self._schema,
            self._name,
            cascade=bool(self._spec.get("cascade", False)),
            if_exists=bool(self._spec.get("ifExists", False)),
        )


class AlterTypeAddValuePreview(DdlPreview):
    """
    Preview an ALTER TYPE ... ADD VALUE statement.

    Spec: ``{schema, name, value, position?: {placement, label}}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers, value, and optional
        position.

        Args:
            conn: unused (this preview is pure).
            spec: the ``AlterTypeAddValueSpec`` wire payload.

        Raises:
            ValidationError: on a blank schema/name/value, or an invalid
                ``position``.
        """
        super().__init__()
        self._schema: str = require_field(spec, "schema")
        self._name: str = require_field(spec, "name")
        self._value: str = require_field(spec, "value")
        self._position: tuple[str, str] | None = _parse_position(spec.get("position"))

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ALTER TYPE ... ADD VALUE statement.
        """
        self._sql = ddl.alter_type_add_value(self._schema, self._name, self._value, self._position)


def _composite_attr(spec: Mapping[str, Any]) -> ddl.CompositeAttr:
    """
    Read an ``AlterCompositeTypeSpec.attributeDef`` field into a
    ``CompositeAttr`` — the ``addAttribute`` action's only spec field.

    Args:
        spec: the outer spec mapping; ``attributeDef`` is ``{name, type}``.

    Raises:
        ValidationError: if ``attributeDef`` is missing, or its ``name``/
            ``type`` is missing or blank.

    Returns:
        The parsed ``CompositeAttr``.
    """
    attr_def = spec.get("attributeDef")

    if not isinstance(attr_def, Mapping):
        raise ValidationError("'attributeDef' is required")

    return ddl.CompositeAttr(name=require_field(attr_def, "name"), type=require_field(attr_def, "type"))


class AlterCompositeTypePreview(DdlPreview):
    """
    Preview one composite-type ``ALTER ATTRIBUTE`` operation, dispatched on
    ``spec["action"]`` — the same family of per-member column-like edits as
    ``PreviewAlterTable``.

    Spec: ``{schema, name, action, ...}``. ``action`` is one of
    ``addAttribute``, ``dropAttribute``, ``changeAttributeType``,
    ``renameAttribute``; the remaining fields depend on ``action``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers (schema/name only — the
        per-action fields are validated by ``build()``'s dispatch, since
        which fields are required depends on ``action``).

        Args:
            conn: unused (this preview is pure).
            spec: the ``AlterCompositeTypeSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = require_field(spec, "schema")
        self._name: str = require_field(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Dispatch on ``self._spec["action"]`` to the matching ``ddl.py``
        builder and set ``self._sql``.

        Raises:
            ValidationError: if ``action`` is not a recognized composite
                ALTER action, or a field the chosen action requires is
                missing.
        """
        s, n, spec = self._schema, self._name, self._spec
        action = spec.get("action")

        if action == "addAttribute":
            self._sql = ddl.alter_type_add_attribute(s, n, _composite_attr(spec))
        elif action == "dropAttribute":
            self._sql = ddl.alter_type_drop_attribute(s, n, require_field(spec, "attribute"))
        elif action == "changeAttributeType":
            self._sql = ddl.alter_type_alter_attribute_type(
                s, n, require_field(spec, "attribute"), require_field(spec, "newType"),
            )
        elif action == "renameAttribute":
            self._sql = ddl.alter_type_rename_attribute(
                s, n, require_field(spec, "attribute"), require_field(spec, "newName"),
            )
        else:
            raise ValidationError(f"Unknown composite ALTER action '{action}'")


class AlterTypeRenameValuePreview(DdlPreview):
    """
    Preview an ``ALTER TYPE ... RENAME VALUE`` statement, renaming one
    existing enum label in place.

    Spec: ``{schema, name, value, newValue}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required fields.

        Args:
            conn: unused (this preview is pure).
            spec: the ``AlterTypeRenameValueSpec`` wire payload.

        Raises:
            ValidationError: on a blank ``schema``/``name``/``value``/``newValue``.
        """
        super().__init__()
        self._schema: str = require_field(spec, "schema")
        self._name: str = require_field(spec, "name")
        self._value: str = require_field(spec, "value")
        self._new_value: str = require_field(spec, "newValue")

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``ALTER TYPE ... RENAME VALUE``
        statement.
        """
        self._sql = ddl.alter_type_rename_value(self._schema, self._name, self._value, self._new_value)


def _enum_rename(raw: Any) -> tuple[str, str]:
    """
    Parse one ``RecreateEnumTypeSpec.renames`` entry into a ``(value,
    new_value)`` pair.

    Args:
        raw: one element of the spec's ``renames`` list.

    Raises:
        ValidationError: if ``raw`` isn't a mapping, or its ``value``/
            ``newValue`` is missing or blank.

    Returns:
        The parsed pair.
    """
    if not isinstance(raw, Mapping):
        raise ValidationError("Each 'renames' entry must be an object")

    return require_field(raw, "value"), require_field(raw, "newValue")


class RecreateEnumTypePreview(DdlPreview):
    """
    Preview the rename/create/migrate/drop script that replaces an enum type
    with a fresh one under the same name (see ``ddl.recreate_enum_type``) —
    the Save path an enum tab's label deletion routes through, since
    Postgres has no ``ALTER TYPE ... DROP VALUE``.

    Spec: ``{schema, name, labels, renames, collidingRenames}``. Unlike every
    other preview op in this module, ``apply()`` introspects first: the
    frontend sends the type's identity, its new label list, and this same
    edit's kept renames, never the tables that depend on it, so this op
    reads the enum's own oid/array-oid and every dependent table column (and
    its current default, if any) before building the script — the override
    ``DdlPreview.apply()``'s own docstring sanctions ("a subclass whose
    preview must introspect first ... overrides this to fetch, then calls
    ``self.build()``"). ``renames`` exists because that introspection reads
    a dependent's default *before* anything in the generated script —
    including any live ``RENAME VALUE``, which only runs when the caller
    later executes the previewed SQL — has touched the database, so a
    default holding a label this edit renames would otherwise be built with
    its stale pre-rename spelling (see ``ddl.recreate_enum_type``'s doc).
    ``collidingRenames`` (a subset of ``renames``) exists for the same
    underlying reason applied to a dependent's stored *data*: see
    ``ddl.recreate_enum_type``'s and ``ddl._migration_using_clause``'s docs.
    """

    _TYPE_OID_SQL = (
        "SELECT t.oid, t.typarray FROM pg_catalog.pg_type t "
        "JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace "
        "WHERE n.nspname = $1 AND t.typname = $2 AND t.typtype = 'e'"
    )
    # attinhcount = 0 excludes a partition's or inheritance child's own copy
    # of an inherited column: Postgres recurses ALTER TABLE ... ALTER COLUMN
    # ... TYPE from a partitioned/inherited parent to every child on its own,
    # and in fact refuses that same ALTER run directly against a child
    # ("cannot alter inherited column") — so migrating only the top-level
    # (attinhcount = 0) column is both correct and the only form Postgres
    # accepts. Confirmed empirically against the project's own
    # postgres:16-alpine container: querying without this filter returns the
    # partitioned parent AND each partition as separate dependents, and the
    # partition's own ALTER COLUMN ... TYPE statement then fails outright.
    _DEPENDENTS_SQL = (
        "SELECT n.nspname AS schema, c.relname AS table, a.attname AS column, "
        "(a.atttypid = $2) AS is_array, "
        "pg_get_expr(d.adbin, d.adrelid) AS default_expr "
        "FROM pg_catalog.pg_attribute a "
        "JOIN pg_catalog.pg_class c ON c.oid = a.attrelid "
        "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
        "LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum "
        "WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attinhcount = 0 "
        "AND c.relkind IN ('r', 'p') AND a.atttypid IN ($1, $2) "
        "ORDER BY n.nspname, c.relname, a.attnum"
    )

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers and capture its label list.

        Args:
            conn: the connection ``apply()`` introspects on.
            spec: the ``RecreateEnumTypeSpec`` wire payload.

        Raises:
            ValidationError: if ``schema``/``name`` is blank.
        """
        super().__init__()
        self._conn: asyncpg.Connection = conn
        self._schema: str = require_field(spec, "schema")
        self._name: str = require_field(spec, "name")
        self._labels: list[str] = list(spec.get("labels", []))
        # This same edit's kept renames, {value, newValue} pairs — passed
        # through to ddl.recreate_enum_type so a dependent's DEFAULT literal
        # is rewritten from its pre-rename spelling before this op's own
        # introspection (below) ever sees the live database, since that
        # introspection unavoidably runs before any RENAME VALUE has
        # executed (see EnumEditPlan's doc for the full reasoning).
        self._renames: list[tuple[str, str]] = [_enum_rename(r) for r in spec.get("renames", [])]
        # The subset of `renames` whose target collides with a same-edit
        # removal (never run live) — passed through to
        # ddl.recreate_enum_type so a dependent's stored *data*, not just
        # its DEFAULT literal, migrates through a rename-aware cast instead
        # of a plain ::text round-trip that can't tell a row holding the
        # rename's pre-rename value apart from one holding the removed
        # label's own value (see RecreateEnumTypeSpec's doc).
        self._colliding_renames: list[tuple[str, str]] = [_enum_rename(r) for r in spec.get("collidingRenames", [])]
        # Populated by apply(); build() alone (the NO_CONN unit-test path)
        # sees [] — the no-dependents case ddl.recreate_enum_type also covers.
        self._dependents: list[ddl.EnumColumnDependency] = []

    async def apply(self) -> None:
        """
        Read the enum's oid/array-oid, then every dependent table column and
        its default, then call ``build()``.

        Raises:
            NotFound: if no enum type named ``schema.name`` exists.
        """
        type_row = await self._conn.fetchrow(self._TYPE_OID_SQL, self._schema, self._name)

        if type_row is None:
            raise NotFound(f"Enum type '{self._schema}.{self._name}' not found")

        rows = await self._conn.fetch(self._DEPENDENTS_SQL, type_row["oid"], type_row["typarray"])
        self._dependents = [
            ddl.EnumColumnDependency(
                schema=r["schema"], table=r["table"], column=r["column"],
                is_array=r["is_array"], default_expr=r["default_expr"],
            )
            for r in rows
        ]

        self.build()

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated rename/create/migrate/drop
        script, from ``self._labels``, ``self._dependents`` (``[]`` unless
        ``apply()`` has populated it — pure over those plus ``self._renames``
        and ``self._colliding_renames``, so this is directly unit-testable
        with ``NO_CONN`` and no dependents).
        """
        self._sql = ddl.recreate_enum_type(
            self._schema, self._name, self._labels, self._dependents, self._renames, self._colliding_renames,
        )
