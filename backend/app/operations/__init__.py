"""
CQRS operation handlers — one operation per module, aggregated here so call
sites import from ``app.operations`` regardless of file layout.
"""

from .base import Command, Operation, Query
from .ddl import DdlPreview, ExecuteDdlCommand
from .ddl_function_type import (
    AlterTypeAddValuePreview,
    CreateCompositeTypePreview,
    CreateEnumTypePreview,
    CreateFunctionPreview,
    DropFunctionPreview,
    DropTypePreview,
)
from .ddl_schema_sequence import (
    SchemaCreatePreview,
    SchemaDropPreview,
    SchemaRenamePreview,
    SequenceAlterPreview,
    SequenceCreatePreview,
    SequenceDropPreview,
    SequenceOwnerPreview,
)
from .ddl_table import (
    PreviewAlterTable,
    PreviewConstraint,
    PreviewCreateTable,
    PreviewDropTable,
    PreviewIndex,
)
from .ddl_view import (
    CreateMaterializedViewPreview,
    CreateViewPreview,
    DropMaterializedViewPreview,
    DropViewPreview,
    RefreshMaterializedViewPreview,
    ReplaceMaterializedViewPreview,
)
from .delete_row import DeleteRowCommand
from .explain_query import ExplainQueryCommand
from .export_rows import ExportRowsQuery
from .function_definition import FunctionDefinitionQuery
from .insert_row import InsertRowCommand
from .list_columns import ListColumnsQuery
from .list_databases import ListDatabasesQuery
from .list_dependencies import ListDependenciesQuery
from .list_functions import ListFunctionsQuery
from .list_inheritance import ListInheritanceQuery
from .list_objects import ListObjectsQuery
from .list_rows import ListRowsQuery
from .list_schemas import ListSchemasQuery
from .list_types import ListTypesQuery
from .role_detail import RoleAttributesQuery, RoleMembershipsQuery, RolePrivilegesQuery
from .roles import ListRolesQuery
from .run_query import RunQueryCommand
from .sequence_detail import SequenceDetailQuery
from .table_privileges import TablePrivilegesQuery
from .table_structure import (
    ListConstraintsQuery,
    ListForeignKeysQuery,
    ListIndexesQuery,
)
from .type_definition import TypeDefinitionQuery
from .update_row import UpdateRowCommand
from .view_definition import ViewDefinitionQuery

__all__ = [
    "Operation",
    "Query",
    "Command",
    "ListDatabasesQuery",
    "ListSchemasQuery",
    "ListObjectsQuery",
    "ListColumnsQuery",
    "TablePrivilegesQuery",
    "ListRowsQuery",
    "ListDependenciesQuery",
    "ListInheritanceQuery",
    "ListFunctionsQuery",
    "ListTypesQuery",
    "ListRolesQuery",
    "RoleAttributesQuery",
    "RoleMembershipsQuery",
    "RolePrivilegesQuery",
    "ListIndexesQuery",
    "ListConstraintsQuery",
    "ListForeignKeysQuery",
    "InsertRowCommand",
    "UpdateRowCommand",
    "DeleteRowCommand",
    "RunQueryCommand",
    "ViewDefinitionQuery",
    "ExportRowsQuery",
    "ExplainQueryCommand",
    "DdlPreview",
    "ExecuteDdlCommand",
    "PreviewCreateTable",
    "PreviewDropTable",
    "PreviewAlterTable",
    "PreviewConstraint",
    "PreviewIndex",
    "CreateViewPreview",
    "DropViewPreview",
    "CreateMaterializedViewPreview",
    "DropMaterializedViewPreview",
    "RefreshMaterializedViewPreview",
    "ReplaceMaterializedViewPreview",
    "SchemaCreatePreview",
    "SchemaDropPreview",
    "SchemaRenamePreview",
    "SequenceCreatePreview",
    "SequenceAlterPreview",
    "SequenceOwnerPreview",
    "SequenceDropPreview",
    "SequenceDetailQuery",
    "FunctionDefinitionQuery",
    "TypeDefinitionQuery",
    "CreateFunctionPreview",
    "DropFunctionPreview",
    "CreateEnumTypePreview",
    "CreateCompositeTypePreview",
    "DropTypePreview",
    "AlterTypeAddValuePreview",
]
