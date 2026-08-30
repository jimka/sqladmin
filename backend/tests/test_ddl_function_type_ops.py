"""
Function/type-DDL preview operations: construction validation and build()
dispatch, following the NO_CONN pure-logic style (see conftest.py,
test_ddl_schema_sequence_ops.py). Every op but ``RecreateEnumTypePreview`` is
exercised with build() directly — its default apply() (inherited from
DdlPreview) just calls build(). ``RecreateEnumTypePreview`` overrides
apply() to introspect first, so it is additionally exercised through a
``_FakeConn`` stand-in, mirroring test_type_definition.py's identical
fetchrow/fetch two-query pattern.
"""

from __future__ import annotations

import pytest

from app.errors import NotFound, ValidationError
from app.operations import (
    AlterCompositeTypePreview,
    AlterTypeAddValuePreview,
    AlterTypeRenameValuePreview,
    CreateCompositeTypePreview,
    CreateEnumTypePreview,
    CreateFunctionPreview,
    DropFunctionPreview,
    DropTypePreview,
    RecreateEnumTypePreview,
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


# --- AlterCompositeTypePreview --------------------------------------------------


def test_alter_composite_type_add_attribute_build() -> None:
    spec = {
        "schema": "public", "name": "addr", "action": "addAttribute",
        "attributeDef": {"name": "zip", "type": "varchar(10)"},
    }
    op = AlterCompositeTypePreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TYPE "public"."addr" ADD ATTRIBUTE "zip" varchar(10)'}


def test_alter_composite_type_drop_attribute_build() -> None:
    spec = {"schema": "public", "name": "addr", "action": "dropAttribute", "attribute": "city"}
    op = AlterCompositeTypePreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TYPE "public"."addr" DROP ATTRIBUTE "city"'}


def test_alter_composite_type_change_attribute_type_build() -> None:
    spec = {"schema": "public", "name": "addr", "action": "changeAttributeType", "attribute": "a", "newType": "bigint"}
    op = AlterCompositeTypePreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TYPE "public"."addr" ALTER ATTRIBUTE "a" TYPE bigint'}


def test_alter_composite_type_rename_attribute_build() -> None:
    spec = {"schema": "public", "name": "addr", "action": "renameAttribute", "attribute": "street", "newName": "road"}
    op = AlterCompositeTypePreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'ALTER TYPE "public"."addr" RENAME ATTRIBUTE "street" TO "road"'}


def test_alter_composite_type_unknown_action_raises() -> None:
    op = AlterCompositeTypePreview(NO_CONN, {"schema": "public", "name": "addr", "action": "bogus"})

    with pytest.raises(ValidationError):
        op.build()


def test_alter_composite_type_drop_attribute_missing_attribute_raises() -> None:
    op = AlterCompositeTypePreview(NO_CONN, {"schema": "public", "name": "addr", "action": "dropAttribute"})

    with pytest.raises(ValidationError):
        op.build()


def test_alter_composite_type_rename_attribute_missing_new_name_raises() -> None:
    op = AlterCompositeTypePreview(
        NO_CONN, {"schema": "public", "name": "addr", "action": "renameAttribute", "attribute": "street"},
    )

    with pytest.raises(ValidationError):
        op.build()


def test_alter_composite_type_change_type_missing_new_type_raises() -> None:
    op = AlterCompositeTypePreview(
        NO_CONN, {"schema": "public", "name": "addr", "action": "changeAttributeType", "attribute": "a"},
    )

    with pytest.raises(ValidationError):
        op.build()


def test_alter_composite_type_add_attribute_missing_attribute_def_raises() -> None:
    op = AlterCompositeTypePreview(NO_CONN, {"schema": "public", "name": "addr", "action": "addAttribute"})

    with pytest.raises(ValidationError):
        op.build()


def test_alter_composite_type_add_attribute_blank_type_raises() -> None:
    op = AlterCompositeTypePreview(
        NO_CONN,
        {"schema": "public", "name": "addr", "action": "addAttribute", "attributeDef": {"name": "zip", "type": ""}},
    )

    with pytest.raises(ValidationError):
        op.build()


def test_alter_composite_type_blank_schema_raises() -> None:
    with pytest.raises(ValidationError):
        AlterCompositeTypePreview(NO_CONN, {"schema": "", "name": "addr", "action": "dropAttribute", "attribute": "a"})


# --- AlterTypeRenameValuePreview -------------------------------------------------


def test_alter_type_rename_value_build() -> None:
    spec = {"schema": "public", "name": "mood", "value": "ok", "newValue": "fine"}
    op = AlterTypeRenameValuePreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": "ALTER TYPE \"public\".\"mood\" RENAME VALUE 'ok' TO 'fine'"}


def test_alter_type_rename_value_blank_schema_raises() -> None:
    with pytest.raises(ValidationError):
        AlterTypeRenameValuePreview(NO_CONN, {"schema": "", "name": "mood", "value": "ok", "newValue": "fine"})


