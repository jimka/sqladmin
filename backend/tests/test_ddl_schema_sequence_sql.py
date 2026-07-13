"""
Pure schema/sequence-DDL SQL-builder tests: CREATE/DROP/RENAME SCHEMA, and
CREATE/ALTER/OWNER/DROP SEQUENCE. Mirrors the pure-function style of
test_view_matview_ddl_sql.py — no database.
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.sql import ddl

# --- schema_create --------------------------------------------------------------


def test_schema_create_basic() -> None:
    assert ddl.schema_create("analytics") == 'CREATE SCHEMA "analytics"'


def test_schema_create_with_authorization() -> None:
    sql = ddl.schema_create("analytics", authorization="app_owner")

    assert sql == 'CREATE SCHEMA "analytics" AUTHORIZATION "app_owner"'


def test_schema_create_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.schema_create("")


# --- schema_drop -----------------------------------------------------------------


def test_schema_drop_basic() -> None:
    assert ddl.schema_drop("analytics") == 'DROP SCHEMA "analytics"'


def test_schema_drop_cascade_and_if_exists() -> None:
    sql = ddl.schema_drop("analytics", cascade=True, if_exists=True)

    assert sql == 'DROP SCHEMA IF EXISTS "analytics" CASCADE'


def test_schema_drop_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.schema_drop("")


# --- schema_rename ---------------------------------------------------------------


def test_schema_rename_basic() -> None:
    sql = ddl.schema_rename("analytics", "reporting")

    assert sql == 'ALTER SCHEMA "analytics" RENAME TO "reporting"'


def test_schema_rename_quotes_embedded_quote() -> None:
    sql = ddl.schema_rename('a"b', "c")

    assert sql == 'ALTER SCHEMA "a""b" RENAME TO "c"'


def test_schema_rename_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.schema_rename("", "c")


def test_schema_rename_blank_new_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.schema_rename("analytics", "")


# --- sequence_create ---------------------------------------------------------------


def test_sequence_create_no_options() -> None:
    assert ddl.sequence_create("public", "s") == 'CREATE SEQUENCE "public"."s"'


def test_sequence_create_with_options() -> None:
    sql = ddl.sequence_create(
        "public", "order_id_seq",
        increment=1, start=1000, min_value=1, max_value=9999999, cache=1, cycle=False,
    )

    assert sql == (
        'CREATE SEQUENCE "public"."order_id_seq" '
        "INCREMENT BY 1 MINVALUE 1 MAXVALUE 9999999 START WITH 1000 CACHE 1"
    )


def test_sequence_create_cycle_true() -> None:
    sql = ddl.sequence_create("public", "order_id_seq", cycle=True)

    assert sql == 'CREATE SEQUENCE "public"."order_id_seq" CYCLE'


def test_sequence_create_owned_by() -> None:
    sql = ddl.sequence_create("public", "order_id_seq", owned_by=("public", "orders", "id"))

    assert sql == 'CREATE SEQUENCE "public"."order_id_seq" OWNED BY "public"."orders"."id"'


def test_sequence_create_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.sequence_create("public", "")


# --- sequence_alter ---------------------------------------------------------------


def test_sequence_alter_restart_default() -> None:
    sql = ddl.sequence_alter("public", "order_id_seq", restart=ddl.RESTART_DEFAULT)

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" RESTART'


def test_sequence_alter_restart_with_value() -> None:
    sql = ddl.sequence_alter("public", "order_id_seq", restart=1)

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" RESTART WITH 1'


def test_sequence_alter_increment() -> None:
    sql = ddl.sequence_alter("public", "order_id_seq", increment=2)

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" INCREMENT BY 2'


def test_sequence_alter_cycle_false_emits_no_cycle() -> None:
    sql = ddl.sequence_alter("public", "order_id_seq", cycle=False)

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" NO CYCLE'


def test_sequence_alter_cycle_true_emits_cycle() -> None:
    sql = ddl.sequence_alter("public", "order_id_seq", cycle=True)

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" CYCLE'


def test_sequence_alter_multiple_options() -> None:
    sql = ddl.sequence_alter("public", "order_id_seq", min_value=1, max_value=100, cache=5)

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" MINVALUE 1 MAXVALUE 100 CACHE 5'


def test_sequence_alter_no_options_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.sequence_alter("public", "order_id_seq")


def test_sequence_alter_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.sequence_alter("public", "", increment=1)


def test_sequence_alter_data_type() -> None:
    sql = ddl.sequence_alter("public", "order_id_seq", data_type="bigint")

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" AS bigint'


def test_sequence_alter_start() -> None:
    sql = ddl.sequence_alter("public", "order_id_seq", start=1000)

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" START WITH 1000'


def test_sequence_alter_canonical_order_combined() -> None:
    sql = ddl.sequence_alter(
        "public", "order_id_seq", data_type="integer", increment=2, start=5, restart=9,
    )

    assert sql == (
        'ALTER SEQUENCE "public"."order_id_seq" '
        "AS integer INCREMENT BY 2 START WITH 5 RESTART WITH 9"
    )


def test_sequence_alter_unsupported_data_type_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.sequence_alter("public", "order_id_seq", data_type="nope")


def test_sequence_alter_data_type_alias_int8() -> None:
    sql = ddl.sequence_alter("public", "order_id_seq", data_type="int8")

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" AS int8'


# --- sequence_set_owner ---------------------------------------------------------------


def test_sequence_set_owner() -> None:
    sql = ddl.sequence_set_owner("public", "order_id_seq", "app_owner")

    assert sql == 'ALTER SEQUENCE "public"."order_id_seq" OWNER TO "app_owner"'


def test_sequence_set_owner_blank_owner_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.sequence_set_owner("public", "order_id_seq", "")


# --- sequence_drop ---------------------------------------------------------------


def test_sequence_drop_basic() -> None:
    assert ddl.sequence_drop("public", "order_id_seq") == 'DROP SEQUENCE "public"."order_id_seq"'


def test_sequence_drop_cascade_and_if_exists() -> None:
    sql = ddl.sequence_drop("public", "order_id_seq", cascade=True, if_exists=True)

    assert sql == 'DROP SEQUENCE IF EXISTS "public"."order_id_seq" CASCADE'


def test_sequence_drop_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.sequence_drop("public", "")
