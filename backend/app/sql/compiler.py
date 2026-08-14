"""
Pure SQL-fragment compilers for the proxy's sort/filter JSON.

Values are NEVER interpolated — they are bound as positional ``$n`` parameters.
Identifiers cannot be parameterized in any driver, so they are validated against
the introspected column set (the only legal identifiers) and double-quoted as
defense-in-depth. Everything here is a pure function of (descriptor, columns) —
no database, trivially unit-testable.
"""

from __future__ import annotations

from typing import Any

from ..contract import ColumnMeta
from ..errors import ValidationError
from ..wire import from_wire_filter_operand

_COMPARATORS = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
# A `date` column is compared against an instant rather than truncated to a
# day -- see `from_wire_filter_operand`. The cast also pins the bound
# parameter's type, which a bare `"day" >= $1` would infer as `date`.
_INSTANT_CAST_TYPES = frozenset({"date"})


def quote_ident(name: str) -> str:
    """
    Double-quote an identifier, escaping any embedded double-quote.
    """
    return '"' + str(name).replace('"', '""') + '"'


def _escape_like(s: str) -> str:
    """
    Escape LIKE/ILIKE wildcards so a filter value matches literally.
    """
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class OrderCompiler:
    """
    ``SortDescriptor[]`` -> ``ORDER BY`` clause (or '' when empty).
    """

    def __init__(self, sort: list[dict] | None, columns: list[ColumnMeta]) -> None:
        """
        Capture the sort descriptors and the legal identifier set.
        """
        self._sort: list[dict] = sort or []
        self._allowed: set[str] = {c.name for c in columns}

    def compile(self) -> str:
        """
        Build the ``ORDER BY`` clause.

        Raises:
            ValidationError: if a sort field is not a known column.

        Returns:
            The ``ORDER BY`` clause, or '' when there are no sorters.
        """
        parts = []

        for s in self._sort:
            field = s.get("field")

            if field not in self._allowed:
                raise ValidationError(f"Unknown sort column '{field}'")

            direction = "DESC" if str(s.get("dir", "asc")).lower() == "desc" else "ASC"
            parts.append(f"{quote_ident(field)} {direction}")

        return ("ORDER BY " + ", ".join(parts)) if parts else ""


class FilterCompiler:
    """
    ``FilterDescriptor[]`` -> ``(where_clause, params)``.

    The top-level list is an implicit AND. ``params`` is a positional list ready
    to splat into ``conn.fetch``; ``where_clause`` is '' or ``WHERE ...``.
    """

    def __init__(self, filters: list[dict] | None, columns: list[ColumnMeta]) -> None:
        """
        Capture the filter descriptors and the legal column set.
        """
        self._filters: list[dict] = filters or []
        self._columns: dict[str, ColumnMeta] = {c.name: c for c in columns}
        self._params: list[Any] = []

    def compile(self) -> tuple[str, list[Any]]:
        """
        Compile all descriptors into a WHERE clause and its bound params.

        Raises:
            ValidationError: if a filter identifier or type is invalid.

        Returns:
            ``(where_clause, params)`` — the clause is '' or ``WHERE ...``.
        """
        clauses = [c for c in (self._node(f) for f in self._filters) if c]
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""

        return where, self._params

    def _bind(self, value: Any) -> str:
        """
        Append a value to the bind list and return its ``$n`` placeholder.
        """
        self._params.append(value)

        return f"${len(self._params)}"

    def _meta(self, field: str) -> ColumnMeta:
        """
        Validate a field against the column set and return its metadata.

        Raises:
            ValidationError: if the field is not a known column.
        """
        column = self._columns.get(field)

        if column is None:
            raise ValidationError(f"Unknown filter column '{field}'")

        return column

    def _ident(self, field: str) -> str:
        """
        Validate a field against the column set and return its quoted form.

        Raises:
            ValidationError: if the field is not a known column.
        """
        return quote_ident(self._meta(field).name)

    def _operand(self, field: str, value: Any) -> Any:
        """
        The Python value to bind for a comparison against ``field``.

        Raises:
            ValidationError: if the field is unknown, or the operand cannot be
                mapped to the column's type.
        """
        column = self._meta(field)

        try:
            return from_wire_filter_operand(value, column)
        except (ValueError, TypeError) as e:
            raise ValidationError(f"Invalid filter value for column '{field}': {e}")

    def _instant_cast(self, field: str) -> str:
        """
        The cast that makes a `date` column comparable to a filter operand's
        full instant, or '' for every other column.
        """
        return "::timestamp" if self._meta(field).data_type.lower() in _INSTANT_CAST_TYPES else ""

    def _column(self, field: str, values: list[Any]) -> str:
        """
        The column expression to compare against. A text operand can only have
        come from a string-typed model field, whose Postgres type may be text,
        varchar, char, uuid, or numeric -- comparing the column's text form
        makes every one of those valid.
        """
        ident = self._ident(field)

        return ident + "::text" if values and all(isinstance(v, str) for v in values) else ident

    def _node(self, f: dict) -> str:
        """
        Compile one filter descriptor (recursing into composites) to SQL.

        Raises:
            ValidationError: on an unknown identifier or unsupported filter type.

        Returns:
            The SQL fragment, or '' for an empty composite.
        """
        t = f.get("type")

        if t in _COMPARATORS:
            field = f["field"]
            value = self._operand(field, f["value"])
            col = self._column(field, [value]) + self._instant_cast(field)

            return f"{col} {_COMPARATORS[t]} {self._bind(value)}"

        if t in ("contains", "startsWith", "endsWith"):
            # A LIKE/ILIKE operand is a string by construction, so this branch
            # always casts, regardless of the column's own wire type.
            col = self._ident(f["field"]) + "::text"
            pattern = _escape_like(str(f["value"]))
            pattern = {"startsWith": pattern + "%", "endsWith": "%" + pattern}.get(t, f"%{pattern}%")
            op = "LIKE" if f.get("caseSensitive") else "ILIKE"

            return f"{col} {op} {self._bind(pattern)} ESCAPE '\\'"

        if t == "in":
            values = list(f["values"])
            concrete = [v for v in values if v is not None]
            has_null = len(concrete) < len(values)
            col = self._column(f["field"], concrete)

            if not concrete:
                return f"{col} IS NULL" if has_null else "FALSE"

            any_clause = f"{col} = ANY({self._bind(concrete)})"

            return f"({col} IS NULL OR {any_clause})" if has_null else any_clause

        if t in ("and", "or"):
            parts = [p for p in (self._node(c) for c in f["filters"]) if p]

            if not parts:
                return ""

            joiner = " AND " if t == "and" else " OR "

            return "(" + joiner.join(parts) + ")"

        if t == "not":
            inner = self._node(f["filter"])

            return f"NOT ({inner})" if inner else ""

        raise ValidationError(f"Unsupported filter type '{t}'")
