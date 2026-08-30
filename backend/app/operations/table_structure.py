"""
Per-table structure queries over ``pg_catalog`` — a table's indexes, its non-FK
constraints (primary key / unique / check), and its foreign keys with their
referenced relation and referential actions. Read-only; together they back the
combined ``/structure`` endpoint. The shared ``catalog.py`` SQL fragments bind
the schema and table as query parameters, never interpolated, so no identifier
quoting is needed and injection is impossible — the same discipline as
``role_detail``.
"""

from __future__ import annotations

import asyncpg

from ..contract import TableRef
from ..errors import NotFound
from .base import CatalogQuery
from .catalog import (
    CONSTRAINT_FROM,
    CONSTRAINT_SELECT,
    FOREIGN_KEY_FROM,
    FOREIGN_KEY_SELECT,
    INDEX_FROM,
    INDEX_SELECT,
    constraint_payload,
    foreign_key_payload,
    index_payload,
)


class ListIndexesQuery(CatalogQuery):
    """
    The indexes on one table, each with its full ``CREATE INDEX`` text and the
    unique/primary flags (from ``pg_indexes`` joined to ``pg_index``).
    """

    _SQL = f"SELECT {INDEX_SELECT} {INDEX_FROM} ORDER BY i.indexname"

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the table to introspect.
        """
        super().__init__(conn, table.schema, table.name, None)

    def get_result(self) -> list[dict]:
        """
        Return one contract dict per index.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{name, definition, unique, primary}]`` ordered by index name.
        """
        return [index_payload(r) for r in self._rows()]


class IndexDetailQuery(CatalogQuery):
    """
    One index's full ``CREATE INDEX`` text, unique/primary flags, and owning
    table, located by schema + index name alone (backs the Indexes-category
    info tab, opened fresh per index rather than trusting the navigator's
    cached schema-wide list — see the same-shaped ``SequenceDetailQuery``).
    """

    # Keyed by index name instead of table name (ListIndexesQuery's filter),
    # with the owning table name added to the SELECT list. `table` is aliased
    # `table_name` here — the wire key `table` is reserved for the mapped
    # result, since `TABLE` is a reserved SQL keyword.
    _SQL = f"SELECT {INDEX_SELECT}, i.tablename AS table_name {INDEX_FROM}"

    def __init__(self, conn: asyncpg.Connection, index: TableRef) -> None:
        """
        Capture the connection and the index to introspect (``index.name``
        holds the index's own name, not a table's — mirrors how
        ``SequenceDetailQuery`` reuses ``TableRef.name`` for a sequence).
        """
        super().__init__(conn, index.schema, None, index.name)
        self._index: TableRef = index

    def get_result(self) -> dict:
        """
        Return the index's definition, flags, and owning table.

        Raises:
            RuntimeError: if called before ``apply()``.
            NotFound: if no index by that name exists.

        Returns:
            ``{name, definition, unique, primary, table}``.
        """
        rows = self._rows()

        if not rows:
            raise NotFound(f"Index '{self._index.schema}.{self._index.name}' not found")

        row = rows[0]

        return {**index_payload(row), "table": row["table_name"]}


class ListConstraintsQuery(CatalogQuery):
    """
    One table's non-FK constraints — primary key (``p``), unique (``u``), and
    check (``c``) — with the reconstructed clause from ``pg_get_constraintdef``.
    Foreign keys are excluded here; they get their own richer query.
    """

    _SQL = f"SELECT {CONSTRAINT_SELECT} {CONSTRAINT_FROM} ORDER BY con.contype, con.conname"

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the table to introspect.
        """
        super().__init__(conn, table.schema, table.name)

    def get_result(self) -> list[dict]:
        """
        Return one contract dict per constraint.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{name, type, columns, definition}]`` where ``type`` is the mapped
            ``primaryKey``/``unique``/``check`` string.
        """
        return [constraint_payload(r) for r in self._rows()]


class ListForeignKeysQuery(CatalogQuery):
    """
    One table's foreign keys, each with its local columns, referenced
    schema/table/columns, and the update/delete referential actions
    (``pg_constraint`` where ``contype='f'``).
    """

    _SQL = f"SELECT {FOREIGN_KEY_SELECT} {FOREIGN_KEY_FROM} ORDER BY con.conname"

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the table to introspect.
        """
        super().__init__(conn, table.schema, table.name)

    def get_result(self) -> list[dict]:
        """
        Return one contract dict per foreign key, mapping the action codes.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[{name, columns, refSchema, refTable, refColumns, onUpdate,
            onDelete}]`` ordered by constraint name.
        """
        return [foreign_key_payload(r) for r in self._rows()]
