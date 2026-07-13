"""
Table-DDL preview operations: CREATE/DROP TABLE, ALTER-column, constraint
add/drop, and index create/drop, grouped by dialog/category and dispatched on
an ``action`` discriminator where a category has several sub-operations (see
``plans/implemented/table-ddl.md``'s "Preview ops grouped by dialog" decision).

Every op is pure — ``build()`` maps the already-validated spec straight to a
``ddl.py`` builder call, with no catalog read. Prefill (seeding a form with a
table's current columns/structure) happens client-side before the dialog
opens, so no op here introspects.
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


def _field(spec: Mapping[str, Any], key: str) -> Any:
    """
    Read a required non-string field off a spec (a column list, a column-def
    mapping) — the collection analogue of ``_require``, which only accepts
    non-blank strings.

    Args:
        spec: the preview op's spec mapping.
        key: the field to read.

    Raises:
        ValidationError: if the field is absent.

    Returns:
        The field's value.
    """
    if key not in spec:
        raise ValidationError(f"'{key}' is required")

    return spec[key]


def _column_def(spec: Mapping[str, Any]) -> dict[str, Any]:
    """
    Map a wire ``ColumnSpec`` (``primaryKey``) to a ``ddl.py`` column mapping
    (``primary_key``) — the only naming seam between the camelCase wire
    contract and the builders' snake_case keys.

    Args:
        spec: the wire ``ColumnSpec`` — ``{name, type, nullable, default,
            primaryKey}``.

    Returns:
        ``{name, type, nullable, default, primary_key}``.
    """
    return {
        "name": spec["name"],
        "type": spec["type"],
        "nullable": spec.get("nullable", True),
        "default": spec.get("default"),
        "primary_key": spec.get("primaryKey", False),
    }


class PreviewCreateTable(DdlPreview):
    """
    Preview a ``CREATE TABLE`` statement.

    Spec: ``{schema, name, columns: [ColumnSpec], ifNotExists?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure) — kept for a uniform op
                signature across every DDL preview.
            spec: the ``CreateTableSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``CREATE TABLE`` statement.
        """
        columns = [_column_def(c) for c in self._spec.get("columns", [])]

        self._sql = ddl.create_table(
            self._schema, self._name, columns, if_not_exists=bool(self._spec.get("ifNotExists", False))
        )


class PreviewDropTable(DdlPreview):
    """
    Preview a ``DROP TABLE`` statement.

    Spec: ``{schema, name, cascade?, ifExists?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``DropTableSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``DROP TABLE`` statement.
        """
        self._sql = ddl.drop_table(
            self._schema,
            self._name,
            cascade=bool(self._spec.get("cascade", False)),
            if_exists=bool(self._spec.get("ifExists", False)),
        )


class PreviewAlterTable(DdlPreview):
    """
    Preview one ``ALTER TABLE`` column/table-rename operation, dispatched on
    ``spec["action"]``.

    Spec: ``{schema, name, action, ...}``. ``action`` is one of
    ``addColumn``, ``dropColumn``, ``renameColumn``, ``changeType``,
    ``setNotNull``, ``dropNotNull``, ``setDefault``, ``dropDefault``,
    ``renameTable``; the remaining fields depend on ``action``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers (schema/name only — the
        per-action fields are validated by ``build()``'s dispatch, since
        which fields are required depends on ``action``).

        Args:
            conn: unused (this preview is pure).
            spec: the ``AlterTableSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Dispatch on ``self._spec["action"]`` to the matching ``ddl.py``
        builder and set ``self._sql``.

        Raises:
            ValidationError: if ``action`` is not a recognized ALTER action,
                or a field the chosen action requires is missing.
        """
        s, t, spec = self._schema, self._name, self._spec
        action = spec.get("action")

        if action == "addColumn":
            self._sql = ddl.add_column(s, t, _column_def(_field(spec, "columnDef")))
        elif action == "dropColumn":
            self._sql = ddl.drop_column(s, t, _require(spec, "column"), cascade=bool(spec.get("cascade", False)))
        elif action == "renameColumn":
            self._sql = ddl.rename_column(s, t, _require(spec, "column"), _require(spec, "newName"))
        elif action == "changeType":
            self._sql = ddl.alter_column_type(s, t, _require(spec, "column"), _require(spec, "newType"), using=spec.get("using") or None)
        elif action == "setNotNull":
            self._sql = ddl.set_not_null(s, t, _require(spec, "column"))
        elif action == "dropNotNull":
            self._sql = ddl.drop_not_null(s, t, _require(spec, "column"))
        elif action == "setDefault":
            self._sql = ddl.set_default(s, t, _require(spec, "column"), _require(spec, "default"))
        elif action == "dropDefault":
            self._sql = ddl.drop_default(s, t, _require(spec, "column"))
        elif action == "renameTable":
            self._sql = ddl.rename_table(s, t, _require(spec, "newName"))
        else:
            raise ValidationError(f"Unknown ALTER action '{action}'")


class PreviewConstraint(DdlPreview):
    """
    Preview one constraint add/drop operation, dispatched on
    ``spec["action"]``.

    Spec: ``{schema, name, action, ...}``. ``action`` is one of
    ``addPrimaryKey``, ``addUnique``, ``addCheck``, ``addForeignKey``,
    ``drop``; the remaining fields depend on ``action``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``ConstraintSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Dispatch on ``self._spec["action"]`` to the matching ``ddl.py``
        builder and set ``self._sql``.

        Raises:
            ValidationError: if ``action`` is not a recognized constraint
                action, or a field the chosen action requires is missing.
        """
        s, t, spec = self._schema, self._name, self._spec
        action = spec.get("action")
        constraint_name = spec.get("constraintName") or None

        if action == "addPrimaryKey":
            self._sql = ddl.add_primary_key(s, t, _field(spec, "columns"), constraint_name=constraint_name)
        elif action == "addUnique":
            self._sql = ddl.add_unique(s, t, _field(spec, "columns"), constraint_name=constraint_name)
        elif action == "addCheck":
            self._sql = ddl.add_check(s, t, _require(spec, "expression"), constraint_name=constraint_name)
        elif action == "addForeignKey":
            self._sql = ddl.add_foreign_key(
                s, t, _field(spec, "columns"), _require(spec, "refSchema"), _require(spec, "refTable"),
                _field(spec, "refColumns"),
                constraint_name=constraint_name,
                on_update=spec.get("onUpdate") or None,
                on_delete=spec.get("onDelete") or None,
            )
        elif action == "drop":
            self._sql = ddl.drop_constraint(
                s, t, _require(spec, "constraintName"), cascade=bool(spec.get("cascade", False))
            )
        else:
            raise ValidationError(f"Unknown constraint action '{action}'")


class PreviewIndex(DdlPreview):
    """
    Preview one index create/drop operation, dispatched on
    ``spec["action"]``.

    Spec: ``{schema, action, ...}``. ``action`` is ``create`` (also carrying
    ``table``) or ``drop``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required schema identifier.

        Args:
            conn: unused (this preview is pure).
            spec: the ``IndexSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Dispatch on ``self._spec["action"]`` to the matching ``ddl.py``
        builder and set ``self._sql``.

        Raises:
            ValidationError: if ``action`` is not ``create``/``drop``, or a
                field the chosen action requires is missing.
        """
        s, spec = self._schema, self._spec
        action = spec.get("action")

        if action == "create":
            self._sql = ddl.create_index(
                s, _require(spec, "table"), _field(spec, "columns"),
                name=spec.get("name") or None,
                unique=bool(spec.get("unique", False)),
                method=spec.get("method") or None,
            )
        elif action == "drop":
            self._sql = ddl.drop_index(
                s, _require(spec, "indexName"),
                cascade=bool(spec.get("cascade", False)),
                if_exists=bool(spec.get("ifExists", False)),
            )
        else:
            raise ValidationError(f"Unknown index action '{action}'")
