"""
View/matview-DDL preview operations: construction validation and build()
dispatch, following the NO_CONN pure-logic style (see conftest.py,
test_ddl_table_preview.py). Each op is exercised with build() directly — the
default apply() (inherited from DdlPreview) just calls build(), already
covered by test_execute_ddl.py.
"""

from __future__ import annotations

import pytest

from app.errors import ValidationError
from app.operations import (
    CreateMaterializedViewPreview,
    CreateViewPreview,
    DropMaterializedViewPreview,
    DropViewPreview,
    RefreshMaterializedViewPreview,
    ReplaceMaterializedViewPreview,
)
from tests.conftest import NO_CONN


# --- CreateViewPreview ---------------------------------------------------------


def test_create_view_build() -> None:
    spec = {"schema": "public", "name": "active", "select": "SELECT id FROM c"}
    op = CreateViewPreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'CREATE VIEW "public"."active" AS\nSELECT id FROM c'}


def test_create_view_or_replace_and_columns() -> None:
    spec = {
        "schema": "public", "name": "active", "select": "SELECT 1, 2",
        "orReplace": True, "columns": ["a", "b"],
    }
    op = CreateViewPreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'CREATE OR REPLACE VIEW "public"."active" ("a", "b") AS\nSELECT 1, 2'}


def test_create_view_blank_schema_raises() -> None:
    with pytest.raises(ValidationError):
        CreateViewPreview(NO_CONN, {"schema": "", "name": "v", "select": "SELECT 1"})


def test_create_view_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        CreateViewPreview(NO_CONN, {"schema": "public", "name": "", "select": "SELECT 1"})


def test_create_view_blank_select_raises() -> None:
    with pytest.raises(ValidationError):
        CreateViewPreview(NO_CONN, {"schema": "public", "name": "v", "select": ""})


def test_create_view_get_result_before_build_raises() -> None:
    op = CreateViewPreview(NO_CONN, {"schema": "public", "name": "v", "select": "SELECT 1"})

    with pytest.raises(RuntimeError):
        op.get_result()


# --- DropViewPreview ------------------------------------------------------------


def test_drop_view_build() -> None:
    op = DropViewPreview(NO_CONN, {"schema": "public", "name": "v", "cascade": True})
    op.build()

    assert op.get_result() == {"sql": 'DROP VIEW "public"."v" CASCADE'}


def test_drop_view_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        DropViewPreview(NO_CONN, {"schema": "public", "name": ""})


# --- CreateMaterializedViewPreview ----------------------------------------------


def test_create_materialized_view_build() -> None:
    spec = {"schema": "public", "name": "mv", "select": "SELECT 1", "withData": False}
    op = CreateMaterializedViewPreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH NO DATA'}


def test_create_materialized_view_defaults_with_data() -> None:
    op = CreateMaterializedViewPreview(NO_CONN, {"schema": "public", "name": "mv", "select": "SELECT 1"})
    op.build()

    assert op.get_result() == {"sql": 'CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH DATA'}


def test_create_materialized_view_blank_select_raises() -> None:
    with pytest.raises(ValidationError):
        CreateMaterializedViewPreview(NO_CONN, {"schema": "public", "name": "mv", "select": "   "})


# --- DropMaterializedViewPreview -------------------------------------------------


def test_drop_materialized_view_build() -> None:
    op = DropMaterializedViewPreview(NO_CONN, {"schema": "public", "name": "mv"})
    op.build()

    assert op.get_result() == {"sql": 'DROP MATERIALIZED VIEW "public"."mv"'}


def test_drop_materialized_view_blank_schema_raises() -> None:
    with pytest.raises(ValidationError):
        DropMaterializedViewPreview(NO_CONN, {"schema": "", "name": "mv"})


# --- RefreshMaterializedViewPreview ----------------------------------------------


def test_refresh_materialized_view_build() -> None:
    spec = {"schema": "public", "name": "mv", "concurrently": True}
    op = RefreshMaterializedViewPreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'REFRESH MATERIALIZED VIEW CONCURRENTLY "public"."mv"'}


def test_refresh_materialized_view_with_no_data() -> None:
    spec = {"schema": "public", "name": "mv", "withNoData": True}
    op = RefreshMaterializedViewPreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": 'REFRESH MATERIALIZED VIEW "public"."mv" WITH NO DATA'}


def test_refresh_materialized_view_blank_name_raises() -> None:
    with pytest.raises(ValidationError):
        RefreshMaterializedViewPreview(NO_CONN, {"schema": "public", "name": ""})


# --- ReplaceMaterializedViewPreview ----------------------------------------------


def test_replace_materialized_view_build() -> None:
    spec = {"schema": "public", "name": "mv", "select": "SELECT 1"}
    op = ReplaceMaterializedViewPreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": (
        'DROP MATERIALIZED VIEW "public"."mv";\n'
        'CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH DATA'
    )}


def test_replace_materialized_view_cascade_and_no_data() -> None:
    spec = {"schema": "public", "name": "mv", "select": "SELECT 1", "cascade": True, "withData": False}
    op = ReplaceMaterializedViewPreview(NO_CONN, spec)
    op.build()

    assert op.get_result() == {"sql": (
        'DROP MATERIALIZED VIEW "public"."mv" CASCADE;\n'
        'CREATE MATERIALIZED VIEW "public"."mv" AS\nSELECT 1\nWITH NO DATA'
    )}


def test_replace_materialized_view_blank_select_raises() -> None:
    with pytest.raises(ValidationError):
        ReplaceMaterializedViewPreview(NO_CONN, {"schema": "public", "name": "mv", "select": ""})
