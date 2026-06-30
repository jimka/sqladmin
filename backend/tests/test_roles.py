"""
ListRolesQuery: get_result() maps pg_roles rows to RoleSummary contract dicts.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.operations import ListRolesQuery
from tests.conftest import NO_CONN


def role_row(**overrides) -> dict:
    """A pg_roles result row (the SQL's selected columns) with sane defaults."""
    base = {
        "rolname": "app",
        "rolsuper": False,
        "rolinherit": True,
        "rolcreaterole": False,
        "rolcreatedb": False,
        "rolcanlogin": True,
        "rolreplication": False,
        "rolconnlimit": -1,
        "rolvaliduntil": None,
    }
    base.update(overrides)
    return base


def test_get_result_maps_all_attributes() -> None:
    op = ListRolesQuery(NO_CONN)
    op._raw = [role_row()]

    assert op.get_result() == [
        {
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
    ]


def test_valid_until_null_stays_null() -> None:
    op = ListRolesQuery(NO_CONN)
    op._raw = [role_row(rolvaliduntil=None)]

    assert op.get_result()[0]["validUntil"] is None


def test_valid_until_datetime_becomes_isostring() -> None:
    expiry = datetime(2030, 1, 2, 3, 4, 5)
    op = ListRolesQuery(NO_CONN)
    op._raw = [role_row(rolname="temp", rolvaliduntil=expiry)]

    assert op.get_result()[0]["validUntil"] == expiry.isoformat()


def test_connection_limit_sentinel_and_value_pass_through() -> None:
    op = ListRolesQuery(NO_CONN)
    op._raw = [role_row(rolname="nomax", rolconnlimit=-1), role_row(rolname="capped", rolconnlimit=5)]

    limits = [r["connectionLimit"] for r in op.get_result()]
    assert limits == [-1, 5]


def test_superuser_group_flags() -> None:
    # A superuser group: superuser true, cannot log in.
    op = ListRolesQuery(NO_CONN)
    op._raw = [role_row(rolname="admins", rolsuper=True, rolcanlogin=False)]

    row = op.get_result()[0]
    assert row["isSuperuser"] is True
    assert row["canLogin"] is False


def test_empty_result() -> None:
    op = ListRolesQuery(NO_CONN)
    op._raw = []

    assert op.get_result() == []


def test_get_result_before_apply_raises() -> None:
    with pytest.raises(RuntimeError):
        ListRolesQuery(NO_CONN).get_result()
