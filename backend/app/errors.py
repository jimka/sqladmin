"""
The backend's exception taxonomy. Operations raise these; a single FastAPI
exception handler (see ``main.py``) maps each to ``(status, {"detail": ...})``,
plus a ``"position"`` key when the error carries one (only the query panel's own
SQL does — see ``operations/common.py``'s ``client_sql_errors``). The frontend
consumes that one contract — as ``AjaxError`` for row CRUD, or off an ``api.ts``
catch for introspection. ``from_postgres_error`` is the one place a driver error
is given its status.
"""

from __future__ import annotations

import asyncpg


class DomainError(Exception):
    """
    Base for errors that map to a deterministic HTTP status + detail body.
    """

    status_code: int = 400

    def __init__(
        self, detail: str, headers: dict[str, str] | None = None, *, position: int | None = None
    ) -> None:
        """
        Store the human-readable detail used as the response body.

        Args:
            detail: the message returned to the client as ``{"detail": ...}``.
            headers: extra response headers to attach (e.g. ``Retry-After``).
            position: the 1-based character offset into the SQL the request
                body carried where Postgres reported the error, returned as
                ``{"position": ...}``; None (the default) omits the key.
        """
        super().__init__(detail)

        self.detail: str = detail
        self.headers: dict[str, str] | None = headers
        self.position: int | None = position


class ValidationError(DomainError):
    """
    Bad identifier / param / filter — raised in operation constructors,
    before any I/O.
    """

    status_code: int = 422


class NotFound(DomainError):
    """
    A PK miss on update/delete, or an unknown connection/table.
    """

    status_code: int = 404


class BadRequest(DomainError):
    """
    The server rejected the request and it is not a conflict — the status
    ``from_postgres_error`` gives every non-integrity Postgres error.
    """

    status_code: int = 400


class ConflictError(DomainError):
    """
    Integrity / unique violation surfaced from the database — the status
    ``from_postgres_error`` gives one when Postgres reports it.
    """

    status_code: int = 409


class Unauthorized(DomainError):
    """
    Missing/invalid session, or Postgres rejected the supplied credentials
    (bad password, unreachable host, or nonexistent target database).
    """

    status_code: int = 401


class Forbidden(DomainError):
    """
    CSRF check failed, or the requested host is not in the allowlist.
    """

    status_code: int = 403


class TooManyRequests(DomainError):
    """
    The login rate limit was exceeded (see ``rate_limit.py``).
    """

    status_code: int = 429


def from_postgres_error(exc: asyncpg.PostgresError, position: int | None = None) -> DomainError:
    """
    Translate a driver error into the typed taxonomy: an integrity/unique
    violation is a conflict, anything else the server rejected is a bad request.

    Shared by ``main.py``'s route-agnostic driver-error handler and the
    operations' ``client_sql_errors``, so the status rule lives in one place.

    Args:
        exc: the error asyncpg raised.
        position: the 1-based offset into the client's SQL to attach, or None.

    Returns:
        A ``ConflictError`` or ``BadRequest`` carrying the driver's message.
    """
    if isinstance(exc, asyncpg.exceptions.IntegrityConstraintViolationError):
        return ConflictError(str(exc), position=position)

    return BadRequest(str(exc), position=position)
