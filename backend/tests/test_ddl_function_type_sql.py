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


def test_create_routine_unknown_language_raises() -> None:
    spec = ddl.CreateRoutineSpec(
        schema="public", name="f", kind="function", args=[], language="python", body="return 1",
    )

    with pytest.raises(ValidationError):
        ddl.create_routine(spec)


def test_create_routine_unknown_volatility_raises() -> None:
    spec = ddl.CreateRoutineSpec(
        schema="public", name="f", kind="function", args=[], language="sql", body="SELECT 1", volatility="FAST",
    )

    with pytest.raises(ValidationError):
        ddl.create_routine(spec)


def test_create_routine_known_language_and_volatility_emit_todays_sql() -> None:
    spec = ddl.CreateRoutineSpec(
        schema="public", name="f", kind="function", args=[], language="plpgsql",
        body="BEGIN\n  RETURN 1;\nEND;", returns="integer", volatility="STABLE",
    )

    assert ddl.create_routine(spec) == (
        'CREATE FUNCTION "public"."f"()\n'
        "RETURNS integer\n"
        " LANGUAGE plpgsql\n"
        "STABLE\n"
        "AS $function$\n"
        "BEGIN\n"
        "  RETURN 1;\n"
        "END;\n"
        "$function$"
    )


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


def test_drop_routine_cascade_and_if_exists_are_keyword_only() -> None:
    # cascade/if_exists moved behind a `*` so a positional call fails loudly
    # rather than silently swapping the two flags. Deliberately ill-typed —
    # pyright catches this call statically, which is exactly the point.
    with pytest.raises(TypeError):
        ddl.drop_routine("public", "add", "function", "", True, False)  # type: ignore[misc]


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


# --- alter_type_add_attribute ----------------------------------------------


def test_alter_type_add_attribute() -> None:
    sql = ddl.alter_type_add_attribute("public", "addr", ddl.CompositeAttr("zip", "varchar(10)"))

    assert sql == 'ALTER TYPE "public"."addr" ADD ATTRIBUTE "zip" varchar(10)'


def test_alter_type_add_attribute_blank_schema_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.alter_type_add_attribute("", "addr", ddl.CompositeAttr("zip", "varchar(10)"))


def test_alter_type_add_attribute_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.alter_type_add_attribute("public", "", ddl.CompositeAttr("zip", "varchar(10)"))


# --- alter_type_drop_attribute ----------------------------------------------


def test_alter_type_drop_attribute() -> None:
    sql = ddl.alter_type_drop_attribute("public", "addr", "city")

    assert sql == 'ALTER TYPE "public"."addr" DROP ATTRIBUTE "city"'


def test_alter_type_drop_attribute_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.alter_type_drop_attribute("public", "", "city")


# --- alter_type_alter_attribute_type ----------------------------------------


def test_alter_type_alter_attribute_type() -> None:
    sql = ddl.alter_type_alter_attribute_type("public", "addr", "a", "bigint")

    assert sql == 'ALTER TYPE "public"."addr" ALTER ATTRIBUTE "a" TYPE bigint'


def test_alter_type_alter_attribute_type_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.alter_type_alter_attribute_type("public", "", "a", "bigint")


# --- alter_type_rename_attribute --------------------------------------------


def test_alter_type_rename_attribute() -> None:
    sql = ddl.alter_type_rename_attribute("public", "addr", "street", "road")

    assert sql == 'ALTER TYPE "public"."addr" RENAME ATTRIBUTE "street" TO "road"'


def test_alter_type_rename_attribute_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.alter_type_rename_attribute("public", "", "street", "road")


# --- alter_type_rename_value -------------------------------------------------


def test_alter_type_rename_value() -> None:
    sql = ddl.alter_type_rename_value("public", "mood", "ok", "fine")

    assert sql == "ALTER TYPE \"public\".\"mood\" RENAME VALUE 'ok' TO 'fine'"


def test_alter_type_rename_value_escapes_embedded_quote() -> None:
    sql = ddl.alter_type_rename_value("public", "mood", "o'k", "fine")

    assert sql == "ALTER TYPE \"public\".\"mood\" RENAME VALUE 'o''k' TO 'fine'"


