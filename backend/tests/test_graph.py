"""
The bulk schema/database graph module: the five schema/database-wide queries'
pure ``get_result()`` mappings (offline, ``_raw`` set by hand, mirroring
``test_table_structure.py``) and the two pure ``assemble_*`` helpers that
group their flat rows into the frontend's per-table / per-schema shape. Also
covers ``flatten_schema_indexes``, the navigator's schema-wide Indexes-category
pure helper that reuses ``SchemaIndexesQuery``'s rows.
"""

from __future__ import annotations

import pytest

from app.operations.graph import (
    SchemaColumnsQuery,
    SchemaConstraintsQuery,
    SchemaForeignKeysQuery,
    SchemaIndexesQuery,
    SchemaTablesQuery,
    assemble_database_graph,
    assemble_schema_graph,
    flatten_schema_indexes,
)
from tests.conftest import NO_CONN


def _query(cls):
    """
    Build one of the five graph queries over a concrete schema (conn unused
    offline).
    """
    return cls(NO_CONN, "public")


def test_tables_pass_through_schema_and_table() -> None:
    op = _query(SchemaTablesQuery)
    op._raw = [{"schema": "public", "table": "customers"}, {"schema": "public", "table": "orders"}]

    assert op.get_result() == [
        {"schema": "public", "table": "customers"},
        {"schema": "public", "table": "orders"},
    ]


def test_columns_wraps_column_meta_as_payload() -> None:
    op = _query(SchemaColumnsQuery)
    op._raw = [
        {
            "schema": "public", "table": "customers",
            "name": "id", "data_type": "integer", "nullable": False,
            "is_primary_key": True, "is_generated": True, "has_default": True,
            "sequence_schema": "public", "sequence_name": "customers_id_seq",
        },
        {
            "schema": "public", "table": "customers",
            "name": "balance", "data_type": "numeric", "nullable": False,
            "is_primary_key": False, "is_generated": False, "has_default": False,
            "sequence_schema": None, "sequence_name": None,
        },
    ]

    assert op.get_result() == [
        {
            "schema": "public", "table": "customers",
            "payload": {
                "name": "id", "dataType": "integer", "nullable": False,
                "isPrimaryKey": True, "isGenerated": True, "hasDefault": True,
                "wireType": "number",
                "sequence": {"schema": "public", "name": "customers_id_seq"},
            },
        },
        {
            "schema": "public", "table": "customers",
            "payload": {
                "name": "balance", "dataType": "numeric", "nullable": False,
                "isPrimaryKey": False, "isGenerated": False, "hasDefault": False,
                "wireType": "string",
                "sequence": None,
            },
        },
    ]


def test_indexes_wraps_booleans_as_payload() -> None:
    op = _query(SchemaIndexesQuery)
    op._raw = [
        {
            "schema": "public", "table": "customers",
            "name": "customers_pkey",
            "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)",
            "unique": True, "primary": True,
        },
    ]

    assert op.get_result() == [
        {
            "schema": "public", "table": "customers",
            "payload": {
                "name": "customers_pkey",
                "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)",
                "unique": True, "primary": True,
            },
        },
    ]


def test_constraints_maps_contype_to_type() -> None:
    op = _query(SchemaConstraintsQuery)
    op._raw = [
        {"schema": "public", "table": "customers", "name": "customers_pkey", "contype": "p", "columns": ["id"], "definition": "PRIMARY KEY (id)"},
        {"schema": "public", "table": "orders", "name": "orders_total_check", "contype": "c", "columns": [], "definition": "CHECK (total >= 0)"},
    ]

    assert op.get_result() == [
        {"schema": "public", "table": "customers", "payload": {"name": "customers_pkey", "type": "primaryKey", "columns": ["id"], "definition": "PRIMARY KEY (id)"}},
        {"schema": "public", "table": "orders", "payload": {"name": "orders_total_check", "type": "check", "columns": [], "definition": "CHECK (total >= 0)"}},
    ]


def test_foreign_keys_maps_action_codes() -> None:
    op = _query(SchemaForeignKeysQuery)
    op._raw = [
        {
            "schema": "public", "table": "orders",
            "name": "orders_customer_id_fkey",
            "on_update": "c", "on_delete": "a",
            "ref_schema": "public", "ref_table": "customers",
            "columns": ["customer_id"], "ref_columns": ["id"],
        },
    ]

    assert op.get_result() == [
        {
            "schema": "public", "table": "orders",
            "payload": {
                "name": "orders_customer_id_fkey",
                "columns": ["customer_id"],
                "refSchema": "public", "refTable": "customers",
                "refColumns": ["id"],
                "onUpdate": "CASCADE", "onDelete": "NO ACTION",
            },
        },
    ]


def test_get_result_before_apply_raises_for_all_five() -> None:
    for cls in (
        SchemaTablesQuery,
        SchemaColumnsQuery,
        SchemaIndexesQuery,
        SchemaConstraintsQuery,
        SchemaForeignKeysQuery,
    ):
        with pytest.raises(RuntimeError):
            _query(cls).get_result()


# --- assemble_schema_graph -------------------------------------------------

