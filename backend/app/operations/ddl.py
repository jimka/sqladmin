"""
DDL preview/execute infrastructure shared by every DDL phase.

``DdlPreview`` is the base every phase's per-object preview op subclasses: it
honors the standard three-phase ``Operation`` contract (see ``base.py``),
letting a subclass build its SQL purely from its spec, or introspect first
when the preview needs to know existing state (e.g. an ALTER TABLE preview
reading a table's current columns).

``ExecuteDdlCommand`` is the single execute op every phase reuses: it runs
one final (possibly user-edited) DDL statement and returns the same status
envelope ``RunQueryCommand`` emits for a non-row statement, so the frontend's
``QueryStatusResult`` handling needs no DDL-specific branch.
"""

from __future__ import annotations

import asyncpg

from ..errors import ValidationError
from .base import Command, Query
from .run_query import _affected


class DdlPreview(Query):
    """
    Base for a DDL preview op: validate the spec in ``__init__`` (subclass
    responsibility), optionally read in ``apply()``, set ``self._sql`` via
    ``build()``, and return it from ``get_result()``.
    """

    def __init__(self) -> None:
        """
        Initialize with no SQL built yet; a subclass's own ``__init__``
        validates its spec before calling this.
        """
        self._sql: str | None = None

    async def apply(self) -> None:
        """
        Default: a pure preview needs no I/O, so this just calls ``build()``.
        A subclass whose preview must introspect first (e.g. an ALTER TABLE
        preview reading existing columns) overrides this to fetch, then calls
        ``self.build()``.
        """
        self.build()

    def build(self) -> None:
        """
        Set ``self._sql`` to the generated DDL.

        Raises:
            NotImplementedError: always — a subclass must implement this.
        """
        raise NotImplementedError

    def get_result(self) -> dict:
        """
        Raises:
            RuntimeError: if called before ``apply()``/``build()`` set ``_sql``.

        Returns:
            ``{"sql": self._sql}``.
        """
        if self._sql is None:
            raise RuntimeError("get_result() called before apply()/build()")

        return {"sql": self._sql}


class ExecuteDdlCommand(Command):
    """
    Run one final (possibly user-edited) DDL statement and return a status
    envelope. The single shared execute op every DDL phase reuses — no phase
    writes its own execute op.
    """

    def __init__(self, conn: asyncpg.Connection, sql: str) -> None:
        """
        Capture the statement, rejecting an empty one before any I/O (mirrors
        ``RunQueryCommand.__init__``).

        Args:
            conn: the connection the statement will run on.
            sql: the final DDL text to execute (exactly one statement).

        Raises:
            ValidationError: if the SQL is empty or whitespace-only.
        """
        if not sql or not sql.strip():
            raise ValidationError("Empty DDL statement")

        self._conn: asyncpg.Connection = conn
        self._sql: str = sql
        self._status: str | None = None

    async def apply(self) -> None:
        """
        Execute the statement inside a transaction, capturing its command
        status tag.
        """
        async with self._conn.transaction():
            self._status = await self._conn.execute(self._sql)

    def get_result(self) -> dict:
        """
        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            ``{"kind": "status", "command", "rowCount"}`` — the same status
            envelope ``RunQueryCommand`` emits, via the shared ``_affected``
            tag parser.
        """
        if self._status is None:
            raise RuntimeError("get_result() called before apply()")

        return {"kind": "status", "command": self._status or "", "rowCount": _affected(self._status)}
