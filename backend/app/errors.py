"""
The backend's exception taxonomy. Operations raise these; a single FastAPI
exception handler (see ``main.py``) maps each to ``(status, {"detail": ...})``.
The frontend consumes that one contract — as ``AjaxError`` for row CRUD, or off
an ``api.ts`` catch for introspection.
"""

from __future__ import annotations


class DomainError(Exception):
    """
    Base for errors that map to a deterministic HTTP status + detail body.
    """

    status_code: int = 400

    def __init__(self, detail: str) -> None:
        """
        Store the human-readable detail used as the response body.

        Args:
            detail: the message returned to the client as ``{"detail": ...}``.
        """
        super().__init__(detail)

        self.detail: str = detail


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


class ConflictError(DomainError):
    """
    Integrity / unique violation surfaced from the database.
    """

    status_code: int = 409
