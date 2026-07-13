"""
Pure view/matview-DDL SQL-builder tests: CREATE/DROP/RENAME VIEW and
MATERIALIZED VIEW, REFRESH MATERIALIZED VIEW, and the DROP+CREATE matview
replace pair. Mirrors the pure-function style of test_ddl_table_sql.py — no
database.
"""

from __future__ import annotations

from app.sql import ddl


# --- create_view --------------------------------------------------------------


def test_create_view_basic() -> None:
    sql = ddl.create_view("public", "active", "SELECT id FROM c WHERE ok")

    assert sql == 'CREATE VIEW "public"."active" AS\nSELECT id FROM c WHERE ok'


def test_create_view_or_replace() -> None:
    sql = ddl.create_view("public", "active", "SELECT id FROM c WHERE ok", or_replace=True)

    assert sql == 'CREATE OR REPLACE VIEW "public"."active" AS\nSELECT id FROM c WHERE ok'


def test_create_view_with_column_aliases() -> None:
    sql = ddl.create_view("public", "v", "SELECT 1, 2", columns=["a", "b"])

    assert sql == 'CREATE VIEW "public"."v" ("a", "b") AS\nSELECT 1, 2'


def test_create_view_no_columns_omits_clause() -> None:
    sql = ddl.create_view("public", "v", "SELECT 1", columns=[])

    assert sql == 'CREATE VIEW "public"."v" AS\nSELECT 1'


def test_create_view_quotes_schema_with_embedded_quote() -> None:
    sql = ddl.create_view('s"x', "t", "SELECT 1")

    assert sql == 'CREATE VIEW "s""x"."t" AS\nSELECT 1'


# --- drop_view -----------------------------------------------------------------


def test_drop_view_basic() -> None:
    assert ddl.drop_view("public", "v") == 'DROP VIEW "public"."v"'


def test_drop_view_cascade() -> None:
    assert ddl.drop_view("public", "v", cascade=True) == 'DROP VIEW "public"."v" CASCADE'


# --- rename_view ---------------------------------------------------------------


def test_rename_view() -> None:
    assert ddl.rename_view("public", "v", "v2") == 'ALTER VIEW "public"."v" RENAME TO "v2"'


# --- create_materialized_view --------------------------------------------------


def test_create_materialized_view_with_no_data() -> None:
    sql = ddl.create_materialized_view("public", "mv", "SELECT 1", with_data=False)

    assert sql == 'CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH NO DATA'


def test_create_materialized_view_defaults_with_data() -> None:
    sql = ddl.create_materialized_view("public", "mv", "SELECT 1")

    assert sql == 'CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH DATA'


# --- drop_materialized_view ----------------------------------------------------


def test_drop_materialized_view_cascade() -> None:
    sql = ddl.drop_materialized_view("public", "mv", cascade=True)

    assert sql == 'DROP MATERIALIZED VIEW "public"."mv" CASCADE'


def test_drop_materialized_view_basic() -> None:
    assert ddl.drop_materialized_view("public", "mv") == 'DROP MATERIALIZED VIEW "public"."mv"'


# --- rename_materialized_view ---------------------------------------------------


def test_rename_materialized_view() -> None:
    sql = ddl.rename_materialized_view("public", "mv", "mv2")

    assert sql == 'ALTER MATERIALIZED VIEW "public"."mv" RENAME TO "mv2"'


# --- refresh_materialized_view -------------------------------------------------


def test_refresh_materialized_view_concurrently() -> None:
    sql = ddl.refresh_materialized_view("public", "mv", concurrently=True)

    assert sql == 'REFRESH MATERIALIZED VIEW CONCURRENTLY "public"."mv"'


def test_refresh_materialized_view_with_no_data() -> None:
    sql = ddl.refresh_materialized_view("public", "mv", with_no_data=True)

    assert sql == 'REFRESH MATERIALIZED VIEW "public"."mv" WITH NO DATA'


def test_refresh_materialized_view_plain() -> None:
    assert ddl.refresh_materialized_view("public", "mv") == 'REFRESH MATERIALIZED VIEW "public"."mv"'


def test_refresh_materialized_view_allows_both_flags() -> None:
    # Postgres itself rejects CONCURRENTLY + WITH NO DATA; the builder does not
    # guard the combination (the form disables it client-side, and Postgres is
    # authoritative — see plans/implemented/view-matview-ddl.md's "Potential
    # Challenges"). Pinning this shows the builder stays a pure pass-through.
    sql = ddl.refresh_materialized_view("public", "mv", concurrently=True, with_no_data=True)

    assert sql == 'REFRESH MATERIALIZED VIEW CONCURRENTLY "public"."mv" WITH NO DATA'


# --- replace_materialized_view -------------------------------------------------


def test_replace_materialized_view_basic() -> None:
    sql = ddl.replace_materialized_view("public", "mv", "SELECT 1")

    assert sql == (
        'DROP MATERIALIZED VIEW "public"."mv";\n'
        'CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH DATA'
    )


def test_replace_materialized_view_cascade_and_no_data() -> None:
    sql = ddl.replace_materialized_view("public", "mv", "SELECT 1", cascade=True, with_data=False)

    assert sql == (
        'DROP MATERIALIZED VIEW "public"."mv" CASCADE;\n'
        'CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH NO DATA'
    )
