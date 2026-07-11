"""
The wire contract — the fixed scalar set the backend emits, and the small
value objects passed between routes and operations.

The backend NEVER returns raw Postgres/asyncpg values; every native value is
mapped into one of the ``WireType`` scalars (see ``wire.py``). The frontend's
``Model``/``Field`` types mirror this set, never Postgres.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class WireType(str, Enum):
    """
    The fixed set of contract scalars a row value can arrive as.
    """

    NUMBER = "number"          # smallint/int/bigint/real/double
    STRING = "string"          # text/varchar/char/uuid, and numeric (precision-preserving)
    BOOLEAN = "boolean"        # bool
    ISO_STRING = "isoString"   # timestamptz/timestamp/date/time -> ISO-8601 string
    JSON = "json"              # json/jsonb -> passthrough (object/array/scalar)
    BASE64 = "base64"          # bytea -> base64 string
    JSON_ARRAY = "jsonArray"   # Postgres array -> JSON array


@dataclass(frozen=True)
class TableRef:
    """
    Identifies one table/view within a connection. ``database`` is carried
    for the multi-DB seam; Phase 0-1 query the connection's own database.
    """

    database: str
    schema: str
    name: str


@dataclass(frozen=True)
class ColumnMeta:
    """
    One column's introspected metadata. Drives Model + ColumnSpec on the
    frontend and the identifier-validation/`to_wire` mapping on the backend.
    """

    name: str
    data_type: str          # Postgres type name, e.g. "integer", "timestamp with time zone"
    nullable: bool
    is_primary_key: bool
    is_generated: bool       # serial / identity / generated — omitted from INSERT body
    has_default: bool        # has a column default (e.g. now()) — not user-required on INSERT
    wire_type: WireType      # the contract scalar a row value of this column arrives as

    def to_contract(self) -> dict:
        """
        Serialize to the contract JSON the ``/columns`` route returns.

        Returns:
            A dict with name, dataType, nullable, isPrimaryKey, isGenerated,
            hasDefault, and wireType.
        """
        return {
            "name": self.name,
            "dataType": self.data_type,
            "nullable": self.nullable,
            "isPrimaryKey": self.is_primary_key,
            "isGenerated": self.is_generated,
            "hasDefault": self.has_default,
            "wireType": self.wire_type.value,
        }


@dataclass(frozen=True)
class TablePrivileges:
    """
    The current session role's effective privileges on one table — what it may
    actually do, accounting for role membership/inheritance (``has_table_privilege``
    checks the connected user). Drives the edit toolbar's Add/Delete/Save gating
    and cell editability on the frontend.
    """

    select: bool
    insert: bool
    update: bool
    delete: bool

    def to_contract(self) -> dict:
        """
        Serialize to the contract JSON the ``/privileges`` route returns.

        Returns:
            A dict with select, insert, update, and delete boolean flags.
        """
        return {
            "select": self.select,
            "insert": self.insert,
            "update": self.update,
            "delete": self.delete,
        }


@dataclass(frozen=True)
class RoleSummary:
    """
    One PostgreSQL role (user or group) with its ``pg_roles`` attribute flags.
    A role with ``can_login`` reads as a "user"; without it, as a "group".
    """

    name: str                     # rolname
    can_login: bool               # rolcanlogin
    is_superuser: bool            # rolsuper
    inherit: bool                 # rolinherit
    create_role: bool             # rolcreaterole
    create_db: bool               # rolcreatedb
    replication: bool             # rolreplication
    connection_limit: int         # rolconnlimit; -1 means "no limit"
    valid_until: str | None       # rolvaliduntil as ISO-8601, or None for no expiry

    def to_contract(self) -> dict:
        """
        Serialize to the contract JSON the ``/roles`` routes emit.
        """
        return {
            "name": self.name,
            "canLogin": self.can_login,
            "isSuperuser": self.is_superuser,
            "inherit": self.inherit,
            "createRole": self.create_role,
            "createDb": self.create_db,
            "replication": self.replication,
            "connectionLimit": self.connection_limit,
            "validUntil": self.valid_until,
        }


@dataclass(frozen=True)
class RoleMembership:
    """
    One membership edge: the subject role is a member of ``role_name``.
    """

    role_name: str                # the granting/parent role
    admin: bool                   # admin_option on the membership

    def to_contract(self) -> dict:
        """
        Serialize to the contract JSON for one membership row.
        """
        return {"roleName": self.role_name, "admin": self.admin}


@dataclass(frozen=True)
class RolePrivilege:
    """
    One table privilege held by a role.
    """

    schema: str                   # table_schema
    table: str                    # table_name
    privilege: str                # privilege_type (SELECT/INSERT/...)
    grantable: bool               # is_grantable

    def to_contract(self) -> dict:
        """
        Serialize to the contract JSON for one privilege grant.
        """
        return {
            "schema": self.schema,
            "table": self.table,
            "privilege": self.privilege,
            "grantable": self.grantable,
        }
