"""
Shared catalog SQL fragments, catalog-code maps, and pure row-to-payload
mappers used by several catalog-read query families (edges, indexes,
constraints, foreign keys, columns) instead of each family carrying its own
copy — see the plan's Architecture Decisions for why this lives in its own
module rather than ``common.py`` (scoped to the row-write path).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from ..contract import ColumnMeta, SequenceRef
from ..wire import pg_type_to_wire

# Excluded from every schema/database-wide query (graph.py's five queries)
# and from ListSchemasQuery's own listing. Shared by every module that used
# to keep its own copy of this same catalog-scoping constant (list_schemas.py,
# graph.py) — the edge queries (list_inheritance.py, list_dependencies.py)
# are schema-scoped, not schema/database-wide, and do not reference it.
SYSTEM_SCHEMAS: tuple[str, ...] = ("pg_catalog", "information_schema")

# pg_class.relkind -> the contract DbObjectKind. Partitioned ('p') and foreign
# ('f') tables collapse to "table"; fixed by the catalog format. Deliberately
# omits 'I'/'i' (partitioned index / index) — an edge whose endpoint carries
# either code is dropped by edge_rows() rather than mapped, since a diagram
# has no node kind for an index.
RELKIND_KIND: dict[str, str] = {"r": "table", "p": "table", "f": "table", "v": "view", "m": "materializedView"}

# The map's own keys, bound as a query parameter so the SQL filter that keeps
# an edge query from fetching an unmappable relkind can never fall out of step
# with the map edge_rows() shapes against.
RELKIND_CODES: tuple[str, ...] = tuple(RELKIND_KIND)

# Map the single-char referential-action codes Postgres stores in
# ``pg_constraint.confupdtype``/``confdeltype`` to the SQL clause they render as.
# These five codes are fixed by the catalog format, not tunable.
FK_ACTIONS: dict[str, str] = {
    "a": "NO ACTION",
    "r": "RESTRICT",
    "c": "CASCADE",
    "n": "SET NULL",
    "d": "SET DEFAULT",
}

# Map the ``pg_constraint.contype`` code for the non-FK constraint kinds these
# queries surface to the contract's constraint-type string. Fixed by the catalog.
CONSTRAINT_TYPES: dict[str, str] = {
    "p": "primaryKey",
    "u": "unique",
    "c": "check",
}

# Every caller binds $1 = schema (or NULL for "every schema") and $2 = relation
# name (or NULL for "every relation"); a fragment needing a third key defines
# it (INDEX_FROM's $3 index-name scope), and each caller may add further
# parameters of its own after the fragment's own — see the plan's "Every
# shared SQL fragment binds $1 = schema and $2 = relation name".

INDEX_SELECT = """
    i.indexname     AS name,
    i.indexdef      AS definition,
    ix.indisunique  AS unique,
    ix.indisprimary AS primary
"""

INDEX_FROM = """
    FROM pg_indexes i
    JOIN pg_class ic     ON ic.relname = i.indexname
    JOIN pg_namespace n  ON n.oid = ic.relnamespace
    JOIN pg_index ix     ON ix.indexrelid = ic.oid
    WHERE n.nspname = i.schemaname
      AND ($1::text IS NULL OR i.schemaname = $1)
      AND ($2::text IS NULL OR i.tablename  = $2)
      AND ($3::text IS NULL OR i.indexname  = $3)
"""

CONSTRAINT_SELECT = """
    con.conname AS name,
    con.contype::text AS contype,
    pg_get_constraintdef(con.oid) AS definition,
    ARRAY(
        SELECT a.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord
    ) AS columns
"""

CONSTRAINT_FROM = """
    FROM pg_constraint con
    JOIN pg_class c     ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype IN ('p', 'u', 'c')
      AND ($1::text IS NULL OR n.nspname = $1)
      AND ($2::text IS NULL OR c.relname = $2)
"""

FOREIGN_KEY_SELECT = """
    con.conname AS name,
    con.confupdtype::text AS on_update,
    con.confdeltype::text AS on_delete,
    nr.nspname AS ref_schema,
    cr.relname AS ref_table,
    ARRAY(
        SELECT a.attname
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord
    ) AS columns,
    ARRAY(
        SELECT a.attname
        FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
        ORDER BY k.ord
    ) AS ref_columns
"""

FOREIGN_KEY_FROM = """
    FROM pg_constraint con
    JOIN pg_class c      ON c.oid = con.conrelid
    JOIN pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_class cr     ON cr.oid = con.confrelid
    JOIN pg_namespace nr ON nr.oid = cr.relnamespace
    WHERE con.contype = 'f'
      AND ($1::text IS NULL OR n.nspname = $1)
      AND ($2::text IS NULL OR c.relname = $2)
