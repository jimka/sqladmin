"""
Per-role detail queries over ``pg_catalog`` — the role's own attributes, the
roles it is a member of, and the table privileges it holds. Read-only; together
they back the combined ``/roles/{role}`` endpoint. The role name is always
bound as a query parameter (``$1``), never interpolated, so no identifier
quoting is needed and injection is impossible.
"""

from __future__ import annotations

import asyncpg

from ..contract import RoleMembership, RolePrivilege
from .base import CatalogQuery
from .roles import _ROLE_COLUMNS, summary_from_row


class RoleAttributesQuery(CatalogQuery):
    """
    One role's ``pg_roles`` attribute row, or ``None`` when no such role exists.
    """

    _SQL = f"SELECT {_ROLE_COLUMNS} FROM pg_catalog.pg_roles WHERE rolname = $1"

    def __init__(self, conn: asyncpg.Connection, role: str) -> None:
        """
        Capture the connection and the role name to look up.
        """
        super().__init__(conn, role)

    def get_result(self) -> dict | None:
        """
        Return the role's ``RoleSummary`` contract dict, or ``None`` if absent.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            The ``RoleSummary.to_contract()`` dict, or ``None`` when the role
            does not exist (the route maps ``None`` to a 404).
        """
        rows = self._rows()

        if not rows:
            return None

        return summary_from_row(rows[0]).to_contract()


class RoleMembershipsQuery(CatalogQuery):
    """
    The roles the given role is a member of (its parent/group roles).
    """

    _SQL = (
        "SELECT g.rolname AS role_name, m.admin_option "
        "FROM pg_catalog.pg_auth_members m "
        "JOIN pg_catalog.pg_roles r ON r.oid = m.member "
        "JOIN pg_catalog.pg_roles g ON g.oid = m.roleid "
        "WHERE r.rolname = $1 "
        "ORDER BY g.rolname"
    )

    def __init__(self, conn: asyncpg.Connection, role: str) -> None:
        """
        Capture the connection and the member role name.
        """
        super().__init__(conn, role)

    def get_result(self) -> list[dict]:
        """
        Return one ``RoleMembership`` contract dict per parent role.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[RoleMembership.to_contract()]`` ordered by parent role name.
        """
        return [
            RoleMembership(role_name=r["role_name"], admin=bool(r["admin_option"])).to_contract()
            for r in self._rows()
        ]


class RolePrivilegesQuery(CatalogQuery):
    """
    The table privileges held by the role (``information_schema`` view, so it
    returns only grants the connection role is allowed to observe).
    """

    _SQL = (
        "SELECT table_schema, table_name, privilege_type, is_grantable "
        "FROM information_schema.role_table_grants "
        "WHERE grantee = $1 "
        "ORDER BY table_schema, table_name, privilege_type"
    )

    def __init__(self, conn: asyncpg.Connection, role: str) -> None:
        """
        Capture the connection and the grantee role name.
        """
        super().__init__(conn, role)

    def get_result(self) -> list[dict]:
        """
        Return one ``RolePrivilege`` contract dict per table grant.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``[RolePrivilege.to_contract()]`` ordered by schema, table, privilege.
        """
        return [
            RolePrivilege(
                schema=r["table_schema"],
                table=r["table_name"],
                privilege=r["privilege_type"],
                grantable=r["is_grantable"] == "YES",
            ).to_contract()
            for r in self._rows()
        ]
