"""
The CQRS operation contract.

Every endpoint's work is one operation object with a strict three-phase shape
that separates I/O from transformation for testability:

  * ``__init__`` takes ALL inputs — including the asyncpg connection — and
    validates them (identifier checks, clause compilation). An invalid request
    raises here, before any I/O.
  * ``apply()`` is the only async, I/O-bearing method. It executes against the
    connection and stores the raw driver result.
  * ``get_result()`` is sync and pure: it transforms the stored raw result into
    the response payload. Unit-testable by setting the raw result by hand.

There is deliberately no ``run()`` fusing the two — routes call them in sequence.
``CatalogQuery`` is the base every one-statement catalog read subclasses,
holding the connection/args/guard machinery so each subclass supplies only its
own ``_SQL`` and result transform.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, ClassVar

import asyncpg


class Operation:
    """
    Base class for a single backend unit of work (see module docstring).
    """

    async def apply(self) -> None:
        """
        Execute the operation's I/O and store the raw driver result.
        """
        raise NotImplementedError

    def get_result(self) -> object:
        """
        Purely transform the stored raw result into the response payload.
        """
        raise NotImplementedError


class Query(Operation):
    """
    A read. ``apply()`` runs SELECTs; no transaction.
    """


class Command(Operation):
    """
    A write. ``apply()`` wraps its statements in a transaction on the
    connection (``async with self._conn.transaction()``).
    """


class CatalogQuery(Query):
    """
    Base for a one-statement catalog read: ``__init__`` captures the
    connection and the arguments bound to ``_SQL``'s ``$1``, ``$2``, ... in
    order; the default ``apply()`` runs one ``fetch``; ``_rows()`` is the
    before-``apply()`` guard every subclass's ``get_result()`` calls instead
    of hand-writing its own.

    A subclass whose read is not one plain statement (a two-step read, or SQL
    built per call rather than a fixed ``_SQL``) overrides ``apply()`` and
    still stores its result into ``self._raw`` so ``_rows()`` keeps working.
    """

    _SQL: ClassVar[str] = ""

    def __init__(self, conn: asyncpg.Connection, *args: Any) -> None:
        """
        Capture the connection and the arguments bound to ``_SQL``'s ``$1``,
        ``$2``, ... in order.
        """
        self._conn: asyncpg.Connection = conn
        self._args: tuple[Any, ...] = args
        self._raw: Sequence[Mapping[str, Any]] | None = None

    async def apply(self) -> None:
        """
        Fetch ``_SQL`` bound to the captured arguments.
        """
        self._raw = await self._conn.fetch(self._SQL, *self._args)

    def _rows(self) -> Sequence[Mapping[str, Any]]:
        """
        Return the fetched rows.

        Raises:
            RuntimeError: if called before ``apply()``.

        Returns:
            The raw driver rows.
        """
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")

        return self._raw