def test_alter_type_rename_value_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        AlterTypeRenameValuePreview(NO_CONN, {"schema": "public", "name": "", "value": "ok", "newValue": "fine"})


def test_alter_type_rename_value_blank_value_raises() -> None:
    with pytest.raises(ValidationError):
        AlterTypeRenameValuePreview(NO_CONN, {"schema": "public", "name": "mood", "value": "", "newValue": "fine"})


def test_alter_type_rename_value_blank_new_value_raises() -> None:
    with pytest.raises(ValidationError):
        AlterTypeRenameValuePreview(NO_CONN, {"schema": "public", "name": "mood", "value": "ok", "newValue": ""})


# --- RecreateEnumTypePreview ------------------------------------------------------


def test_recreate_enum_type_build_no_dependents() -> None:
    op = RecreateEnumTypePreview(NO_CONN, {"schema": "public", "name": "mood", "labels": ["sad", "happy"]})
    op.build()

    assert op.get_result() == {"sql": (
        'ALTER TYPE "public"."mood" RENAME TO "mood__old";\n'
        "CREATE TYPE \"public\".\"mood\" AS ENUM ('sad', 'happy');\n"
        'DROP TYPE "public"."mood__old"'
    )}


def test_recreate_enum_type_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        RecreateEnumTypePreview(NO_CONN, {"schema": "public", "name": "", "labels": ["sad"]})


def test_recreate_enum_type_empty_labels_raises() -> None:
    op = RecreateEnumTypePreview(NO_CONN, {"schema": "public", "name": "mood", "labels": []})

    with pytest.raises(ValidationError):
        op.build()


class _FakeConn:
    """
    Records each query and returns pre-seeded rows in call order — mirrors
    test_type_definition.py's _FakeConn, one response per fetchrow/fetch call.
    """

    def __init__(self, responses: list) -> None:
        self._responses: list = responses
        self.queries: list[str] = []

    async def fetchrow(self, sql: str, *args: object) -> object:
        """
        Return the next seeded response, recording the SQL that was run.
        """
        self.queries.append(sql)

        return self._responses.pop(0)

    async def fetch(self, sql: str, *args: object) -> list:
        """
        Return the next seeded response, recording the SQL that was run.
        """
        self.queries.append(sql)

        return self._responses.pop(0)


async def test_recreate_enum_type_apply_raises_not_found_when_absent() -> None:
    conn = _FakeConn(responses=[None])
    op = RecreateEnumTypePreview(conn, {"schema": "public", "name": "mood", "labels": ["sad"]})  # type: ignore[arg-type]

    with pytest.raises(NotFound):
        await op.apply()


async def test_recreate_enum_type_apply_maps_dependents_and_builds() -> None:
    # Exercises apply()'s two-query introspection end to end: the type-oid
    # lookup, then the dependents query, mapped through EnumColumnDependency
    # into the same rename/create/migrate/drop script build() alone produces
    # from a hand-built dependent (see the SQL-builder tests).
    type_row = {"oid": 1, "typarray": 2}
    dependent_row = {
        "schema": "public", "table": "t", "column": "m", "is_array": False,
        "default_expr": "'ok'::public.mood",
    }
    conn = _FakeConn(responses=[type_row, [dependent_row]])
    op = RecreateEnumTypePreview(
        conn, {"schema": "public", "name": "mood", "labels": ["sad", "happy"]},  # type: ignore[arg-type]
    )

    await op.apply()

    assert op.get_result() == {"sql": (
        'ALTER TYPE "public"."mood" RENAME TO "mood__old";\n'
        "CREATE TYPE \"public\".\"mood\" AS ENUM ('sad', 'happy');\n"
        'ALTER TABLE "public"."t" ALTER COLUMN "m" DROP DEFAULT;\n'
        'ALTER TABLE "public"."t" ALTER COLUMN "m" TYPE "public"."mood" USING "m"::text::"public"."mood";\n'
        "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"m\" SET DEFAULT 'ok'::public.mood;\n"
        'DROP TYPE "public"."mood__old"'
    )}
    # Locks the inheritance/partition-child exclusion (see _DEPENDENTS_SQL's
    # comment): a partitioned parent's ALTER ... TYPE recurses to every
    # child on its own, and Postgres refuses that same ALTER run directly
    # against a child ("cannot alter inherited column") — so only the
    # attinhcount = 0 (top-level) column may be queried.
    assert "attinhcount = 0" in conn.queries[1]