def test_alter_type_rename_value_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.alter_type_rename_value("public", "", "ok", "fine")


# --- recreate_enum_type ------------------------------------------------------


def test_recreate_enum_type_no_dependents() -> None:
    sql = ddl.recreate_enum_type("public", "mood", ["sad", "happy"], [])

    assert sql == (
        'ALTER TYPE "public"."mood" RENAME TO "mood__old";\n'
        "CREATE TYPE \"public\".\"mood\" AS ENUM ('sad', 'happy');\n"
        'DROP TYPE "public"."mood__old"'
    )


def test_recreate_enum_type_with_dependent() -> None:
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=False, default_expr="'ok'::public.mood",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["sad", "happy"], [dependent])

    assert sql == (
        'ALTER TYPE "public"."mood" RENAME TO "mood__old";\n'
        "CREATE TYPE \"public\".\"mood\" AS ENUM ('sad', 'happy');\n"
        'ALTER TABLE "public"."t" ALTER COLUMN "m" DROP DEFAULT;\n'
        'ALTER TABLE "public"."t" ALTER COLUMN "m" TYPE "public"."mood" USING "m"::text::"public"."mood";\n'
        "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"m\" SET DEFAULT 'ok'::public.mood;\n"
        'DROP TYPE "public"."mood__old"'
    )


def test_recreate_enum_type_array_dependent() -> None:
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=True, default_expr=None,
    )
    sql = ddl.recreate_enum_type("public", "mood", ["sad", "happy"], [dependent])

    assert sql == (
        'ALTER TYPE "public"."mood" RENAME TO "mood__old";\n'
        "CREATE TYPE \"public\".\"mood\" AS ENUM ('sad', 'happy');\n"
        'ALTER TABLE "public"."t" ALTER COLUMN "m" TYPE "public"."mood"[] USING "m"::text[]::"public"."mood"[];\n'
        'DROP TYPE "public"."mood__old"'
    )


def test_recreate_enum_type_no_default_expr_skips_drop_set_default() -> None:
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=False, default_expr=None,
    )
    sql = ddl.recreate_enum_type("public", "mood", ["sad", "happy"], [dependent])

    assert "DROP DEFAULT" not in sql
    assert "SET DEFAULT" not in sql


def test_recreate_enum_type_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.recreate_enum_type("public", "", ["sad"], [])


def test_recreate_enum_type_empty_labels_raises() -> None:
    with pytest.raises(ValidationError):
        ddl.recreate_enum_type("public", "mood", [], [])


# --- recreate_enum_type + renames (round-3 audit fix: a same-edit rename that
# a dependent's default holds the pre-rename spelling of) --------------------


def test_recreate_enum_type_rewrites_a_default_holding_a_renamed_label() -> None:
    # Reproduces the round-3 audit's case (a): the dependent-column
    # introspection that feeds `default_expr` runs before any statement in
    # the generated script — including a live RENAME VALUE — has touched the
    # database, so `default_expr` always carries the *pre*-rename spelling. A
    # blind pass-through would emit `SET DEFAULT 'ok'::public.mood` against a
    # recreated type that no longer has an 'ok' label at all (it was renamed
    # to 'fine'), failing with "invalid input value for enum". `renames`
    # lets the builder rewrite the literal itself.
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=False, default_expr="'ok'::public.mood",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["fine", "happy"], [dependent], [("ok", "fine")])

    assert sql == (
        'ALTER TYPE "public"."mood" RENAME TO "mood__old";\n'
        "CREATE TYPE \"public\".\"mood\" AS ENUM ('fine', 'happy');\n"
        'ALTER TABLE "public"."t" ALTER COLUMN "m" DROP DEFAULT;\n'
        'ALTER TABLE "public"."t" ALTER COLUMN "m" TYPE "public"."mood" USING "m"::text::"public"."mood";\n'
        "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"m\" SET DEFAULT 'fine'::public.mood;\n"
        'DROP TYPE "public"."mood__old"'
    )


def test_recreate_enum_type_default_untouched_when_no_rename_matches() -> None:
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=False, default_expr="'happy'::public.mood",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["fine", "happy"], [dependent], [("ok", "fine")])

    assert "SET DEFAULT 'happy'::public.mood" in sql


