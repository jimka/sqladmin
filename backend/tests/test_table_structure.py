"""
ListIndexesQuery / ListConstraintsQuery / ListForeignKeysQuery: the pure
get_result() transforms backing the combined ``/structure`` endpoint. Each is
exercised offline by setting ``_raw`` by hand (no database), mirroring the
role-detail test style. IndexDetailQuery (the single-index info-tab fetch)
follows the same offline style, plus its NotFound-on-empty case, mirroring
test_sequence_detail.py.
"""

from __future__ import annotations

import pytest

from app.contract import TableRef
from app.errors import NotFound
from app.operations import (
    IndexDetailQuery,
    ListConstraintsQuery,
    ListForeignKeysQuery,
    ListIndexesQuery,
)
from tests.conftest import TABLE, NO_CONN

_INDEX = TableRef("sqladmin", "public", "customers_pkey")


def test_indexes_pass_through_with_booleans() -> None:
    op = ListIndexesQuery(NO_CONN, TABLE)
    op._raw = [
        {
            "name": "customers_pkey",
            "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)",
            "unique": True,
            "primary": True,
        },
        {
            "name": "customers_email_idx",
            "definition": "CREATE INDEX customers_email_idx ON public.customers USING btree (email)",
            "unique": False,
            "primary": False,
        },
    ]

    assert op.get_result() == [
        {
            "name": "customers_pkey",
            "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)",
            "unique": True,
            "primary": True,
        },
        {
            "name": "customers_email_idx",
            "definition": "CREATE INDEX customers_email_idx ON public.customers USING btree (email)",
            "unique": False,
            "primary": False,
        },
    ]


def test_indexes_empty() -> None:
    op = ListIndexesQuery(NO_CONN, TABLE)
    op._raw = []

    assert op.get_result() == []


def test_constraints_map_contype_to_type() -> None:
    op = ListConstraintsQuery(NO_CONN, TABLE)
    op._raw = [
        {
            "name": "customers_pkey",
            "contype": "p",
            "columns": ["id"],
            "definition": "PRIMARY KEY (id)",
        },
        {
            "name": "customers_email_key",
            "contype": "u",
            "columns": ["email"],
            "definition": "UNIQUE (email)",
        },
        {
            "name": "customers_balance_check",
            "contype": "c",
            "columns": [],
            "definition": "CHECK (balance >= 0)",
        },
    ]

    assert op.get_result() == [
        {"name": "customers_pkey", "type": "primaryKey", "columns": ["id"], "definition": "PRIMARY KEY (id)"},
        {"name": "customers_email_key", "type": "unique", "columns": ["email"], "definition": "UNIQUE (email)"},
        {"name": "customers_balance_check", "type": "check", "columns": [], "definition": "CHECK (balance >= 0)"},
    ]


def test_constraints_empty() -> None:
    op = ListConstraintsQuery(NO_CONN, TABLE)
    op._raw = []

    assert op.get_result() == []


def test_foreign_keys_map_actions_and_pass_arrays() -> None:
    op = ListForeignKeysQuery(NO_CONN, TABLE)
    op._raw = [
        {
            "name": "orders_customer_id_fkey",
            "on_update": "c",
            "on_delete": "a",
            "ref_schema": "public",
            "ref_table": "customers",
            "columns": ["customer_id"],
            "ref_columns": ["id"],
        }
    ]

    assert op.get_result() == [
        {
            "name": "orders_customer_id_fkey",
            "columns": ["customer_id"],
            "refSchema": "public",
            "refTable": "customers",
            "refColumns": ["id"],
            "onUpdate": "CASCADE",
            "onDelete": "NO ACTION",
        }
    ]


def test_foreign_keys_cover_every_action_code() -> None:
    op = ListForeignKeysQuery(NO_CONN, TABLE)
    op._raw = [
        {
            "name": f"fk_{code}",
            "on_update": code,
            "on_delete": code,
            "ref_schema": "public",
            "ref_table": "t",
            "columns": ["c"],
            "ref_columns": ["id"],
        }
        for code in ("a", "r", "c", "n", "d")
    ]

    actions = [(row["onUpdate"], row["onDelete"]) for row in op.get_result()]

    assert actions == [
        ("NO ACTION", "NO ACTION"),
        ("RESTRICT", "RESTRICT"),
        ("CASCADE", "CASCADE"),
        ("SET NULL", "SET NULL"),
        ("SET DEFAULT", "SET DEFAULT"),
    ]


def test_foreign_keys_empty() -> None:
    op = ListForeignKeysQuery(NO_CONN, TABLE)
    op._raw = []

    assert op.get_result() == []


def test_get_result_before_apply_raises() -> None:
    for op in (
        ListIndexesQuery(NO_CONN, TABLE),
        ListConstraintsQuery(NO_CONN, TABLE),
        ListForeignKeysQuery(NO_CONN, TABLE),
        IndexDetailQuery(NO_CONN, TABLE),
    ):
        with pytest.raises(RuntimeError):
            op.get_result()


def test_index_detail_maps_raw_row_to_contract_shape() -> None:
    op = IndexDetailQuery(NO_CONN, _INDEX)
    op._raw = [
        {
            "name": "customers_pkey",
            "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)",
            "unique": True,
            "primary": True,
            "table_name": "customers",
        },
    ]

    assert op.get_result() == {
        "name": "customers_pkey",
        "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)",
        "unique": True,
        "primary": True,
        "table": "customers",
    }


def test_index_detail_raises_not_found_when_absent() -> None:
    op = IndexDetailQuery(NO_CONN, _INDEX)
    op._raw = []

    with pytest.raises(NotFound):
        op.get_result()


def test_list_indexes_binds_schema_table_and_no_index_name() -> None:
    # ListIndexesQuery shares INDEX_FROM with IndexDetailQuery/SchemaIndexesQuery,
    # which binds a NULL-guarded $3 for the index-name scope this query doesn't use.
    op = ListIndexesQuery(NO_CONN, TABLE)

    assert op._args == ("public", "customers", None)


def test_index_detail_binds_schema_index_name_and_no_table() -> None:
    op = IndexDetailQuery(NO_CONN, _INDEX)

    assert op._args == ("public", None, "customers_pkey")
