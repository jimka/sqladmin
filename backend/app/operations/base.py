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
"""

from __future__ import annotations


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
