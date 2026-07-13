"""
Pure function/type-DDL SQL-builder tests: CREATE [OR REPLACE]
FUNCTION|PROCEDURE, DROP FUNCTION|PROCEDURE, CREATE TYPE (enum/composite),
DROP TYPE, ALTER TYPE ADD VALUE. Mirrors the pure-function style of
test_ddl_schema_sequence_sql.py — no database.
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.sql import ddl

# --- render_function_arg ----------------------------------------------------


def test_render_function_arg_full() -> None:
    arg = ddl.FunctionArg(type="numeric(10,2)", name="amt", mode="INOUT", default="0")

    assert ddl.render_function_arg(arg) == 'INOUT "amt" numeric(10,2) DEFAULT 0'


def test_render_function_arg_no_name() -> None:
    arg = ddl.FunctionArg(type="integer")

    assert ddl.render_function_arg(arg) == "integer"


def test_render_function_arg_variadic() -> None:
    arg = ddl.FunctionArg(type="integer[]", name="vals", mode="variadic")

    assert ddl.render_function_arg(arg) == 'VARIADIC "vals" integer[]'


def test_render_function_arg_unknown_mode_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.render_function_arg(ddl.FunctionArg(type="integer", mode="BOGUS"))


# --- create_routine (function) ----------------------------------------------


def test_create_routine_function_full() -> None:
    spec = ddl.CreateRoutineSpec(
        schema="public",
        name="add",
        kind="function",
        args=[
            ddl.FunctionArg(type="integer", name="a", mode="IN"),
            ddl.FunctionArg(type="integer", name="b", mode="IN"),
        ],
        language="plpgsql",
        body="BEGIN\n  RETURN a + b;\nEND;",
        returns="integer",
        volatility="IMMUTABLE",
        replace=False,
    )

    assert ddl.create_routine(spec) == (
        'CREATE FUNCTION "public"."add"(IN "a" integer, IN "b" integer)\n'
        "RETURNS integer\n"
        " LANGUAGE plpgsql\n"
        "IMMUTABLE\n"
        "AS $function$\n"
        "BEGIN\n"
        "  RETURN a + b;\n"
        "END;\n"
        "$function$"
    )


def test_create_routine_or_replace() -> None:
    spec = ddl.CreateRoutineSpec(
        schema="public", name="add", kind="function",
        args=[ddl.FunctionArg(type="integer", name="a"), ddl.FunctionArg(type="integer", name="b")],
        language="plpgsql", body="BEGIN\n  RETURN a + b;\nEND;",
        returns="integer", volatility="IMMUTABLE", replace=True,
    )

    assert ddl.create_routine(spec).startswith(
        'CREATE OR REPLACE FUNCTION "public"."add"("a" integer, "b" integer)'
    )


def test_create_routine_procedure_no_returns_or_volatility() -> None:
    spec = ddl.CreateRoutineSpec(
        schema="public", name="log_action", kind="procedure",
        args=[ddl.FunctionArg(type="text", name="msg")],
        language="plpgsql", body="BEGIN\n  RAISE NOTICE '%', msg;\nEND;",
    )

    assert ddl.create_routine(spec) == (
        'CREATE PROCEDURE "public"."log_action"("msg" text)\n'
        " LANGUAGE plpgsql\n"
        "AS $function$\n"
        "BEGIN\n"
        "  RAISE NOTICE '%', msg;\n"
        "END;\n"
        "$function$"
    )


def test_create_routine_dollar_tag_collision() -> None:
    spec = ddl.CreateRoutineSpec(
        schema="public", name="f", kind="function", args=[], language="sql",
        body="SELECT '$function$'", returns="text",
    )

    sql = ddl.create_routine(spec)

    assert "$func_1$" in sql
    assert "$function$SELECT '$function$'$function$" not in sql


def test_create_routine_blank_name_raises() -> None:
    spec = ddl.CreateRoutineSpec(schema="public", name="", kind="function", args=[], language="sql", body="SELECT 1")

    with pytest.raises(ValidationError):
        ddl.create_routine(spec)


# --- drop_routine -------------------------------------------------------------


def test_drop_routine_function_with_signature_and_cascade() -> None:
    sql = ddl.drop_routine("public", "add", "function", "integer, integer", cascade=True, if_exists=False)

    assert sql == 'DROP FUNCTION "public"."add"(integer, integer) CASCADE'


def test_drop_routine_if_exists() -> None:
    sql = ddl.drop_routine("public", "add", "function", "integer, integer", cascade=False, if_exists=True)

    assert sql == 'DROP FUNCTION IF EXISTS "public"."add"(integer, integer)'


def test_drop_routine_procedure() -> None:
    sql = ddl.drop_routine("public", "log_action", "procedure", "text", cascade=False, if_exists=False)

    assert sql == 'DROP PROCEDURE "public"."log_action"(text)'


def test_drop_routine_empty_signature() -> None:
    sql = ddl.drop_routine("public", "add", "function", "", cascade=False, if_exists=False)

    assert sql == 'DROP FUNCTION "public"."add"()'


def test_drop_routine_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.drop_routine("public", "", "function", "", cascade=False, if_exists=False)


# --- create_enum_type ---------------------------------------------------------


def test_create_enum_type_basic() -> None:
    sql = ddl.create_enum_type("public", "mood", ["sad", "ok", "happy"])

    assert sql == 'CREATE TYPE "public"."mood" AS ENUM (\'sad\', \'ok\', \'happy\')'


def test_create_enum_type_escapes_embedded_quote() -> None:
    sql = ddl.create_enum_type("public", "mood", ["o'k"])

    assert sql == 'CREATE TYPE "public"."mood" AS ENUM (\'o\'\'k\')'


def test_create_enum_type_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.create_enum_type("public", "", ["sad"])


# --- create_composite_type -----------------------------------------------------


def test_create_composite_type_basic() -> None:
    sql = ddl.create_composite_type(
        "public", "addr",
        [ddl.CompositeAttr(name="street", type="text"), ddl.CompositeAttr(name="zip", type="varchar(10)")],
    )

    assert sql == (
        'CREATE TYPE "public"."addr" AS (\n'
        '    "street" text,\n'
        '    "zip" varchar(10)\n'
        ")"
    )


def test_create_composite_type_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.create_composite_type("public", "", [ddl.CompositeAttr(name="a", type="text")])


# --- drop_type ------------------------------------------------------------------


def test_drop_type_basic() -> None:
    assert ddl.drop_type("public", "mood", cascade=False, if_exists=False) == 'DROP TYPE "public"."mood"'


def test_drop_type_cascade_and_if_exists() -> None:
    sql = ddl.drop_type("public", "mood", cascade=True, if_exists=True)

    assert sql == 'DROP TYPE IF EXISTS "public"."mood" CASCADE'


def test_drop_type_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.drop_type("public", "", cascade=False, if_exists=False)


# --- alter_type_add_value -------------------------------------------------------


def test_alter_type_add_value_no_position() -> None:
    sql = ddl.alter_type_add_value("public", "mood", "great", None)

    assert sql == 'ALTER TYPE "public"."mood" ADD VALUE \'great\''


def test_alter_type_add_value_after() -> None:
    sql = ddl.alter_type_add_value("public", "mood", "great", ("after", "happy"))

    assert sql == 'ALTER TYPE "public"."mood" ADD VALUE \'great\' AFTER \'happy\''


def test_alter_type_add_value_before() -> None:
    sql = ddl.alter_type_add_value("public", "mood", "great", ("before", "sad"))

    assert sql == 'ALTER TYPE "public"."mood" ADD VALUE \'great\' BEFORE \'sad\''


def test_alter_type_add_value_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.alter_type_add_value("public", "", "great", None)