async def test_recreate_enum_type_apply_maps_array_dependent_with_no_default() -> None:
    type_row = {"oid": 1, "typarray": 2}
    dependent_row = {"schema": "public", "table": "t", "column": "m", "is_array": True, "default_expr": None}
    conn = _FakeConn(responses=[type_row, [dependent_row]])
    op = RecreateEnumTypePreview(conn, {"schema": "public", "name": "mood", "labels": ["sad"]})  # type: ignore[arg-type]

    await op.apply()

    sql = op.get_result()["sql"]
    assert '"public"."mood"[] USING "m"::text[]::"public"."mood"[]' in sql
    assert "DROP DEFAULT" not in sql
    assert "SET DEFAULT" not in sql


# --- RecreateEnumTypePreview + renames (round-3 audit fix) -------------------


def test_recreate_enum_type_build_with_no_renames_matches_pure_build() -> None:
    # A spec with no `renames` key behaves exactly like the pre-fix spec
    # shape — build() alone (NO_CONN, no dependents) is unaffected.
    op = RecreateEnumTypePreview(NO_CONN, {"schema": "public", "name": "mood", "labels": ["sad", "happy"]})
    op.build()

    assert op.get_result() == {"sql": (
        'ALTER TYPE "public"."mood" RENAME TO "mood__old";\n'
        "CREATE TYPE \"public\".\"mood\" AS ENUM ('sad', 'happy');\n"
        'DROP TYPE "public"."mood__old"'
    )}


def test_recreate_enum_type_malformed_rename_entry_raises_validation_error() -> None:
    # A `renames` entry missing `value`/`newValue` (or not an object at all)
    # must surface as the same typed ValidationError -> 400 every other
    # DDL preview spec field gets (see `_composite_attr`'s identical
    # is-a-mapping guard), not an untyped KeyError -> 500.
    with pytest.raises(ValidationError):
        RecreateEnumTypePreview(
            NO_CONN, {"schema": "public", "name": "mood", "labels": ["sad"], "renames": [{"value": "ok"}]},
        )


def test_recreate_enum_type_rename_entry_not_an_object_raises_validation_error() -> None:
    with pytest.raises(ValidationError):
        RecreateEnumTypePreview(
            NO_CONN, {"schema": "public", "name": "mood", "labels": ["sad"], "renames": ["ok"]},
        )


async def test_recreate_enum_type_apply_rewrites_default_through_renames() -> None:
    # Round-3 audit case (a): apply()'s dependent introspection always runs
    # before any statement in the generated script — including a live
    # RENAME VALUE, which only runs when the caller later executes the
    # previewed SQL — has touched the database, so a default holding a
    # same-edit-renamed label is captured under its pre-rename spelling.
    # `renames` (the wire spec's {value, newValue} pairs) is how the
    # generated script corrects it without needing another catalog
    # round-trip.
    type_row = {"oid": 1, "typarray": 2}
    dependent_row = {
        "schema": "public", "table": "t", "column": "m", "is_array": False,
        "default_expr": "'ok'::public.mood",
    }
    conn = _FakeConn(responses=[type_row, [dependent_row]])
    op = RecreateEnumTypePreview(
        conn,  # type: ignore[arg-type]
        {
            "schema": "public", "name": "mood", "labels": ["fine", "happy"],
            "renames": [{"value": "ok", "newValue": "fine"}],
        },
    )

    await op.apply()

    assert op.get_result() == {"sql": (
        'ALTER TYPE "public"."mood" RENAME TO "mood__old";\n'
        "CREATE TYPE \"public\".\"mood\" AS ENUM ('fine', 'happy');\n"
        'ALTER TABLE "public"."t" ALTER COLUMN "m" DROP DEFAULT;\n'
        'ALTER TABLE "public"."t" ALTER COLUMN "m" TYPE "public"."mood" USING "m"::text::"public"."mood";\n'
        "ALTER TABLE \"public\".\"t\" ALTER COLUMN \"m\" SET DEFAULT 'fine'::public.mood;\n"
        'DROP TYPE "public"."mood__old"'
    )}


async def test_recreate_enum_type_apply_uses_collision_aware_cast_for_a_colliding_rename() -> None:
    # Sixth audit round: a rename whose target collides with a same-edit
    # removal needs the data migration itself (not just the DEFAULT
    # literal) to be rename-aware — see ddl._migration_using_clause's doc.
    type_row = {"oid": 1, "typarray": 2}
    dependent_row = {
        "schema": "public", "table": "t", "column": "m", "is_array": False, "default_expr": None,
    }
    conn = _FakeConn(responses=[type_row, [dependent_row]])
    op = RecreateEnumTypePreview(
        conn,  # type: ignore[arg-type]
        {
            "schema": "public", "name": "mood", "labels": ["c", "b"],
            "renames": [{"value": "a", "newValue": "c"}],
            "collidingRenames": [{"value": "a", "newValue": "c"}],
        },
    )

    await op.apply()

    sql = op.get_result()["sql"]
    assert 'CASE WHEN "m" = \'a\'::"public"."mood__old" THEN \'c\'' in sql
    assert "WHEN \"m\" = 'c'::\"public\".\"mood__old\" THEN '__removed_label_c__'" in sql
