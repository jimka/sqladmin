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

_COMPARATORS = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}


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
        Capture the filter descriptors and the legal identifier set.
        """
        self._filters: list[dict] = filters or []
        self._allowed: set[str] = {c.name for c in columns}
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

    def _ident(self, field: str) -> str:
        """
        Validate a field against the column set and return its quoted form.

        Raises:
            ValidationError: if the field is not a known column.
        """
        if field not in self._allowed:
            raise ValidationError(f"Unknown filter column '{field}'")

        return quote_ident(field)

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
            return f"{self._ident(f['field'])} {_COMPARATORS[t]} {self._bind(f['value'])}"

        if t in ("contains", "startsWith"):
            col = self._ident(f["field"])
            pattern = _escape_like(str(f["value"]))
            pattern = pattern + "%" if t == "startsWith" else f"%{pattern}%"
            op = "LIKE" if f.get("caseSensitive") else "ILIKE"

            return f"{col} {op} {self._bind(pattern)} ESCAPE '\\'"

        if t == "in":
            return f"{self._ident(f['field'])} = ANY({self._bind(list(f['values']))})"

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
