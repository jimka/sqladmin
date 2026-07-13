"""
View/matview-DDL preview operations: CREATE/DROP/RENAME VIEW and MATERIALIZED
VIEW, REFRESH MATERIALIZED VIEW, and the DROP+CREATE matview "replace" pair
(see ``plans/implemented/view-matview-ddl.md``'s "Matview edit strategy"
decision). Mirrors ``ddl_table.py``'s layout: one preview op per module-level
function, each a pure ``DdlPreview`` subclass.

Every op is pure — ``build()`` maps the already-validated spec straight to a
``ddl.py`` builder call, with no catalog read. Prefill (seeding the edit
dialogs' SELECT body from a view/matview's existing definition) happens
client-side via the existing ``ViewDefinitionQuery``/``getViewDefinition``
before the dialog opens, so no op here introspects.
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


class CreateViewPreview(DdlPreview):
    """
    Preview a ``CREATE [OR REPLACE] VIEW`` statement.

    Spec: ``{schema, name, select, orReplace?, columns?}``. ``orReplace`` is
    set by the edit flow (``CREATE OR REPLACE`` in place); the create flow
    leaves it unset/false.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers and SELECT body.

        Args:
            conn: unused (this preview is pure) — kept for a uniform op
                signature across every DDL preview.
            spec: the ``CreateViewSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._select: str = _require(spec, "select")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``CREATE [OR REPLACE] VIEW``
        statement.
        """
        self._sql = ddl.create_view(
            self._schema,
            self._name,
            self._select,
            or_replace=bool(self._spec.get("orReplace", False)),
            columns=self._spec.get("columns") or None,
        )


class DropViewPreview(DdlPreview):
    """
    Preview a ``DROP VIEW`` statement.

    Spec: ``{schema, name, cascade?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``DropSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``DROP VIEW`` statement.
        """
        self._sql = ddl.drop_view(self._schema, self._name, cascade=bool(self._spec.get("cascade", False)))


class CreateMaterializedViewPreview(DdlPreview):
    """
    Preview a ``CREATE MATERIALIZED VIEW`` statement.

    Spec: ``{schema, name, select, withData?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers and SELECT body.

        Args:
            conn: unused (this preview is pure).
            spec: the ``CreateMatviewSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._select: str = _require(spec, "select")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``CREATE MATERIALIZED VIEW``
        statement.
        """
        self._sql = ddl.create_materialized_view(
            self._schema, self._name, self._select, with_data=bool(self._spec.get("withData", True))
        )


class DropMaterializedViewPreview(DdlPreview):
    """
    Preview a ``DROP MATERIALIZED VIEW`` statement.

    Spec: ``{schema, name, cascade?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``DropSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``DROP MATERIALIZED VIEW``
        statement.
        """
        self._sql = ddl.drop_materialized_view(
            self._schema, self._name, cascade=bool(self._spec.get("cascade", False))
        )


class RefreshMaterializedViewPreview(DdlPreview):
    """
    Preview a ``REFRESH MATERIALIZED VIEW`` statement.

    Spec: ``{schema, name, concurrently?, withNoData?}``. Neither the builder
    nor this op guards the illegal ``concurrently`` + ``withNoData``
    combination, or the ``CONCURRENTLY``-needs-a-unique-index requirement —
    Postgres is authoritative and the error surfaces at execute (see the
    view-matview-ddl plan's "Potential Challenges").
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers.

        Args:
            conn: unused (this preview is pure).
            spec: the ``RefreshMatviewSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``REFRESH MATERIALIZED VIEW``
        statement.
        """
        self._sql = ddl.refresh_materialized_view(
            self._schema,
            self._name,
            concurrently=bool(self._spec.get("concurrently", False)),
            with_no_data=bool(self._spec.get("withNoData", False)),
        )


class ReplaceMaterializedViewPreview(DdlPreview):
    """
    Preview the ``DROP; CREATE`` pair that edits a materialized view's body
    (see ``ddl.replace_materialized_view``).

    Spec: ``{schema, name, select, cascade?, withData?}``.
    """

    def __init__(self, conn: asyncpg.Connection, spec: Mapping[str, Any]) -> None:
        """
        Validate the spec's required identifiers and new SELECT body.

        Args:
            conn: unused (this preview is pure).
            spec: the ``ReplaceMatviewSpec`` wire payload.
        """
        super().__init__()
        self._schema: str = _require(spec, "schema")
        self._name: str = _require(spec, "name")
        self._select: str = _require(spec, "select")
        self._spec: Mapping[str, Any] = spec

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated ``;``-joined ``DROP; CREATE``
        statement.
        """
        self._sql = ddl.replace_materialized_view(
            self._schema,
            self._name,
            self._select,
            cascade=bool(self._spec.get("cascade", False)),
            with_data=bool(self._spec.get("withData", True)),
        )
