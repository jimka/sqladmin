"""
ListColumnsQuery — columns + PK + generated flags + backing sequence for one
table.

``get_result()`` returns the contract JSON for the ``/columns`` route;
``get_columns_result()`` returns the typed ``ColumnMeta`` list the row
operations consume.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from ..contract import ColumnMeta, SequenceRef, TableRef
from ..wire import pg_type_to_wire
from .base import Query


class ListColumnsQuery(Query):
    """
    Introspect one table's columns, marking primary-key and generated ones.
    """

    # The backing-sequence subquery (`seq`) unions the two DISTINCT ways a
    # column can be tied to a sequence. The two arms have OPPOSITE join
    # orientations, which is the easiest thing here to get wrong:
    #
    #   Arm (a) OWNED BY (serial, GENERATED ... AS IDENTITY): the SEQUENCE is
    #     the dependent object, so it is d.objid and the column is d.refobjid.
    #   Arm (b) DEFAULT nextval(...): the ATTRDEF is the dependent object, so
    #     the SEQUENCE is the REFERENCED side (d.refobjid) instead.
    #
    # Writing arm (b) with arm (a)'s orientation returns zero rows — and still
    # looks correct for serial/identity columns, which arm (a) covers.
    _SQL = """
        SELECT
            c.column_name AS name,
            c.data_type   AS data_type,
            (c.is_nullable = 'YES') AS nullable,
            COALESCE(
                c.is_identity = 'YES'
                OR c.is_generated = 'ALWAYS'
                OR c.column_default LIKE 'nextval(%',
                false
            ) AS is_generated,
            (c.column_default IS NOT NULL) AS has_default,
            COALESCE(pk.is_pk, false) AS is_primary_key,
            seq.sequence_schema AS sequence_schema,
            seq.sequence_name   AS sequence_name
        FROM information_schema.columns c
        LEFT JOIN (
            SELECT kcu.column_name, true AS is_pk
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name
             AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = $1 AND tc.table_name = $2
        ) pk ON pk.column_name = c.column_name
        LEFT JOIN (
            SELECT DISTINCT ON (l.attnum)
                   a.attname  AS column_name,
                   sn.nspname AS sequence_schema,
                   s.relname  AS sequence_name
            FROM (
                -- Arm (a): the sequence is OWNED BY the column.
                SELECT d.refobjid AS attrelid, d.refobjsubid AS attnum, d.objid AS seqid, 1 AS arm
                FROM pg_catalog.pg_depend d
                WHERE d.classid = 'pg_class'::regclass
                  AND d.refclassid = 'pg_class'::regclass
                  AND d.deptype IN ('a', 'i')
                  AND d.refobjsubid > 0
                UNION ALL
                -- Arm (b): the column's DEFAULT calls nextval() on the sequence.
                SELECT ad.adrelid, ad.adnum, d.refobjid, 2
                FROM pg_catalog.pg_depend d
                JOIN pg_catalog.pg_attrdef ad ON ad.oid = d.objid
                WHERE d.classid = 'pg_attrdef'::regclass
                  AND d.refclassid = 'pg_class'::regclass
                  AND d.deptype = 'n'
            ) l
            -- relkind='S' is load-bearing, not cosmetic: arm (b)'s
            -- refclassid='pg_class' ALSO matches a generated-STORED column's
            -- references to its own table's columns, which would otherwise be
            -- reported as that column's "sequence".
            JOIN pg_catalog.pg_class s      ON s.oid = l.seqid AND s.relkind = 'S'
            JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
            JOIN pg_catalog.pg_class rc     ON rc.oid = l.attrelid
            JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
            JOIN pg_catalog.pg_attribute a  ON a.attrelid = l.attrelid AND a.attnum = l.attnum
            WHERE rn.nspname = $1 AND rc.relname = $2
            -- arm DESC: a DEFAULT (arm 2) beats an OWNED BY (arm 1) when the two
            -- disagree — the DEFAULT is what actually supplies the value at
            -- INSERT. The trailing name sort makes a same-arm tie deterministic
            -- (a column can own two sequences, or default from two).
            ORDER BY l.attnum, l.arm DESC, sn.nspname, s.relname
        ) seq ON seq.column_name = c.column_name
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position
    """

    # information_schema.columns (SQL-standard) omits materialized views, so a
    # matview's columns come from pg_catalog instead. pg_attribute + format_type
    # yield the same name/data_type/nullable shape; a matview has no primary key,
    # generated column, or default, so those flags are constant-false — and, for
    # the same reason (no default to call nextval() from, and nothing OWNED BY a
    # matview column), no backing sequence, so those two are constant-NULL. The
    # casts are what let asyncpg type the NULL columns. data_type arrives as a
    # format_type() string (e.g. "numeric", "integer") which pg_type_to_wire maps
    # exactly as it does the information_schema names.
    _MATVIEW_SQL = """
        SELECT
            a.attname                              AS name,
            format_type(a.atttypid, a.atttypmod)   AS data_type,
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
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._raw: Sequence[Mapping[str, Any]] | None = None

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
        if self._raw is None:
            raise RuntimeError("get_columns_result() called before apply()")

        return [
            ColumnMeta(
                name=r["name"],
                data_type=r["data_type"],
                nullable=r["nullable"],
                is_primary_key=r["is_primary_key"],
                is_generated=r["is_generated"],
                has_default=r["has_default"],
                wire_type=pg_type_to_wire(r["data_type"]),
                sequence=(
                    SequenceRef(schema=r["sequence_schema"], name=r["sequence_name"])
                    if r["sequence_schema"] is not None
                    else None
                ),
            )
            for r in self._raw
        ]

    def get_result(self) -> list[dict]:
        """
        Return the contract JSON for each column.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            One contract dict (name, dataType, nullable, isPrimaryKey,
            isGenerated, hasDefault, wireType, sequence) per column.
        """
        return [m.to_contract() for m in self.get_columns_result()]