"""


def index_payload(row: Mapping[str, Any]) -> dict:
    """
    Map one ``INDEX_SELECT`` row to its contract payload.

    Args:
        row: a row carrying ``INDEX_SELECT``'s columns.

    Returns:
        ``{name, definition, unique, primary}``.
    """
    return {
        "name": row["name"],
        "definition": row["definition"],
        "unique": bool(row["unique"]),
        "primary": bool(row["primary"]),
    }


def constraint_payload(row: Mapping[str, Any]) -> dict:
    """
    Map one ``CONSTRAINT_SELECT`` row to its contract payload.

    Args:
        row: a row carrying ``CONSTRAINT_SELECT``'s columns.

    Returns:
        ``{name, type, columns, definition}``, ``type`` mapped through
        ``CONSTRAINT_TYPES``.
    """
    return {
        "name": row["name"],
        "type": CONSTRAINT_TYPES[row["contype"]],
        "columns": list(row["columns"]),
        "definition": row["definition"],
    }


def foreign_key_payload(row: Mapping[str, Any]) -> dict:
    """
    Map one ``FOREIGN_KEY_SELECT`` row to its contract payload.

    Args:
        row: a row carrying ``FOREIGN_KEY_SELECT``'s columns.

    Returns:
        ``{name, columns, refSchema, refTable, refColumns, onUpdate,
        onDelete}``, the action codes mapped through ``FK_ACTIONS``.
    """
    return {
        "name": row["name"],
        "columns": list(row["columns"]),
        "refSchema": row["ref_schema"],
        "refTable": row["ref_table"],
        "refColumns": list(row["ref_columns"]),
        "onUpdate": FK_ACTIONS[row["on_update"]],
        "onDelete": FK_ACTIONS[row["on_delete"]],
    }


def _endpoint(row: Mapping[str, Any], side: str) -> dict:
    """
    Build one edge endpoint (``source`` or ``target``) from a row carrying
    ``{side}_schema``/``{side}_name``/``{side}_kind`` columns.

    Args:
        row: one edge row, source/target-prefixed.
        side: ``"source"`` or ``"target"``.

    Returns:
        ``{"schema": str, "name": str, "kind": str}``, ``kind`` mapped through
        ``RELKIND_KIND``.
    """
    return {
        "schema": row[f"{side}_schema"],
        "name": row[f"{side}_name"],
        "kind": RELKIND_KIND[row[f"{side}_kind"]],
    }


def edge_rows(rows: Sequence[Mapping[str, Any]]) -> list[dict]:
    """
    Shape a set of source/target-prefixed edge rows into the contract's
    directed-edge list, dropping any row whose either endpoint carries a
    relkind outside ``RELKIND_KIND`` (e.g. a partitioned index's own child
    index, code ``I``/``i``) instead of raising ``KeyError``.

    Args:
        rows: rows carrying ``source_schema``/``source_name``/``source_kind``
            and the ``target_*`` equivalents.

    Returns:
        ``[{"source": {schema, name, kind}, "target": {schema, name, kind}}]``,
        one entry per row whose relkinds both map.
    """
    return [
        {"source": _endpoint(r, "source"), "target": _endpoint(r, "target")}
        for r in rows
        if r["source_kind"] in RELKIND_KIND and r["target_kind"] in RELKIND_KIND
    ]


COLUMN_SELECT = """
    c.column_name AS name,
    c.data_type   AS data_type,
    COALESCE(att.full_type, c.data_type) AS full_type,
    c.column_default AS default_expr,
    (c.is_nullable = 'YES') AS nullable,
    COALESCE(
        c.is_identity = 'YES'
        OR c.is_generated = 'ALWAYS'
        OR c.column_default LIKE 'nextval(%',
        false
    ) AS is_generated,
    (c.column_default IS NOT NULL) AS has_default,
    COALESCE(pk.is_pk, false) AS is_primary_key,
    seq.sequence_schema AS sequence_schema,
    seq.sequence_name   AS sequence_name
