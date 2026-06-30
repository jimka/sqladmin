"""
RoleAttributesQuery / RoleMembershipsQuery / RolePrivilegesQuery: the pure
get_result() transforms backing the combined per-role detail endpoint.
"""

from __future__ import annotations

import pytest

from app.operations import (
    RoleAttributesQuery,
    RoleMembershipsQuery,
    RolePrivilegesQuery,
)
from tests.conftest import NO_CONN
from tests.test_roles import role_row


def test_attributes_present_maps_one_summary() -> None:
    op = RoleAttributesQuery(NO_CONN, "app")
    op._raw = [role_row()]

    assert op.get_result() == {
        "name": "app",
        "canLogin": True,
        "isSuperuser": False,
        "inherit": True,
        "createRole": False,
        "createDb": False,
        "replication": False,
        "connectionLimit": -1,
        "validUntil": None,
    }


def test_attributes_absent_returns_none() -> None:
    # An applied query that matched no role yields None (route maps to 404),
    # distinct from the before-apply RuntimeError.
    op = RoleAttributesQuery(NO_CONN, "ghost")
    op._raw = []

    assert op.get_result() is None


def test_memberships_map_in_order() -> None:
    op = RoleMembershipsQuery(NO_CONN, "app")
    op._raw = [
        {"role_name": "app_rw", "admin_option": True},
        {"role_name": "app_ro", "admin_option": False},
    ]

    assert op.get_result() == [
        {"roleName": "app_rw", "admin": True},
        {"roleName": "app_ro", "admin": False},
    ]


def test_memberships_empty() -> None:
    op = RoleMembershipsQuery(NO_CONN, "app")
    op._raw = []

    assert op.get_result() == []


def test_privileges_map_grantable_flag() -> None:
    op = RolePrivilegesQuery(NO_CONN, "app")
    op._raw = [
        {"table_schema": "public", "table_name": "t", "privilege_type": "SELECT", "is_grantable": "YES"},
        {"table_schema": "public", "table_name": "t", "privilege_type": "INSERT", "is_grantable": "NO"},
    ]

    assert op.get_result() == [
        {"schema": "public", "table": "t", "privilege": "SELECT", "grantable": True},
        {"schema": "public", "table": "t", "privilege": "INSERT", "grantable": False},
    ]


def test_privileges_empty() -> None:
    op = RolePrivilegesQuery(NO_CONN, "app")
    op._raw = []

    assert op.get_result() == []


def test_get_result_before_apply_raises() -> None:
    for op in (
        RoleAttributesQuery(NO_CONN, "app"),
        RoleMembershipsQuery(NO_CONN, "app"),
        RolePrivilegesQuery(NO_CONN, "app"),
    ):
        with pytest.raises(RuntimeError):
            op.get_result()
