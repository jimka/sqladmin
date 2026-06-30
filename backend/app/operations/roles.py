"""
ListRolesQuery — the roles browser's role list (``pg_catalog.pg_roles``).

``pg_roles`` is the publicly-readable view over ``pg_authid`` (it blanks the
password), so listing roles and their attributes needs no superuser.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import asyncpg

from ..contract import RoleSummary
from .base import Query

# The pg_roles attribute columns shared by the list query and the per-role
# attributes query (see role_detail.py), kept in one place so both select the
# same shape that summary_from_row() maps.
_ROLE_COLUMNS = (
    "rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, "
    "rolcanlogin, rolreplication, rolconnlimit, rolvaliduntil"
)


def summary_from_row(row: Mapping[str, Any]) -> RoleSummary:
    """
    Map one ``pg_roles`` row to a ``RoleSummary``, making the temporal and
    limit values wire-safe (``rolvaliduntil`` -> ISO string or None;
    ``rolconnlimit`` passed through as an int, ``-1`` sentinel preserved).
    """
    valid_until = row["rolvaliduntil"]

    return RoleSummary(
        name=row["rolname"],
        can_login=bool(row["rolcanlogin"]),
        is_superuser=bool(row["rolsuper"]),
        inherit=bool(row["rolinherit"]),
        create_role=bool(row["rolcreaterole"]),
        create_db=bool(row["rolcreatedb"]),
        replication=bool(row["rolreplication"]),
        connection_limit=row["rolconnlimit"],
        valid_until=valid_until.isoformat() if valid_until is not None else None,
    )


class ListRolesQuery(Query):
    """
    List every role with its ``pg_roles`` attribute flags.
    """

    _SQL = f"SELECT {_ROLE_COLUMNS} FROM pg_catalog.pg_roles ORDER BY rolname"

    def __init__(self, conn: asyncpg.Connection) -> None:
        """
        Capture the connection.
        """
        self._conn: asyncpg.Connection = conn
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch every role's attribute row.
        """
        self._raw = await self._conn.fetch(self._SQL)

    def get_result(self) -> list[dict]:
        """
        Return one ``RoleSummary`` contract dict per role.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[RoleSummary.to_contract()]`` ordered by role name.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return [summary_from_row(r).to_contract() for r in self._raw]