def test_recreate_enum_type_renames_defaults_to_empty() -> None:
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=False, default_expr="'ok'::public.mood",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["ok", "happy"], [dependent])

    assert "SET DEFAULT 'ok'::public.mood" in sql


def test_recreate_enum_type_rewrites_a_renamed_label_inside_an_array_default() -> None:
    # Round-3 audit follow-up: an array-typed dependent's DEFAULT deparses as
    # `'{ok,sad}'::schema.type[]` — the label isn't individually SQL-quoted
    # the way a scalar default's is, so the fix must rewrite it inside
    # Postgres's own array-literal syntax, not via a plain quote_literal
    # substring search (which would silently no-op here).
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=True, default_expr="'{ok,sad}'::public.mood[]",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["fine", "sad"], [dependent], [("ok", "fine")])

    assert "SET DEFAULT '{fine,sad}'::public.mood[]" in sql


def test_recreate_enum_type_array_default_rename_does_not_touch_other_elements() -> None:
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=True, default_expr="'{ok,sad,happy}'::public.mood[]",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["fine", "sad", "happy"], [dependent], [("ok", "fine")])

    assert "SET DEFAULT '{fine,sad,happy}'::public.mood[]" in sql


def test_recreate_enum_type_array_default_element_needing_escaping_round_trips() -> None:
    # An array element containing a comma must be Postgres-array-quoted; the
    # rewrite must preserve that quoting for an untouched neighboring element.
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=True,
        default_expr='\'{ok,"a,b"}\'::public.mood[]',
    )
    sql = ddl.recreate_enum_type("public", "mood", ["fine", "a,b"], [dependent], [("ok", "fine")])

    assert 'SET DEFAULT \'{fine,"a,b"}\'::public.mood[]' in sql


def test_recreate_enum_type_rewrites_a_renamed_label_inside_an_array_constructor_default() -> None:
    # A second audit round's live repro: Postgres may deparse an array
    # default as an `ARRAY[...]` constructor instead of a `'{...}'` literal
    # — each element is then its own, separately-matched SQL string literal
    # (not nested array-literal syntax), so it must go through the same
    # whole-token rewrite a scalar default's label does, not the `{...}`
    # element parser.
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="ms", is_array=True,
        default_expr="ARRAY['ok'::public.mood, 'sad'::public.mood]",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["fine", "sad"], [dependent], [("ok", "fine")])

    assert "SET DEFAULT ARRAY['fine'::public.mood, 'sad'::public.mood]" in sql


def test_recreate_enum_type_array_default_null_element_is_not_corrupted() -> None:
    # A second audit round's live repro: an unquoted `NULL` inside a `{...}`
    # array literal is a genuine SQL null, not a label spelled "NULL" (a
    # label with that spelling is always `"`-quoted on output) — it must
    # round-trip as bare `NULL`, not get re-quoted into the label `"NULL"`.
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="ms", is_array=True, default_expr="'{NULL,ok}'::public.mood[]",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["fine", "sad"], [dependent], [("ok", "fine")])

    assert "SET DEFAULT '{NULL,fine}'::public.mood[]" in sql


def test_recreate_enum_type_rewrites_a_renamed_label_inside_a_dimension_prefixed_array_default() -> None:
    # A third audit round's live repro: Postgres deparses an array default
    # with a non-default lower bound as `'[2:3]={ok,sad}'` — the dimension
    # prefix isn't part of the `{...}` body the element rewriter parses, and
    # must be reattached verbatim (it names no label).
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="ms", is_array=True, default_expr="'[2:3]={ok,sad}'::public.mood[]",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["fine", "sad"], [dependent], [("ok", "fine")])

    assert "SET DEFAULT '[2:3]={fine,sad}'::public.mood[]" in sql


def test_recreate_enum_type_rewrites_a_renamed_label_inside_a_dimension_prefixed_2d_array_default() -> None:
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="ms", is_array=True,
        default_expr="'[0:1][0:1]={{ok,sad},{happy,ok}}'::public.mood[]",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["fine", "sad", "happy"], [dependent], [("ok", "fine")])

    assert "SET DEFAULT '[0:1][0:1]={{fine,sad},{happy,fine}}'::public.mood[]" in sql


