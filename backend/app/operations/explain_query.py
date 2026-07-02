"""
ExplainQueryCommand — run EXPLAIN / EXPLAIN ANALYZE for one arbitrary SQL
statement and return its query plan as a dedicated ``{kind:"explain"}`` envelope.

EXPLAIN is the user's own SQL with an ``EXPLAIN (…)`` prefix, so it inherits the
query path's single-statement, opaque-SQL contract (see RunQueryCommand). The one
hazard is ANALYZE: it *executes* the statement, so ``EXPLAIN ANALYZE UPDATE …``
really performs the write. To keep an "explain" action side-effect-free, the
ANALYZE path runs inside an explicitly rolled-back transaction — the plan is
captured, then a sentinel exception forces asyncpg to roll the transaction back,
discarding any DML/DDL side-effect even if the frontend read-only guard is
bypassed. Plain EXPLAIN only plans and never executes, so it needs no rollback.
"""

from __future__ import annotations

import json
from typing import Any, Sequence

import asyncpg

from ..errors import ValidationError
from .base import Command

# The EXPLAIN output formats this operation accepts. TEXT is the human-readable
# indented plan (the first cut); JSON is the structured tree the follow-on
# plan-tree view consumes. Mirrors the frontend ExplainFormat union.
_SUPPORTED_FORMATS: frozenset[str] = frozenset({"text", "json"})


class _ExplainDone(Exception):
    """
    Sentinel raised after the ANALYZE plan is captured to force the surrounding
    transaction to roll back, discarding the analyzed statement's side-effects.
    """


class ExplainQueryCommand(Command):
    """
    Run EXPLAIN / EXPLAIN ANALYZE for one statement and return its plan.
    """

    def __init__(self, conn: asyncpg.Connection, sql: str, analyze: bool, fmt: str) -> None:
        """
        Capture the statement and options, rejecting invalid input before any I/O.

        Args:
            conn: the connection the EXPLAIN will run on.
            sql: the raw SQL to explain (exactly one statement).
            analyze: whether to EXPLAIN ANALYZE (executes the statement, then
                rolls back) rather than plain EXPLAIN (plans only).
            fmt: the EXPLAIN output format, ``"text"`` or ``"json"``.

        Raises:
            ValidationError: if the SQL is empty/whitespace-only, or the format
                is not one of the supported values.
        """
        if not sql or not sql.strip():
            raise ValidationError("Empty SQL statement")

        if fmt not in _SUPPORTED_FORMATS:
            raise ValidationError(f"Unsupported EXPLAIN format: {fmt}")

        self._conn: asyncpg.Connection = conn
        self._sql: str = sql
        self._analyze: bool = analyze
        self._fmt: str = fmt
        self._plan: Sequence[Any] | None = None

    async def apply(self) -> None:
        """
        Run the EXPLAIN and capture its plan rows.

        The ANALYZE path executes the statement inside a transaction, captures the
        plan, then raises ``_ExplainDone`` so asyncpg rolls the transaction back —
        the plan survives on ``self._plan`` but any write is discarded. Plain
        EXPLAIN only plans, so it runs directly with no rollback dance.
        """
        options = ("ANALYZE, " if self._analyze else "") + f"FORMAT {self._fmt.upper()}"
        stmt    = f"EXPLAIN ({options}) {self._sql}"

        if self._analyze:
            # ANALYZE executes the statement — capture the plan, then force a
            # rollback so any DML/DDL side-effect is discarded (safety net even if
            # the frontend read-only guard is bypassed).
            try:
                async with self._conn.transaction():
                    self._plan = await self._conn.fetch(stmt)

                    raise _ExplainDone()
            except _ExplainDone:
                pass
        else:
            # Plain EXPLAIN only plans — no execution, no side-effect, no rollback.
            self._plan = await self._conn.fetch(stmt)

        if self._fmt == "json" and self._plan:
            # asyncpg returns EXPLAIN (FORMAT JSON) as a single JSON-text cell (the
            # pool registers no json codec), so decode it here — get_result() then
            # passes a real plan tree through, not the raw text. A dict/list cell
            # (already codec-decoded) passes through json.loads-free.
            cell = self._plan[0][0]
            tree = json.loads(cell) if isinstance(cell, str) else cell
            self._plan = [(tree,)]

    def get_result(self) -> dict:
        """
        Shape the captured plan into the ``{kind:"explain"}`` response envelope.

        FORMAT TEXT returns one plan line per row, joined into a single ``plan``
        string; FORMAT JSON returns a single row whose one column is the plan
        tree, passed through unchanged as ``planJson``.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``{"kind":"explain","format","analyze","plan"}`` for FORMAT TEXT, plus
            a ``planJson`` tree for FORMAT JSON.
        """
        if self._plan is None:
            raise RuntimeError("get_result() called before apply()")

        if self._fmt == "json":
            tree = self._plan[0][0] if self._plan else None

            return {"kind": "explain", "format": "json", "analyze": self._analyze,
                    "plan": "", "planJson": tree}

        text = "\n".join(row[0] for row in self._plan)

        return {"kind": "explain", "format": "text", "analyze": self._analyze, "plan": text}