def test_assemble_schema_graph_groups_facets_under_their_table_sorted_by_name() -> None:
    tables = [{"schema": "public", "table": "orders"}, {"schema": "public", "table": "customers"}]
    columns = [
        {"schema": "public", "table": "customers", "payload": {"name": "id"}},
        {"schema": "public", "table": "orders", "payload": {"name": "id"}},
    ]
    indexes = [{"schema": "public", "table": "orders", "payload": {"name": "orders_pkey"}}]
    constraints = [{"schema": "public", "table": "customers", "payload": {"name": "customers_pkey"}}]
    foreign_keys = [{"schema": "public", "table": "orders", "payload": {"name": "orders_customer_id_fkey"}}]

    result = assemble_schema_graph(tables, columns, indexes, constraints, foreign_keys)

    assert [t["name"] for t in result] == ["customers", "orders"]
    assert result[0] == {
        "name": "customers",
        "structure": {"indexes": [], "constraints": [{"name": "customers_pkey"}], "foreignKeys": []},
        "columns": [{"name": "id"}],
    }
    assert result[1] == {
        "name": "orders",
        "structure": {"indexes": [{"name": "orders_pkey"}], "constraints": [], "foreignKeys": [{"name": "orders_customer_id_fkey"}]},
        "columns": [{"name": "id"}],
    }


def test_assemble_schema_graph_table_absent_from_every_facet_gets_empty_structure() -> None:
    tables = [{"schema": "public", "table": "audit_log"}]

    result = assemble_schema_graph(tables, [], [], [], [])

    assert result == [{
        "name": "audit_log",
        "structure": {"indexes": [], "constraints": [], "foreignKeys": []},
        "columns": [],
    }]


def test_assemble_schema_graph_preserves_input_row_order_within_a_table() -> None:
    tables = [{"schema": "public", "table": "customers"}]
    columns = [
        {"schema": "public", "table": "customers", "payload": {"name": "id"}},
        {"schema": "public", "table": "customers", "payload": {"name": "email"}},
    ]

    result = assemble_schema_graph(tables, columns, [], [], [])

    assert result[0]["columns"] == [{"name": "id"}, {"name": "email"}]


# --- assemble_database_graph ------------------------------------------------

def test_assemble_database_graph_groups_by_schema_then_table() -> None:
    tables = [
        {"schema": "sales", "table": "orders"},
        {"schema": "public", "table": "customers"},
    ]
    indexes = [{"schema": "public", "table": "customers", "payload": {"name": "customers_pkey"}}]

    result = assemble_database_graph(tables, indexes, [], [])

    assert [s["schema"] for s in result] == ["public", "sales"]
    assert result[0] == {
        "schema": "public",
        "tables": [{"name": "customers", "structure": {"indexes": [{"name": "customers_pkey"}], "constraints": [], "foreignKeys": []}}],
    }
    assert result[1] == {
        "schema": "sales",
        "tables": [{"name": "orders", "structure": {"indexes": [], "constraints": [], "foreignKeys": []}}],
    }


def test_assemble_database_graph_emits_no_columns_key() -> None:
    tables = [{"schema": "public", "table": "customers"}]

    result = assemble_database_graph(tables, [], [], [])

    assert "columns" not in result[0]["tables"][0]


def test_assemble_database_graph_includes_schema_with_zero_foreign_keys() -> None:
    tables = [{"schema": "public", "table": "customers"}]

    result = assemble_database_graph(tables, [], [], [])

    assert result == [{"schema": "public", "tables": [{"name": "customers", "structure": {"indexes": [], "constraints": [], "foreignKeys": []}}]}]


# --- flatten_schema_indexes -------------------------------------------------

def test_flatten_schema_indexes_flattens_schema_table_payload_rows() -> None:
    rows = [
        {
            "schema": "public", "table": "customers",
            "payload": {
                "name": "customers_pkey",
                "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)",
                "unique": True, "primary": True,
            },
        },
    ]

    assert flatten_schema_indexes(rows) == [
        {
            "name": "customers_pkey",
            "definition": "CREATE UNIQUE INDEX customers_pkey ON public.customers USING btree (id)",
            "unique": True, "primary": True,
            "table": "customers",
        },
    ]


def test_flatten_schema_indexes_preserves_input_order() -> None:
    rows = [
        {"schema": "public", "table": "orders", "payload": {"name": "orders_pkey", "definition": "d1", "unique": True, "primary": True}},
        {"schema": "public", "table": "customers", "payload": {"name": "customers_pkey", "definition": "d2", "unique": True, "primary": True}},
    ]

    result = flatten_schema_indexes(rows)

    assert [r["name"] for r in result] == ["orders_pkey", "customers_pkey"]


def test_flatten_schema_indexes_empty() -> None:
    assert flatten_schema_indexes([]) == []


def test_assemble_database_graph_keeps_same_named_tables_in_different_schemas_distinct() -> None:
    tables = [{"schema": "public", "table": "items"}, {"schema": "sales", "table": "items"}]
    foreign_keys = [{"schema": "sales", "table": "items", "payload": {"name": "items_customer_id_fkey"}}]

    result = assemble_database_graph(tables, [], [], foreign_keys)

    public_items = next(t for t in next(s for s in result if s["schema"] == "public")["tables"] if t["name"] == "items")
    sales_items = next(t for t in next(s for s in result if s["schema"] == "sales")["tables"] if t["name"] == "items")

    assert public_items["structure"]["foreignKeys"] == []
    assert sales_items["structure"]["foreignKeys"] == [{"name": "items_customer_id_fkey"}]
