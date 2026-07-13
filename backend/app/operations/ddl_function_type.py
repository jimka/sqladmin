"""
Function/procedure & custom-type DDL preview operations: CREATE [OR REPLACE]
FUNCTION|PROCEDURE, DROP FUNCTION|PROCEDURE, CREATE TYPE (enum/composite),
DROP TYPE, ALTER TYPE ADD VALUE. Mirrors ddl_schema_sequence.py's layout: one
pure DdlPreview subclass per statement, each mapping an already-validated
spec straight to a ddl.py builder call.

Every op is pure — build() reads the parsed spec and calls a ddl.py builder,
with no catalog read. Raw type strings, defaults, function bodies, and enum
labels pass through as the user typed them (ddl-infrastructure's trust
model); only the required identifier fields (schema/name) are validated here.
"""

from __future__ import annotations

from typing import Any, Mapping

import asyncpg

from ..errors import ValidationError
from ..sql import ddl
from .ddl import DdlPreview


def _require(spec: Mapping[str, Any], key: str) -> str:
    """
    Read a required, non-blank string field off a spec.

    Args:
        spec: the preview op's spec mapping.
        key: the field to read.

    Raises:
        ValidationError: if the field is missing, not a string, or blank.

    Returns:
        The field's value.
    """
    value = spec.get(key)

    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"'{key}' is required")

    return value


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
            type=_require(raw, "type"),
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
    label = _require(raw, "label")

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
            schema=_require(spec, "schema"),
            name=_require(spec, "name"),
            kind=str(spec.get("kind", "function")),
            args=_parse_args(spec.get("args")),
            language=str(spec.get("language", "sql")),
            body=str(spec.get("body", "")),
            returns=spec.get("returns") or None,
            volatility=spec.get("volatility") or None,
            replace=bool(spec.get("replace", False)),
        )

    def build(self) -> None:
        """Set ``self._sql`` to the generated CREATE FUNCTION/PROCEDURE statement."""
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
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._kind: str = str(spec.get("kind", "function"))
        self._signature: str = str(spec.get("signature", ""))
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """Set ``self._sql`` to the generated DROP FUNCTION/PROCEDURE statement."""
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
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._labels: list[str] = list(spec.get("labels", []))

    def build(self) -> None:
        """Set ``self._sql`` to the generated CREATE TYPE ... AS ENUM statement."""
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
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._attrs: list[ddl.CompositeAttr] = [
            ddl.CompositeAttr(name=_require(a, "name"), type=_require(a, "type"))
            for a in spec.get("attributes", [])
        ]

    def build(self) -> None:
        """Set ``self._sql`` to the generated CREATE TYPE ... AS (...) statement."""
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
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """Set ``self._sql`` to the generated DROP TYPE statement."""
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
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._value: str = _require(spec, "value")
        self._position: tuple[str, str] | None = _parse_position(spec.get("position"))

    def build(self) -> None:
        """Set ``self._sql`` to the generated ALTER TYPE ... ADD VALUE statement."""
        self._sql = ddl.alter_type_add_value(self._schema, self._name, self._value, self._position)
