"""
Schema/sequence-DDL preview operations: construction validation and build()
dispatch, following the NO_CONN pure-logic style (see conftest.py,
test_view_matview_ddl_ops.py). Each op is exercised with build() directly —
the default apply() (inherited from DdlPreview) just calls build(), already
covered by test_execute_ddl.py.
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.operations import (
    SchemaCreatePreview,
    SchemaDropPreview,
    SchemaRenamePreview,
    SequenceAlterPreview,
    SequenceCreatePreview,
    SequenceDropPreview,
    SequenceOwnerPreview,
)
from tests.conftest import NO_CONN

# --- SchemaCreatePreview ---------------------------------------------------------


def test_schema_create_build() -> None:
    op = SchemaCreatePreview(NO_CONN, {"name": "analytics", "authorization": "app_owner"})
    op.build()

    assert op.get_result() == {"sql": 'CREATE SCHEMA "analytics" AUTHORIZATION "app_owner"'}


def test_schema_create_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        SchemaCreatePreview(NO_CONN, {"name": ""})


def test_schema_create_get_result_before_build_raises() -> None:
    op = SchemaCreatePreview(NO_CONN, {"name": "analytics"})

    with pytest.raises(RuntimeError):
        op.get_result()


# --- SchemaDropPreview -----------------------------------------------------------


def test_schema_drop_build() -> None:
    op = SchemaDropPreview(NO_CONN, {"name": "analytics", "cascade": True, "ifExists": True})
    op.build()

    assert op.get_result() == {"sql": 'DROP SCHEMA IF EXISTS "analytics" CASCADE'}


def test_schema_drop_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        SchemaDropPreview(NO_CONN, {"name": ""})


# --- SchemaRenamePreview ----------------------------------------------------------


def test_schema_rename_build() -> None:
    op = SchemaRenamePreview(NO_CONN, {"name": "analytics", "newName": "reporting"})
    op.build()

    assert op.get_result() == {"sql": 'ALTER SCHEMA "analytics" RENAME TO "reporting"'}


def test_schema_rename_blank_new_name_raises() -> None:
    with pytest.raises(ValidationError):
        SchemaRenamePreview(NO_CONN, {"name": "analytics", "newName": ""})


# --- SequenceCreatePreview --------------------------------------------------------


def test_sequence_create_build() -> None:
    spec = {"schema": "public", "name": "order_id_seq", "increment": 1, "start": 1000, "cycle": False}
    op = SequenceCreatePreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'CREATE SEQUENCE "public"."order_id_seq" INCREMENT BY 1 START WITH 1000'}


def test_sequence_create_owned_by() -> None:
    spec = {
        "schema": "public", "name": "order_id_seq",
        "ownedBy": {"schema": "public", "table": "orders", "column": "id"},
    }
    op = SequenceCreatePreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'CREATE SEQUENCE "public"."order_id_seq" OWNED BY "public"."orders"."id"'}


def test_sequence_create_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        SequenceCreatePreview(NO_CONN, {"schema": "public", "name": ""})


def test_sequence_create_non_integer_raises() -> None:
    with pytest.raises(ValidationError):
        SequenceCreatePreview(NO_CONN, {"schema": "public", "name": "s", "increment": "x"})


def test_sequence_create_non_integral_float_raises() -> None:
    with pytest.raises(ValidationError):
        SequenceCreatePreview(NO_CONN, {"schema": "public", "name": "s", "increment": 1.5})


def test_sequence_create_bool_rejected_as_numeric() -> None:
    # A JSON `true`/`false` decodes to Python bool, which is an int subclass;
    # it must not be silently accepted as a numeric option.
    with pytest.raises(ValidationError):
        SequenceCreatePreview(NO_CONN, {"schema": "public", "name": "s", "increment": True})


# --- SequenceAlterPreview ---------------------------------------------------------


def test_sequence_alter_restart_default_build() -> None:
    op = SequenceAlterPreview(NO_CONN, {"schema": "public", "name": "order_id_seq", "restartDefault": True})
    op.build()

    assert op.get_result() == {"sql": 'ALTER SEQUENCE "public"."order_id_seq" RESTART'}


def test_sequence_alter_restart_with_value_build() -> None:
    op = SequenceAlterPreview(NO_CONN, {"schema": "public", "name": "order_id_seq", "restart": 1})
    op.build()

    assert op.get_result() == {"sql": 'ALTER SEQUENCE "public"."order_id_seq" RESTART WITH 1'}


def test_sequence_alter_cycle_false_build() -> None:
    op = SequenceAlterPreview(NO_CONN, {"schema": "public", "name": "order_id_seq", "cycle": False})
    op.build()

    assert op.get_result() == {"sql": 'ALTER SEQUENCE "public"."order_id_seq" NO CYCLE'}


def test_sequence_alter_no_options_raises() -> None:
    op = SequenceAlterPreview(NO_CONN, {"schema": "public", "name": "order_id_seq"})

    with pytest.raises(ValidationError):
        op.build()


def test_sequence_alter_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        SequenceAlterPreview(NO_CONN, {"schema": "public", "name": "", "increment": 1})


def test_sequence_alter_non_integer_raises() -> None:
    with pytest.raises(ValidationError):
        SequenceAlterPreview(NO_CONN, {"schema": "public", "name": "s", "cache": "x"})


def test_sequence_alter_start_string_build() -> None:
    op = SequenceAlterPreview(NO_CONN, {"schema": "public", "name": "order_id_seq", "start": "1000"})
    op.build()

    assert op.get_result() == {"sql": 'ALTER SEQUENCE "public"."order_id_seq" START WITH 1000'}


def test_sequence_alter_bigint_string_round_trips() -> None:
    op = SequenceAlterPreview(
        NO_CONN, {"schema": "public", "name": "order_id_seq", "maxValue": "9223372036854775807"},
    )
    op.build()

    assert op.get_result() == {
        "sql": 'ALTER SEQUENCE "public"."order_id_seq" MAXVALUE 9223372036854775807',
    }


def test_sequence_alter_data_type_build() -> None:
    op = SequenceAlterPreview(NO_CONN, {"schema": "public", "name": "order_id_seq", "dataType": "bigint"})
    op.build()

    assert op.get_result() == {"sql": 'ALTER SEQUENCE "public"."order_id_seq" AS bigint'}


def test_sequence_alter_unsupported_data_type_raises() -> None:
    op = SequenceAlterPreview(NO_CONN, {"schema": "public", "name": "order_id_seq", "dataType": "nope"})

    with pytest.raises(ValidationError):
        op.build()


# --- SequenceOwnerPreview ---------------------------------------------------------


def test_sequence_owner_build() -> None:
    op = SequenceOwnerPreview(NO_CONN, {"schema": "public", "name": "order_id_seq", "owner": "app_owner"})
    op.build()

    assert op.get_result() == {"sql": 'ALTER SEQUENCE "public"."order_id_seq" OWNER TO "app_owner"'}


def test_sequence_owner_blank_owner_raises() -> None:
    with pytest.raises(ValidationError):
        SequenceOwnerPreview(NO_CONN, {"schema": "public", "name": "s", "owner": ""})


# --- SequenceDropPreview ----------------------------------------------------------


def test_sequence_drop_build() -> None:
    op = SequenceDropPreview(NO_CONN, {"schema": "public", "name": "order_id_seq", "cascade": True, "ifExists": True})
    op.build()

    assert op.get_result() == {"sql": 'DROP SEQUENCE IF EXISTS "public"."order_id_seq" CASCADE'}


def test_sequence_drop_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        SequenceDropPreview(NO_CONN, {"schema": "public", "name": ""})
