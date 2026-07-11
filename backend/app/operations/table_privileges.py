"""
TablePrivilegesQuery — the connected user's effective INSERT/UPDATE/DELETE/SELECT
rights on one table.

``has_table_privilege`` checks the *current session role*, including privileges
inherited from roles it is a member of, so the result is exactly what this login
may do — the signal the frontend uses to enable or disable the table editor's
Add/Delete/Save actions. Read-only; the relation is resolved through the catalog
by (schema, name) so no identifier interpolation is needed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from ..contract import TablePrivileges, TableRef
from .base import Query


class TablePrivilegesQuery(Query):
    """
    The session role's SELECT/INSERT/UPDATE/DELETE privileges on one table.
    """

    # Resolve the relation's oid via the catalog (avoids identifier quoting),
    # then probe each verb with has_table_privilege on that oid. A missing table
    # yields zero rows -> get_result() reports all-false (writes disabled), which
    # is the safe default; existence is already validated by the /columns fetch
    # the frontend runs first.
    _SQL = """
        SELECT
            has_table_privilege(c.oid, 'SELECT') AS can_select,
            has_table_privilege(c.oid, 'INSERT') AS can_insert,
            has_table_privilege(c.oid, 'UPDATE') AS can_update,
            has_table_privilege(c.oid, 'DELETE') AS can_delete
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
    """

    def __init__(self, conn: asyncpg.Connection, table: TableRef) -> None:
        """
        Capture the connection and the table to probe.
        """
        self._conn: asyncpg.Connection = conn
        self._table: TableRef = table
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Probe the four privileges for the table (zero or one row).
        """
        self._raw = await self._conn.fetch(self._SQL, self._table.schema, self._table.name)

    def get_result(self) -> dict:
        """
        Return the ``TablePrivileges`` contract dict.

        A missing table (no row) reports every privilege as false, so the
        frontend disables all write actions rather than 404 the whole tab.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``TablePrivileges.to_contract()`` — select/insert/update/delete flags.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        if not self._raw:
            return TablePrivileges(select=False, insert=False, update=False, delete=False).to_contract()

        row = self._raw[0]

        return TablePrivileges(
            select=bool(row["can_select"]),
            insert=bool(row["can_insert"]),
            update=bool(row["can_update"]),
            delete=bool(row["can_delete"]),
        ).to_contract()
