"""
TypeDefinitionQuery — introspect one enum or composite type for the edit-
prefill flow (an enum's existing labels, or a composite's attributes) and the
read-only info tab (which also wants the owning role).

There is no ``pg_get_typedef`` for a standalone type, so this reads
``pg_type``/``pg_enum``/``pg_attribute`` directly: first the type row (to
learn its category via ``typtype`` and its owner), then the matching child
rows (enum labels or composite attributes).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from ..errors import NotFound
from .base import Query

# pg_type.typtype values for the two kinds this query understands: 'e' (enum)
# and 'c' (composite, aka a stand-alone row type created via CREATE TYPE ... AS).
_ENUM_TYPTYPE = "e"


class TypeDefinitionQuery(Query):
    """
    Introspect one enum or composite type's labels/attributes.
    """

    # typtype is cast to text: it is Postgres's internal 1-byte "char"
    # pseudo-type, which asyncpg decodes as raw bytes (b"e"/b"c"), not str —
    # comparing that against a Python str literal silently never matches.
    # Casting in SQL sidesteps the codec quirk entirely.
    _TYPE_SQL = (
        "SELECT t.oid, t.typtype::text AS typtype, t.typrelid, "
        "pg_catalog.pg_get_userbyid(t.typowner) AS owner "
        "FROM pg_catalog.pg_type t "
        "JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace "
        "WHERE n.nspname = $1 AND t.typname = $2"
    )
    _ENUM_LABELS_SQL = (
        "SELECT enumlabel FROM pg_catalog.pg_enum WHERE enumtypid = $1 ORDER BY enumsortorder"
    )
    _COMPOSITE_ATTRS_SQL = (
        "SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type "
        "FROM pg_catalog.pg_attribute a "
        "WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped "
        "ORDER BY a.attnum"
    )

    def __init__(self, conn: asyncpg.Connection, schema: str, name: str) -> None:
        """
        Capture the connection and the type to introspect.

        Args:
            conn: the connection to introspect on.
            schema: the type's schema.
            name: the type's name.
        """
        self._conn: asyncpg.Connection = conn
        self._schema: str = schema
        self._name: str = name
        self._category: str | None = None
        self._owner: str | None = None
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch the type row, then its enum labels or composite attributes.

        A type row that does not exist leaves ``self._owner`` (and
        ``self._raw``) as their ``None``/empty defaults — ``get_result()``
        raises ``NotFound`` when ``self._owner`` is still ``None``, since an
        empty child-row list alone does not distinguish a missing type from a
        real, empty enum or composite.
        """
        type_row = await self._conn.fetchrow(self._TYPE_SQL, self._schema, self._name)

        if type_row is None:
            self._category = None
            self._raw = []

            return

        self._owner = type_row["owner"]

        if type_row["typtype"] == _ENUM_TYPTYPE:
            self._category = "enum"
            self._raw = await self._conn.fetch(self._ENUM_LABELS_SQL, type_row["oid"])
        else:
            self._category = "composite"
            self._raw = await self._conn.fetch(self._COMPOSITE_ATTRS_SQL, type_row["typrelid"])

    def get_result(self) -> dict:
        """
        Return the type's category, its owner, and its labels (enum) or
        attributes (composite).

        Raises:
            RuntimeError: if called before ``apply()``.
            NotFound: if no such type exists.

        Returns:
            ``{"category": "enum"|"composite", "labels": [str, ...],
            "attributes": [{"name": str, "type": str}, ...], "owner": str}``
            — only the field matching ``category`` is populated; the other is
            empty.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        if self._owner is None:
            raise NotFound(f"Type '{self._schema}.{self._name}' not found")

        if self._category == "enum":
            return {
                "category": "enum",
                "labels": [r["enumlabel"] for r in self._raw],
                "attributes": [],
                "owner": self._owner,
            }

        return {
            "category": "composite",
            "labels": [],
            "attributes": [{"name": r["name"], "type": r["type"]} for r in self._raw],
            "owner": self._owner,
        }