def test_recreate_enum_type_array_constructor_element_shaped_like_braces_is_not_misparsed_as_array_literal() -> None:
    # A fifth audit round's live repro: a label literally spelled "{x}"
    # inside an ARRAY[...] constructor default must be rewritten as a
    # whole-token label, not misdetected (by its own brace-wrapped shape) as
    # a nested `{...}` array-literal body — that misparse produced
    # `invalid input value for enum ...: "{x}"` on SET DEFAULT.
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="ms", is_array=True,
        default_expr="ARRAY['{x}'::public.mood, 'zzz'::public.mood]",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["renamed", "zzz"], [dependent], [("{x}", "renamed")])

    assert "SET DEFAULT ARRAY['renamed'::public.mood, 'zzz'::public.mood]" in sql


def test_recreate_enum_type_default_with_embedded_quote_label_is_not_corrupted_by_an_unrelated_rename() -> None:
    # A default holding label "a'b" (SQL-deparsed as `'a''b'`) must not be
    # mistaken for label "a" just because `'a'` happens to be a substring of
    # `'a''b'` — the doubled quote marks it as part of one longer literal.
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=False, default_expr="'a''b'::public.mood",
    )
    sql = ddl.recreate_enum_type("public", "mood", ["x", "a'b"], [dependent], [("a", "x")])

    assert "SET DEFAULT 'a''b'::public.mood" in sql


# --- recreate_enum_type + colliding_renames (sixth audit round: a stored row
# still holding the *removed* label a colliding rename's target text
# coincides with was silently relabeled instead of failing) ------------------


def test_recreate_enum_type_scalar_collision_uses_a_rename_aware_case_cast() -> None:
    # Renaming "a" to "c" while deleting the original "c": a blind
    # `::text::newtype` round-trip can't tell a row holding old "a" apart
    # from one holding old "c" once both read back as the same text. The
    # CASE keys off the *old* type's oid (via `= 'x'::old_type`), not text,
    # so it can still tell them apart.
    dependent = ddl.EnumColumnDependency(schema="public", table="t", column="m", is_array=False, default_expr=None)
    colliding = [("a", "c")]

    sql = ddl.recreate_enum_type("public", "mood", ["c", "b"], [dependent], colliding, colliding)

    assert (
        'ALTER TABLE "public"."t" ALTER COLUMN "m" TYPE "public"."mood" USING '
        '(CASE WHEN "m" = \'a\'::"public"."mood__old" THEN \'c\' '
        'WHEN "m" = \'c\'::"public"."mood__old" THEN \'__removed_label_c__\' '
        'ELSE "m"::text END)::"public"."mood"'
    ) in sql


def test_recreate_enum_type_array_collision_wraps_a_pg_temp_function() -> None:
    # Postgres refuses a subquery in a column-type USING clause (confirmed
    # empirically), so the array case's per-element CASE is wrapped in a
    # pg_temp SQL function instead of an unnest()/array_agg() subquery — and
    # the function is dropped again once the ALTER COLUMN that used it has
    # run, since it's typed over the *old* enum and would otherwise block
    # the script's final DROP TYPE.
    dependent = ddl.EnumColumnDependency(schema="public", table="t", column="ms", is_array=True, default_expr=None)
    colliding = [("a", "c")]

    sql = ddl.recreate_enum_type("public", "mood", ["c", "b"], [dependent], colliding, colliding)

    assert 'CREATE FUNCTION pg_temp."__enum_recreate_migrate_0__"(arr "public"."mood__old"[]) RETURNS text[]' in sql
    assert (
        'ALTER TABLE "public"."t" ALTER COLUMN "ms" TYPE "public"."mood"[] USING '
        'pg_temp."__enum_recreate_migrate_0__"("ms")::"public"."mood"[]'
    ) in sql
    assert 'DROP FUNCTION pg_temp."__enum_recreate_migrate_0__"("public"."mood__old"[])' in sql
    # The DROP FUNCTION must run before the script's own final DROP TYPE, or
    # that statement would fail with the function still depending on it.
    assert sql.index('DROP FUNCTION pg_temp."__enum_recreate_migrate_0__"') < sql.rindex('DROP TYPE "public"."mood__old"')


