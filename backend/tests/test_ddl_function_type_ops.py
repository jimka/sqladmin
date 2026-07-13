"""
Function/type-DDL preview operations: construction validation and build()
dispatch, following the NO_CONN pure-logic style (see conftest.py,
test_ddl_schema_sequence_ops.py). Each op is exercised with build() directly —
the default apply() (inherited from DdlPreview) just calls build().
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.operations import (
    AlterTypeAddValuePreview,
    CreateCompositeTypePreview,
    CreateEnumTypePreview,
    CreateFunctionPreview,
    DropFunctionPreview,
    DropTypePreview,
)
from tests.conftest import NO_CONN

# --- CreateFunctionPreview ---------------------------------------------------


def test_create_function_build() -> None:
    spec = {
        "schema": "public", "name": "add", "kind": "function",
        "args": [
            {"type": "integer", "name": "a", "mode": "IN"},
            {"type": "integer", "name": "b", "mode": "IN"},
        ],
        "language": "plpgsql", "body": "BEGIN\n  RETURN a + b;\nEND;",
        "returns": "integer", "volatility": "IMMUTABLE", "replace": False,
    }
    op = CreateFunctionPreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": (
        'CREATE FUNCTION "public"."add"(IN "a" integer, IN "b" integer)\n'
        "RETURNS integer\n"
        " LANGUAGE plpgsql\n"
        "IMMUTABLE\n"
        "AS $function$\n"
        "BEGIN\n"
        "  RETURN a + b;\n"
        "END;\n"
        "$function$"
    )}


def test_create_function_procedure_kind() -> None:
    spec = {
        "schema": "public", "name": "log_action", "kind": "procedure",
        "args": [{"type": "text", "name": "msg"}],
        "language": "plpgsql", "body": "BEGIN\n  NULL;\nEND;",
    }
    op = CreateFunctionPreview(NO_CONN, spec)
    op.build()

    assert op.get_result()["sql"].startswith('CREATE PROCEDURE "public"."log_action"')


def test_create_function_blank_schema_raises() -> None:
    with pytest.raises(ValidationError):
        CreateFunctionPreview(NO_CONN, {"schema": "", "name": "add", "kind": "function", "language": "sql", "body": "SELECT 1"})


def test_create_function_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        CreateFunctionPreview(NO_CONN, {"schema": "public", "name": "", "kind": "function", "language": "sql", "body": "SELECT 1"})


def test_create_function_get_result_before_build_raises() -> None:
    op = CreateFunctionPreview(NO_CONN, {"schema": "public", "name": "add", "kind": "function", "language": "sql", "body": "SELECT 1"})

    with pytest.raises(RuntimeError):
        op.get_result()


# --- DropFunctionPreview ------------------------------------------------------


def test_drop_function_build() -> None:
    spec = {"schema": "public", "name": "add", "kind": "function", "signature": "integer, integer", "cascade": True}
    op = DropFunctionPreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'DROP FUNCTION "public"."add"(integer, integer) CASCADE'}


def test_drop_function_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        DropFunctionPreview(NO_CONN, {"schema": "public", "name": "", "kind": "function", "signature": ""})


# --- CreateEnumTypePreview -----------------------------------------------------


def test_create_enum_type_build() -> None:
    op = CreateEnumTypePreview(NO_CONN, {"schema": "public", "name": "mood", "labels": ["sad", "ok", "happy"]})
    op.build()

    assert op.get_result() == {"sql": 'CREATE TYPE "public"."mood" AS ENUM (\'sad\', \'ok\', \'happy\')'}


def test_create_enum_type_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        CreateEnumTypePreview(NO_CONN, {"schema": "public", "name": "", "labels": ["sad"]})


# --- CreateCompositeTypePreview ------------------------------------------------


def test_create_composite_type_build() -> None:
    spec = {"schema": "public", "name": "addr", "attributes": [{"name": "street", "type": "text"}, {"name": "zip", "type": "varchar(10)"}]}
    op = CreateCompositeTypePreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": (
        'CREATE TYPE "public"."addr" AS (\n'
        '    "street" text,\n'
        '    "zip" varchar(10)\n'
        ")"
    )}


def test_create_composite_type_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        CreateCompositeTypePreview(NO_CONN, {"schema": "public", "name": "", "attributes": []})


# --- DropTypePreview ------------------------------------------------------------


def test_drop_type_build() -> None:
    op = DropTypePreview(NO_CONN, {"schema": "public", "name": "mood", "cascade": True, "ifExists": True})
    op.build()

    assert op.get_result() == {"sql": 'DROP TYPE IF EXISTS "public"."mood" CASCADE'}


def test_drop_type_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        DropTypePreview(NO_CONN, {"schema": "public", "name": ""})


# --- AlterTypeAddValuePreview ---------------------------------------------------


def test_alter_type_add_value_build() -> None:
    spec = {"schema": "public", "name": "mood", "value": "great", "position": {"placement": "after", "label": "happy"}}
    op = AlterTypeAddValuePreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TYPE "public"."mood" ADD VALUE \'great\' AFTER \'happy\''}


def test_alter_type_add_value_no_position_build() -> None:
    op = AlterTypeAddValuePreview(NO_CONN, {"schema": "public", "name": "mood", "value": "great"})
    op.build()

    assert op.get_result() == {"sql": 'ALTER TYPE "public"."mood" ADD VALUE \'great\''}


def test_alter_type_add_value_blank_value_raises() -> None:
    with pytest.raises(ValidationError):
        AlterTypeAddValuePreview(NO_CONN, {"schema": "public", "name": "mood", "value": ""})


def test_alter_type_add_value_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        AlterTypeAddValuePreview(NO_CONN, {"schema": "public", "name": "", "value": "great"})
