"""
Schema/sequence-DDL preview operations: CREATE/DROP/RENAME SCHEMA, and
CREATE/ALTER/OWNER/DROP SEQUENCE. Mirrors ``ddl_view.py``'s layout: one
preview op per module-level class, each a pure ``DdlPreview`` subclass.

Every op is pure — ``build()`` maps the already-validated spec straight to a
``ddl.py`` builder call, with no catalog read (schemas/sequences have no
prefill flow to seed, unlike a view's SELECT body).
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


def _int_opt(spec: Mapping[str, Any], key: str) -> int | None:
    """
    Read an optional integer field off a spec, coercing it to ``int``.

    Sequence numeric options (increment, start, min/max, cache, restart) are
    integer grammar slots, not free-form expressions — see the
    schema-sequence-ddl plan's "Numeric options validated as integers" note.
    A JSON boolean is rejected even though ``bool`` is an ``int`` subclass in
    Python, since a stray `true`/`false` is never a meaningful sequence
    option.

    Args:
        spec: the preview op's spec mapping.
        key: the field to read.

    Raises:
        ValidationError: if the field is present but not a whole number.

    Returns:
        The field's value as an ``int``, or ``None`` if absent.
    """
    value = spec.get(key)

    if value is None:
        return None

    if isinstance(value, bool):
        raise ValidationError(f"'{key}' must be an integer")

    try:
        coerced = int(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"'{key}' must be an integer") from exc

    if isinstance(value, float) and value != coerced:
        raise ValidationError(f"'{key}' must be an integer")

    return coerced


class SchemaCreatePreview(DdlPreview):
    """
    Preview a ``CREATE SCHEMA`` statement.

    Spec: ``{name, authorization?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required name.

        Args:
            conn: unused (this preview is pure) — kept for a uniform op
                signature across every DDL preview.
            spec: the ``CreateSchemaSpec`` wire payload.
        """
        super().__init__()
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """Set ``self._sql`` to the generated ``CREATE SCHEMA`` statement."""
        authorization = self._spec.get("authorization") or None
        self._sql = ddl.schema_create(self._name, authorization=authorization)


class SchemaDropPreview(DdlPreview):
    """
    Preview a ``DROP SCHEMA`` statement.

    Spec: ``{name, cascade?, ifExists?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required name.

        Args:
            conn: unused (this preview is pure).
            spec: the ``DropSchemaSpec`` wire payload.
        """
        super().__init__()
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """Set ``self._sql`` to the generated ``DROP SCHEMA`` statement."""
        self._sql = ddl.schema_drop(
            self._name,
            cascade=bool(self._spec.get("cascade", False)),
            if_exists=bool(self._spec.get("ifExists", False)),
        )


class SchemaRenamePreview(DdlPreview):
    """
    Preview an ``ALTER SCHEMA ... RENAME TO`` statement.

    Spec: ``{name, newName}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required current and new names.

        Args:
            conn: unused (this preview is pure).
            spec: the ``RenameSchemaSpec`` wire payload.
        """
        super().__init__()
        self._name: str = _require(spec, "name")
        self._new_name: str = _require(spec, "newName")

    def build(self) -> None:
        """Set ``self._sql`` to the generated ``ALTER SCHEMA ... RENAME TO`` statement."""
        self._sql = ddl.schema_rename(self._name, self._new_name)


class SequenceCreatePreview(DdlPreview):
    """
    Preview a ``CREATE SEQUENCE`` statement.

    Spec: ``{schema, name, increment?, start?, minValue?, maxValue?, cache?,
    cycle?, ownedBy?: {schema, table, column}}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers and coerce its numeric
        options.

        Args:
            conn: unused (this preview is pure).
            spec: the ``CreateSequenceSpec`` wire payload.

        Raises:
            ValidationError: on a blank schema/name or a non-integer numeric
                option.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._increment = _int_opt(spec, "increment")
        self._start = _int_opt(spec, "start")
        self._min_value = _int_opt(spec, "minValue")
        self._max_value = _int_opt(spec, "maxValue")
        self._cache = _int_opt(spec, "cache")
        self._cycle: bool = bool(spec.get("cycle", False))
        self._owned_by: tuple[str, str, str] | None = _owned_by(spec)

    def build(self) -> None:
        """Set ``self._sql`` to the generated ``CREATE SEQUENCE`` statement."""
        self._sql = ddl.sequence_create(
            self._schema,
            self._name,
            increment=self._increment,
            start=self._start,
            min_value=self._min_value,
            max_value=self._max_value,
            cache=self._cache,
            cycle=self._cycle,
            owned_by=self._owned_by,
        )


def _owned_by(spec: Mapping[str, Any]) -> tuple[str, str, str] | None:
    """
    Read the optional ``ownedBy`` object off a spec.

    Args:
        spec: the preview op's spec mapping.

    Raises:
        ValidationError: if ``ownedBy`` is present but missing one of its
            required ``schema``/``table``/``column`` fields.

    Returns:
        ``(schema, table, column)``, or ``None`` if ``ownedBy`` is absent.
    """
    owned_by = spec.get("ownedBy")

    if not owned_by:
        return None

    return (_require(owned_by, "schema"), _require(owned_by, "table"), _require(owned_by, "column"))


class SequenceAlterPreview(DdlPreview):
    """
    Preview an ``ALTER SEQUENCE`` parameter-form statement.

    Spec: ``{schema, name, dataType?, restart?, restartDefault?, increment?,
    start?, minValue?, maxValue?, cache?, cycle?}``. ``restartDefault: true``
    takes precedence over a numeric ``restart`` (the form only ever sets
    one — see ``plans/implemented/schema-sequence-ddl.md``'s "ALTER
    SEQUENCE" decision).
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers and coerce its numeric
        options.

        Args:
            conn: unused (this preview is pure).
            spec: the ``AlterSequenceSpec`` wire payload.

        Raises:
            ValidationError: on a blank schema/name or a non-integer numeric
                option. The "no option at all" and "unsupported data type"
                cases are raised by ``ddl.sequence_alter`` itself, from
                ``build()``.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._data_type: str | None = spec.get("dataType") or None
        self._restart_default: bool = bool(spec.get("restartDefault", False))
        self._restart = _int_opt(spec, "restart")
        self._increment = _int_opt(spec, "increment")
        self._start = _int_opt(spec, "start")
        self._min_value = _int_opt(spec, "minValue")
        self._max_value = _int_opt(spec, "maxValue")
        self._cache = _int_opt(spec, "cache")
        self._cycle: bool | None = spec.get("cycle") if isinstance(spec.get("cycle"), bool) else None

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``ALTER SEQUENCE`` statement.

        Raises:
            ValidationError: if every option is omitted, or ``dataType`` is
                not a recognized sequence type (both propagated from
                ``ddl.sequence_alter``).
        """
        restart: int | object | None = ddl.RESTART_DEFAULT if self._restart_default else self._restart

        self._sql = ddl.sequence_alter(
            self._schema,
            self._name,
            data_type=self._data_type,
            restart=restart,
            increment=self._increment,
            start=self._start,
            min_value=self._min_value,
            max_value=self._max_value,
            cache=self._cache,
            cycle=self._cycle,
        )


class SequenceOwnerPreview(DdlPreview):
    """
    Preview a sequence ``OWNER TO`` statement.

    Spec: ``{schema, name, owner}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``SequenceOwnerSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._owner: str = _require(spec, "owner")

    def build(self) -> None:
        """Set ``self._sql`` to the generated ``OWNER TO`` statement."""
        self._sql = ddl.sequence_set_owner(self._schema, self._name, self._owner)


class SequenceDropPreview(DdlPreview):
    """
    Preview a ``DROP SEQUENCE`` statement.

    Spec: ``{schema, name, cascade?, ifExists?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``DropSequenceSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """Set ``self._sql`` to the generated ``DROP SEQUENCE`` statement."""
        self._sql = ddl.sequence_drop(
            self._schema,
            self._name,
            cascade=bool(self._spec.get("cascade", False)),
            if_exists=bool(self._spec.get("ifExists", False)),
        )
