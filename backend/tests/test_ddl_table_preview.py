"""
Table-DDL preview operations: construction validation and build() dispatch,
following the NO_CONN pure-logic style (see conftest.py, test_execute_ddl.py).
Each op is exercised with build() directly — the default apply() (inherited
from DdlPreview) just calls build(), already covered by test_execute_ddl.py.
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.operations import (
    PreviewAlterTable,
    PreviewConstraint,
    PreviewCreateTable,
    PreviewDropTable,
    PreviewIndex,
)
from tests.conftest import NO_CONN


# --- PreviewCreateTable -------------------------------------------------------


def test_create_table_build() -> None:
    spec = {
        "schema": "public",
        "name": "t",
        "columns": [
            {"name": "id", "type": "bigint", "nullable": False, "default": None, "primaryKey": True},
        ],
    }
    op = PreviewCreateTable(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": (
        'CREATE TABLE "public"."t" (\n    "id" bigint NOT NULL,\n    PRIMARY KEY ("id")\n)'
    )}


def test_create_table_if_not_exists() -> None:
    spec = {
        "schema": "public",
        "name": "t",
        "columns": [{"name": "a", "type": "int", "nullable": True, "default": None, "primaryKey": False}],
        "ifNotExists": True,
    }
    op = PreviewCreateTable(NO_CONN, spec)
    op.build()

    assert op.get_result()["sql"].startswith("CREATE TABLE IF NOT EXISTS ")


def test_create_table_blank_schema_raises() -> None:
    spec = {"schema": "", "name": "t", "columns": [{"name": "a", "type": "int"}]}

    with pytest.raises(ValidationError):
        PreviewCreateTable(NO_CONN, spec)


def test_create_table_blank_name_raises() -> None:
    spec = {"schema": "public", "name": "", "columns": [{"name": "a", "type": "int"}]}

    with pytest.raises(ValidationError):
        PreviewCreateTable(NO_CONN, spec)


# --- PreviewDropTable ----------------------------------------------------------


def test_drop_table_build() -> None:
    op = PreviewDropTable(NO_CONN, {"schema": "public", "name": "t", "cascade": True, "ifExists": True})
    op.build()

    assert op.get_result() == {"sql": 'DROP TABLE IF EXISTS "public"."t" CASCADE'}


def test_drop_table_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        PreviewDropTable(NO_CONN, {"schema": "public", "name": ""})


# --- PreviewAlterTable -----------------------------------------------------------


def test_alter_table_add_column() -> None:
    spec = {
        "schema": "public", "name": "t", "action": "addColumn",
        "columnDef": {"name": "note", "type": "text", "nullable": True, "default": None, "primaryKey": False},
    }
    op = PreviewAlterTable(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" ADD COLUMN "note" text'}


def test_alter_table_drop_column() -> None:
    op = PreviewAlterTable(NO_CONN, {"schema": "public", "name": "t", "action": "dropColumn", "column": "note"})
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" DROP COLUMN "note"'}


def test_alter_table_rename_column() -> None:
    spec = {"schema": "public", "name": "t", "action": "renameColumn", "column": "note", "newName": "memo"}
    op = PreviewAlterTable(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" RENAME COLUMN "note" TO "memo"'}


def test_alter_table_change_type() -> None:
    spec = {
        "schema": "public", "name": "t", "action": "changeType",
        "column": "amt", "newType": "numeric(10,2)", "using": "amt::numeric(10,2)",
    }
    op = PreviewAlterTable(NO_CONN, spec)
    op.build()

    assert op.get_result() == {
        "sql": 'ALTER TABLE "public"."t" ALTER COLUMN "amt" TYPE numeric(10,2) USING amt::numeric(10,2)'
    }


def test_alter_table_set_not_null() -> None:
    op = PreviewAlterTable(NO_CONN, {"schema": "public", "name": "t", "action": "setNotNull", "column": "amt"})
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" ALTER COLUMN "amt" SET NOT NULL'}


def test_alter_table_drop_not_null() -> None:
    op = PreviewAlterTable(NO_CONN, {"schema": "public", "name": "t", "action": "dropNotNull", "column": "amt"})
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" ALTER COLUMN "amt" DROP NOT NULL'}


def test_alter_table_set_default() -> None:
    spec = {"schema": "public", "name": "t", "action": "setDefault", "column": "created", "default": "now()"}
    op = PreviewAlterTable(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" ALTER COLUMN "created" SET DEFAULT now()'}


def test_alter_table_drop_default() -> None:
    spec = {"schema": "public", "name": "t", "action": "dropDefault", "column": "created"}
    op = PreviewAlterTable(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" ALTER COLUMN "created" DROP DEFAULT'}


def test_alter_table_rename_table() -> None:
    op = PreviewAlterTable(NO_CONN, {"schema": "public", "name": "t", "action": "renameTable", "newName": "t2"})
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" RENAME TO "t2"'}


def test_alter_table_unknown_action_raises() -> None:
    op = PreviewAlterTable(NO_CONN, {"schema": "public", "name": "t", "action": "frobnicate"})

    with pytest.raises(ValidationError):
        op.build()


def test_alter_table_blank_schema_raises() -> None:
    with pytest.raises(ValidationError):
        PreviewAlterTable(NO_CONN, {"schema": "", "name": "t", "action": "renameTable", "newName": "t2"})


# --- PreviewConstraint -----------------------------------------------------------


def test_constraint_add_primary_key() -> None:
    spec = {"schema": "public", "name": "t", "action": "addPrimaryKey", "columns": ["id"]}
    op = PreviewConstraint(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" ADD PRIMARY KEY ("id")'}


def test_constraint_add_unique() -> None:
    spec = {
        "schema": "public", "name": "t", "action": "addUnique",
        "columns": ["email"], "constraintName": "t_email_key",
    }
    op = PreviewConstraint(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" ADD CONSTRAINT "t_email_key" UNIQUE ("email")'}


def test_constraint_add_check() -> None:
    spec = {
        "schema": "public", "name": "t", "action": "addCheck",
        "expression": "balance >= 0", "constraintName": "t_bal_chk",
    }
    op = PreviewConstraint(NO_CONN, spec)
    op.build()

    assert op.get_result() == {
        "sql": 'ALTER TABLE "public"."t" ADD CONSTRAINT "t_bal_chk" CHECK (balance >= 0)'
    }


def test_constraint_add_foreign_key() -> None:
    spec = {
        "schema": "sales", "name": "order", "action": "addForeignKey",
        "columns": ["customer_id"], "refSchema": "public", "refTable": "customers",
        "refColumns": ["id"], "onDelete": "CASCADE",
    }
    op = PreviewConstraint(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": (
        'ALTER TABLE "sales"."order" ADD FOREIGN KEY ("customer_id") '
        'REFERENCES "public"."customers" ("id") ON DELETE CASCADE'
    )}


def test_constraint_drop() -> None:
    spec = {"schema": "public", "name": "t", "action": "drop", "constraintName": "t_email_key"}
    op = PreviewConstraint(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TABLE "public"."t" DROP CONSTRAINT "t_email_key"'}


def test_constraint_unknown_action_raises() -> None:
    op = PreviewConstraint(NO_CONN, {"schema": "public", "name": "t", "action": "levitate"})

    with pytest.raises(ValidationError):
        op.build()


def test_constraint_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        PreviewConstraint(NO_CONN, {"schema": "public", "name": "", "action": "drop", "constraintName": "x"})


# --- PreviewIndex -----------------------------------------------------------------


def test_index_create() -> None:
    spec = {
        "schema": "public", "action": "create", "table": "t",
        "columns": ["email"], "name": "t_email_idx", "unique": True,
    }
    op = PreviewIndex(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'CREATE UNIQUE INDEX "t_email_idx" ON "public"."t" ("email")'}


def test_index_drop() -> None:
    spec = {"schema": "public", "action": "drop", "indexName": "t_email_idx", "cascade": True}
    op = PreviewIndex(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'DROP INDEX "public"."t_email_idx" CASCADE'}


def test_index_unknown_action_raises() -> None:
    op = PreviewIndex(NO_CONN, {"schema": "public", "action": "levitate"})

    with pytest.raises(ValidationError):
        op.build()


def test_index_blank_schema_raises() -> None:
    with pytest.raises(ValidationError):
        PreviewIndex(NO_CONN, {"schema": "", "action": "drop", "indexName": "idx"})


# --- Missing action-specific fields raise ValidationError (not KeyError) -------
#
# build() reads each action's required fields through the _require/_field
# guards, so a body missing a field the chosen action needs raises the app's
# typed ValidationError (mapped to a 400) rather than an unhandled KeyError
# (which would surface as a 500).


def test_alter_table_missing_column_raises() -> None:
    op = PreviewAlterTable(NO_CONN, {"schema": "public", "name": "t", "action": "dropColumn"})

    with pytest.raises(ValidationError):
        op.build()


def test_alter_table_missing_column_def_raises() -> None:
    op = PreviewAlterTable(NO_CONN, {"schema": "public", "name": "t", "action": "addColumn"})

    with pytest.raises(ValidationError):
        op.build()


def test_constraint_missing_columns_raises() -> None:
    op = PreviewConstraint(NO_CONN, {"schema": "public", "name": "t", "action": "addPrimaryKey"})

    with pytest.raises(ValidationError):
        op.build()


def test_constraint_drop_missing_name_raises() -> None:
    op = PreviewConstraint(NO_CONN, {"schema": "public", "name": "t", "action": "drop"})

    with pytest.raises(ValidationError):
        op.build()


def test_index_create_missing_table_raises() -> None:
    op = PreviewIndex(NO_CONN, {"schema": "public", "action": "create", "columns": ["a"]})

    with pytest.raises(ValidationError):
        op.build()


def test_index_drop_missing_name_raises() -> None:
    op = PreviewIndex(NO_CONN, {"schema": "public", "action": "drop"})

    with pytest.raises(ValidationError):
        op.build()
