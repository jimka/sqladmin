"""
ListColumnsQuery — columns + PK + generated flags + backing sequence for one
table.

``get_result()`` returns the contract JSON for the ``/columns`` route;
``get_columns_result()`` returns the typed ``ColumnMeta`` list the row
operations consume.
"""

from __future__ import annotations

import asyncpg

from ..contract import ColumnMeta, TableRef
from .base import CatalogQuery
from .catalog import COLUMN_FROM, COLUMN_SELECT, column_meta


class ListColumnsQuery(CatalogQuery):
    """
    Introspect one table's columns, marking primary-key and generated ones.
    """

    _SQL = f"SELECT {COLUMN_SELECT} {COLUMN_FROM} ORDER BY c.ordinal_position"

    # information_schema.columns (SQL-standard) omits materialized views, so a
    # matview's columns come from pg_catalog instead. pg_attribute + format_type
    # yield the same name/data_type/nullable shape; a matview has no primary key,
    # generated column, or default, so those flags are constant-false — and, for
    # the same reason (no default to call nextval() from, and nothing OWNED BY a
    # matview column), no backing sequence, so those two are constant-NULL. The
    # casts are what let asyncpg type the NULL columns. data_type arrives as a
    # format_type() string (e.g. "numeric", "integer") which pg_type_to_wire maps
    # exactly as it does the information_schema names. full_type reuses the same
    # format_type() call under a second alias (data_type already carries the
    # modifier here, unlike information_schema's SQL-standard name), and
    # default_expr is constant-NULL for the same "no default" reason as has_default.
    _MATVIEW_SQL = """
        SELECT
            a.attname                              AS name,
            format_type(a.atttypid, a.atttypmod)   AS data_type,
            format_type(a.atttypid, a.atttypmod)   AS full_type,
            NULL::text                             AS default_expr,
            (NOT a.attnotnull)                     AS nullable,
            false                                  AS is_generated,
            false                                  AS has_default,
            false                                  AS is_primary_key,
            NULL::text                             AS sequence_schema,
            NULL::text                             AS sequence_name
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c     ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
          AND c.relkind = 'm'
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
    """

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the table to introspect.
        """
        super().__init__(conn, table.schema, table.name)
        self._table: TableRef = table

    async def apply(self) -> None:
        """
        Fetch the column metadata rows for the relation.

        Tables and regular views resolve through ``information_schema``; a
        materialized view returns no rows there, so an empty first result falls
        back to the ``pg_catalog`` query. A relation missing from both stays
        empty, which the route's ``_columns_for`` gate maps to a 404.
        """
        self._raw = await self._conn.fetch(self._SQL, self._table.schema, self._table.name)

        if not self._raw:
            self._raw = await self._conn.fetch(
                self._MATVIEW_SQL, self._table.schema, self._table.name
            )

    def get_columns_result(self) -> list[ColumnMeta]:
        """
        Return the typed column metadata, with derived wire types.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            One ``ColumnMeta`` per column, in ordinal order.
        """
        return [column_meta(r) for r in self._rows()]

    def get_result(self) -> list[dict]:
        """
        Return the contract JSON for each column.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            One contract dict (name, dataType, nullable, isPrimaryKey,
            isGenerated, hasDefault, wireType, fullType, defaultExpr,
            sequence) per column.
        """
        return [m.to_contract() for m in self.get_columns_result()]
