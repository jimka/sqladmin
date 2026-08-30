"""
Role introspection — the Roles rail's list and detail views.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import require_session
from ..connections import Session, session_pool_for
from ..errors import NotFound
from ..operations import ListRolesQuery, RoleAttributesQuery, RoleMembershipsQuery, RolePrivilegesQuery
from .common import CONNECTION_PREFIX

router = APIRouter(prefix=CONNECTION_PREFIX, tags=["roles"])


@router.get("/roles")
async def roles(
    connection_id: str, session: Session = Depends(require_session)
) -> list[dict]:
    """
    List the roles (users and groups) on a connection with their attributes.

    Route: ``GET /api/{connection_id}/roles``.

    Returns:
        ``[RoleSummary]`` as contract JSON — one entry per role, name-ordered.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        op = ListRolesQuery(c)
        await op.apply()

        return op.get_result()


@router.get("/roles/{role}")
async def role_detail(
    connection_id: str, role: str, session: Session = Depends(require_session)
) -> dict:
    """
    One role's attributes plus the roles it belongs to and the table grants it
    holds.

    Route: ``GET /api/{connection_id}/roles/{role}``.

    Raises:
        NotFound: if no role by that name exists (mapped to 404).

    Returns:
        The ``RoleDetail`` contract shape ``{role, memberOf, privileges}``.
    """
    async with session_pool_for(session, connection_id).acquire() as c:
        attrs = RoleAttributesQuery(c, role)
        await attrs.apply()
        summary = attrs.get_result()

        if summary is None:
            raise NotFound(f"Role '{role}' not found")

        memberships = RoleMembershipsQuery(c, role)
        await memberships.apply()

        privileges = RolePrivilegesQuery(c, role)
        await privileges.apply()

        return {
            "role": summary,
            "memberOf": memberships.get_result(),
            "privileges": privileges.get_result(),
        }