def test_recreate_enum_type_two_dependents_get_distinct_migrate_function_names() -> None:
    dependents = [
        ddl.EnumColumnDependency(schema="public", table="t1", column="ms", is_array=True, default_expr=None),
        ddl.EnumColumnDependency(schema="public", table="t2", column="ms", is_array=True, default_expr=None),
    ]
    colliding = [("a", "c")]

    sql = ddl.recreate_enum_type("public", "mood", ["c", "b"], dependents, colliding, colliding)

    assert 'pg_temp."__enum_recreate_migrate_0__"' in sql
    assert 'pg_temp."__enum_recreate_migrate_1__"' in sql


def test_recreate_enum_type_no_colliding_renames_is_unaffected() -> None:
    # A non-colliding rename (or none at all) must produce the exact
    # pre-round-6 plain round-trip cast — no CASE, no pg_temp function.
    dependent = ddl.EnumColumnDependency(schema="public", table="t", column="m", is_array=False, default_expr=None)

    sql = ddl.recreate_enum_type("public", "mood", ["fine", "b"], [dependent], [("ok", "fine")])

    assert 'USING "m"::text::"public"."mood"' in sql
    assert "CASE" not in sql
    assert "pg_temp" not in sql


# --- recreate_enum_type + colliding_renames, round 9: two gaps a sixth audit
# round found in round 8's own fix -------------------------------------------


def test_recreate_enum_type_array_collision_migrate_function_preserves_null_and_empty() -> None:
    # A sixth audit round's live repro: array_agg() over unnest() of a NULL
    # or an empty array both return no rows, so a naive array_agg() alone
    # can't tell them apart and collapses both to NULL — silently turning a
    # stored empty array into a NULL column value. The generated pg_temp
    # function must special-case both before falling through to array_agg().
    dependent = ddl.EnumColumnDependency(schema="public", table="ms", column="ms", is_array=True, default_expr=None)
    colliding = [("a", "c")]

    sql = ddl.recreate_enum_type("public", "mood", ["c", "b"], [dependent], colliding, colliding)

    assert "WHEN arr IS NULL THEN NULL" in sql
    assert "WHEN array_length(arr, 1) IS NULL THEN '{}'::text[]" in sql


def test_recreate_enum_type_default_holding_the_removed_labels_own_value_fails_loudly() -> None:
    # A sixth audit round's live repro: a dependent's DEFAULT spelled
    # exactly as the *removed* label a colliding rename's target text
    # coincides with (not the rename's own pre-rename spelling) matched no
    # rename key and passed through untouched, so SET DEFAULT silently
    # succeeded under the renamed-from identity's meaning instead of failing
    # — the DEFAULT-literal analogue of the round-8 stored-data fix. Now
    # routed through the same removed-label sentinel `_migration_using_
    # clause` uses for row data, so `SET DEFAULT` fails per
    # `recreate_enum_type`'s "a stored row still holds a removed label"
    # contract, applied to a default too.
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=False, default_expr="'c'::public.mood",
    )
    colliding = [("a", "c")]

    sql = ddl.recreate_enum_type("public", "mood", ["c", "b"], [dependent], colliding, colliding)

    assert "SET DEFAULT '__removed_label_c__'::public.mood" in sql


def test_recreate_enum_type_default_holding_the_rename_source_still_migrates_when_colliding() -> None:
    # Control for the case above: a DEFAULT holding the colliding rename's
    # own pre-rename value must still correctly migrate to its post-rename
    # spelling (this is what round 3's original fix — later found
    # incomplete for the collision case — already covered for a
    # *non*-colliding rename; this pins it for a colliding one too).
    dependent = ddl.EnumColumnDependency(
        schema="public", table="t", column="m", is_array=False, default_expr="'a'::public.mood",
    )
    colliding = [("a", "c")]

    sql = ddl.recreate_enum_type("public", "mood", ["c", "b"], [dependent], colliding, colliding)

    assert "SET DEFAULT 'c'::public.mood" in sql