"""

# The backing-sequence sub-select (`seq`) unions the two DISTINCT ways a column
# can be tied to a sequence. The two arms have OPPOSITE join orientations,
# which is the easiest thing here to get wrong:
#
#   Arm (a) OWNED BY (serial, GENERATED ... AS IDENTITY): the SEQUENCE is
#     the dependent object, so it is d.objid and the column is d.refobjid.
#   Arm (b) DEFAULT nextval(...): the ATTRDEF is the dependent object, so
#     the SEQUENCE is the REFERENCED side (d.refobjid) instead.
#
# Writing arm (b) with arm (a)'s orientation returns zero rows — and still
# looks correct for serial/identity columns, which arm (a) covers.
COLUMN_FROM = """
    FROM information_schema.columns c
    LEFT JOIN (
        SELECT tc.table_schema, tc.table_name, kcu.column_name, true AS is_pk
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema    = tc.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND ($1::text IS NULL OR tc.table_schema = $1)
          AND ($2::text IS NULL OR tc.table_name   = $2)
    ) pk ON pk.table_schema = c.table_schema
        AND pk.table_name   = c.table_name
        AND pk.column_name  = c.column_name
    -- The declared type WITH its modifier (information_schema.columns.data_type
    -- is the SQL-standard type name only, e.g. "character varying" for a
    -- varchar(60) column) — format_type() over pg_attribute is the only
    -- source for the modifier, so this is a second self-join on the same
    -- table/column, independent of the `seq` sub-select below.
    LEFT JOIN (
        SELECT an.nspname AS ref_schema,
               ac.relname AS ref_table,
               a.attname  AS column_name,
               format_type(a.atttypid, a.atttypmod) AS full_type
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class ac     ON ac.oid = a.attrelid
        JOIN pg_catalog.pg_namespace an ON an.oid = ac.relnamespace
        WHERE a.attnum > 0 AND NOT a.attisdropped
          AND ($1::text IS NULL OR an.nspname = $1)
          AND ($2::text IS NULL OR ac.relname = $2)
    ) att ON att.ref_schema  = c.table_schema
         AND att.ref_table   = c.table_name
         AND att.column_name = c.column_name
    LEFT JOIN (
        SELECT DISTINCT ON (rn.nspname, rc.relname, l.attnum)
               rn.nspname AS ref_schema,
               rc.relname AS ref_table,
               a.attname  AS column_name,
               sn.nspname AS sequence_schema,
               s.relname  AS sequence_name
        FROM (
            -- Arm (a): the sequence is OWNED BY the column.
            SELECT d.refobjid AS attrelid, d.refobjsubid AS attnum, d.objid AS seqid, 1 AS arm
            FROM pg_catalog.pg_depend d
            WHERE d.classid = 'pg_class'::regclass
              AND d.refclassid = 'pg_class'::regclass
              AND d.deptype IN ('a', 'i')
              AND d.refobjsubid > 0
            UNION ALL
            -- Arm (b): the column's DEFAULT calls nextval() on the sequence.
            SELECT ad.adrelid, ad.adnum, d.refobjid, 2
            FROM pg_catalog.pg_depend d
            JOIN pg_catalog.pg_attrdef ad ON ad.oid = d.objid
            WHERE d.classid = 'pg_attrdef'::regclass
              AND d.refclassid = 'pg_class'::regclass
              AND d.deptype = 'n'
        ) l
        -- relkind='S' is load-bearing, not cosmetic: arm (b)'s
        -- refclassid='pg_class' ALSO matches a generated-STORED column's
        -- references to its own table's columns, which would otherwise be
        -- reported as that column's "sequence".
        JOIN pg_catalog.pg_class s      ON s.oid = l.seqid AND s.relkind = 'S'
        JOIN pg_catalog.pg_namespace sn ON sn.oid = s.relnamespace
        JOIN pg_catalog.pg_class rc     ON rc.oid = l.attrelid
        JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
        JOIN pg_catalog.pg_attribute a  ON a.attrelid = l.attrelid AND a.attnum = l.attnum
        WHERE ($1::text IS NULL OR rn.nspname = $1)
          AND ($2::text IS NULL OR rc.relname = $2)
        -- arm DESC: a DEFAULT (arm 2) beats an OWNED BY (arm 1) when the two
        -- disagree — the DEFAULT is what actually supplies the value at
        -- INSERT. The trailing name sort makes a same-arm tie deterministic
        -- (a column can own two sequences, or default from two).
        ORDER BY rn.nspname, rc.relname, l.attnum, l.arm DESC, sn.nspname, s.relname
    ) seq ON seq.ref_schema  = c.table_schema
         AND seq.ref_table   = c.table_name
         AND seq.column_name = c.column_name
    WHERE ($1::text IS NULL OR c.table_schema = $1)
      AND ($2::text IS NULL OR c.table_name   = $2)
"""


def column_meta(row: Mapping[str, Any]) -> ColumnMeta:
    """
    Map one ``COLUMN_SELECT`` row to a typed ``ColumnMeta``.

    Args:
        row: a row carrying ``COLUMN_SELECT``'s columns.

    Returns:
        The column's typed metadata, with its wire type derived from
        ``data_type``.
    """
    return ColumnMeta(
        name=row["name"],
        data_type=row["data_type"],
        nullable=row["nullable"],
        is_primary_key=row["is_primary_key"],
        is_generated=row["is_generated"],
        has_default=row["has_default"],
        wire_type=pg_type_to_wire(row["data_type"]),
        full_type=row["full_type"],
        default_expr=row["default_expr"],
        sequence=(
            SequenceRef(schema=row["sequence_schema"], name=row["sequence_name"])
            if row["sequence_schema"] is not None
            else None
        ),
    )
