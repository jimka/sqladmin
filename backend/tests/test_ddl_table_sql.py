"""
Pure table-DDL SQL-builder tests: CREATE/DROP/RENAME TABLE, ALTER-column
operations, constraint add/drop, and index create/drop. Mirrors the
pure-function style of test_ddl_sql.py — no database.
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.sql import ddl


# --- create_table ------------------------------------------------------------


def test_create_table_basic() -> None:
    columns = [
        {"name": "id", "type": "bigint", "nullable": False, "default": None, "primary_key": True},
        {"name": "email", "type": "text", "nullable": False, "default": None, "primary_key": False},
        {"name": "created", "type": "timestamptz", "nullable": True, "default": "now()", "primary_key": False},
    ]

    sql = ddl.create_table("public", "t", columns)

    assert sql == (
        'CREATE TABLE "public"."t" (\n'
        '    "id" bigint NOT NULL,\n'
        '    "email" text NOT NULL,\n'
        '    "created" timestamptz DEFAULT now(),\n'
        '    PRIMARY KEY ("id")\n'
        ")"
    )


def test_create_table_composite_primary_key() -> None:
    columns = [
        {"name": "a", "type": "int", "nullable": False, "default": None, "primary_key": True},
        {"name": "b", "type": "int", "nullable": False, "default": None, "primary_key": True},
    ]

    sql = ddl.create_table("public", "t", columns)

    assert 'PRIMARY KEY ("a", "b")' in sql


def test_create_table_no_primary_key() -> None:
    columns = [{"name": "a", "type": "int", "nullable": True, "default": None, "primary_key": False}]

    sql = ddl.create_table("public", "t", columns)

    assert "PRIMARY KEY" not in sql


def test_create_table_if_not_exists() -> None:
    columns = [{"name": "a", "type": "int", "nullable": True, "default": None, "primary_key": False}]

    sql = ddl.create_table("public", "t", columns, if_not_exists=True)

    assert sql.startswith("CREATE TABLE IF NOT EXISTS ")


def test_create_table_quotes_embedded_quote_in_name() -> None:
    columns = [{"name": "a", "type": "int", "nullable": True, "default": None, "primary_key": False}]

    sql = ddl.create_table('s"x', "t", columns)

    assert sql.startswith('CREATE TABLE "s""x"."t" (')


def test_create_table_empty_columns_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.create_table("public", "t", [])


# --- drop_table / rename_table -----------------------------------------------


def test_drop_table_basic() -> None:
    assert ddl.drop_table("public", "t") == 'DROP TABLE "public"."t"'


def test_drop_table_if_exists_cascade() -> None:
    sql = ddl.drop_table("public", "t", cascade=True, if_exists=True)

    assert sql == 'DROP TABLE IF EXISTS "public"."t" CASCADE'


def test_rename_table_basic() -> None:
    sql = ddl.rename_table("public", "t", "t2")

    assert sql == 'ALTER TABLE "public"."t" RENAME TO "t2"'


# --- add_column / drop_column / rename_column --------------------------------


def test_add_column_nullable_no_default() -> None:
    col = {"name": "note", "type": "text", "nullable": True, "default": None, "primary_key": False}

    sql = ddl.add_column("public", "t", col)

    assert sql == 'ALTER TABLE "public"."t" ADD COLUMN "note" text'


def test_add_column_not_null_with_default() -> None:
    col = {"name": "note", "type": "text", "nullable": False, "default": "''", "primary_key": False}

    sql = ddl.add_column("public", "t", col)

    assert sql == '''ALTER TABLE "public"."t" ADD COLUMN "note" text NOT NULL DEFAULT \'\''''


def test_drop_column_basic() -> None:
    assert ddl.drop_column("public", "t", "note") == 'ALTER TABLE "public"."t" DROP COLUMN "note"'


def test_drop_column_cascade() -> None:
    sql = ddl.drop_column("public", "t", "note", cascade=True)

    assert sql == 'ALTER TABLE "public"."t" DROP COLUMN "note" CASCADE'


def test_rename_column_basic() -> None:
    sql = ddl.rename_column("public", "t", "note", "memo")

    assert sql == 'ALTER TABLE "public"."t" RENAME COLUMN "note" TO "memo"'


# --- alter_column_type / set_not_null / drop_not_null / set_default / drop_default


def test_alter_column_type_no_using() -> None:
    sql = ddl.alter_column_type("public", "t", "amt", "numeric(10,2)")

    assert sql == 'ALTER TABLE "public"."t" ALTER COLUMN "amt" TYPE numeric(10,2)'


def test_alter_column_type_with_using() -> None:
    sql = ddl.alter_column_type("public", "t", "amt", "numeric(10,2)", using="amt::numeric(10,2)")

    assert sql == 'ALTER TABLE "public"."t" ALTER COLUMN "amt" TYPE numeric(10,2) USING amt::numeric(10,2)'


def test_set_not_null() -> None:
    assert ddl.set_not_null("public", "t", "amt") == 'ALTER TABLE "public"."t" ALTER COLUMN "amt" SET NOT NULL'


def test_drop_not_null() -> None:
    assert ddl.drop_not_null("public", "t", "amt") == 'ALTER TABLE "public"."t" ALTER COLUMN "amt" DROP NOT NULL'


def test_set_default() -> None:
    sql = ddl.set_default("public", "t", "created", "now()")

    assert sql == 'ALTER TABLE "public"."t" ALTER COLUMN "created" SET DEFAULT now()'


def test_drop_default() -> None:
    sql = ddl.drop_default("public", "t", "created")

    assert sql == 'ALTER TABLE "public"."t" ALTER COLUMN "created" DROP DEFAULT'


# --- constraints --------------------------------------------------------------


def test_add_primary_key_unnamed() -> None:
    sql = ddl.add_primary_key("public", "t", ["id"])

    assert sql == 'ALTER TABLE "public"."t" ADD PRIMARY KEY ("id")'


def test_add_primary_key_named() -> None:
    sql = ddl.add_primary_key("public", "t", ["id"], constraint_name="t_pkey")

    assert sql == 'ALTER TABLE "public"."t" ADD CONSTRAINT "t_pkey" PRIMARY KEY ("id")'


def test_add_primary_key_empty_columns_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.add_primary_key("public", "t", [])


def test_add_unique_named() -> None:
    sql = ddl.add_unique("public", "t", ["email"], constraint_name="t_email_key")

    assert sql == 'ALTER TABLE "public"."t" ADD CONSTRAINT "t_email_key" UNIQUE ("email")'


def test_add_unique_empty_columns_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.add_unique("public", "t", [])


def test_add_check_named() -> None:
    sql = ddl.add_check("public", "t", "balance >= 0", constraint_name="t_bal_chk")

    assert sql == 'ALTER TABLE "public"."t" ADD CONSTRAINT "t_bal_chk" CHECK (balance >= 0)'


def test_add_check_blank_expression_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.add_check("public", "t", "   ")


def test_add_foreign_key_cross_schema() -> None:
    sql = ddl.add_foreign_key(
        "sales", "order", ["customer_id"], "public", "customers", ["id"], on_delete="CASCADE",
    )

    assert sql == (
        'ALTER TABLE "sales"."order" ADD FOREIGN KEY ("customer_id") '
        'REFERENCES "public"."customers" ("id") ON DELETE CASCADE'
    )


def test_add_foreign_key_named_with_on_update() -> None:
    sql = ddl.add_foreign_key(
        "public", "t", ["a"], "public", "ref", ["id"],
        constraint_name="t_fk", on_update="SET NULL",
    )

    assert sql == (
        'ALTER TABLE "public"."t" ADD CONSTRAINT "t_fk" FOREIGN KEY ("a") '
        'REFERENCES "public"."ref" ("id") ON UPDATE SET NULL'
    )


def test_add_foreign_key_column_length_mismatch_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.add_foreign_key("public", "t", ["a", "b"], "public", "ref", ["id"])


def test_add_foreign_key_unknown_on_delete_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.add_foreign_key("public", "t", ["a"], "public", "ref", ["id"], on_delete="NUKE")


def test_add_foreign_key_empty_columns_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.add_foreign_key("public", "t", [], "public", "ref", [])


def test_drop_constraint_basic() -> None:
    sql = ddl.drop_constraint("public", "t", "t_email_key")

    assert sql == 'ALTER TABLE "public"."t" DROP CONSTRAINT "t_email_key"'


def test_drop_constraint_cascade() -> None:
    sql = ddl.drop_constraint("public", "t", "t_email_key", cascade=True)

    assert sql == 'ALTER TABLE "public"."t" DROP CONSTRAINT "t_email_key" CASCADE'


# --- indexes -------------------------------------------------------------------


def test_create_index_named_unique() -> None:
    sql = ddl.create_index("public", "t", ["email"], name="t_email_idx", unique=True)

    assert sql == 'CREATE UNIQUE INDEX "t_email_idx" ON "public"."t" ("email")'


def test_create_index_unnamed_with_method() -> None:
    sql = ddl.create_index("public", "t", ["a", "b"], method="btree")

    assert sql == 'CREATE INDEX ON "public"."t" USING btree ("a", "b")'


def test_create_index_if_not_exists() -> None:
    sql = ddl.create_index("public", "t", ["a"], name="idx", if_not_exists=True)

    assert sql == 'CREATE INDEX IF NOT EXISTS "idx" ON "public"."t" ("a")'


def test_create_index_unknown_method_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.create_index("public", "t", ["a"], method="rocket")


def test_create_index_empty_columns_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.create_index("public", "t", [])


def test_drop_index_basic() -> None:
    assert ddl.drop_index("public", "t_email_idx") == 'DROP INDEX "public"."t_email_idx"'


def test_drop_index_if_exists_cascade() -> None:
    sql = ddl.drop_index("public", "t_email_idx", if_exists=True, cascade=True)

    assert sql == 'DROP INDEX IF EXISTS "public"."t_email_idx" CASCADE'
