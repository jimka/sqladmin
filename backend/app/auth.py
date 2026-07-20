"""
Authentication: the host allowlist, the request dependencies that resolve/guard
a session, and the ``login``/``logout``/``whoami`` route handlers.

Authn is "can you open a Postgres connection with these credentials" and authz is
the Postgres role's own grants — there is no app-level user store. A successful
login opens a per-session pool (see ``connections.py``), sets an opaque
``HttpOnly`` cookie, and returns a CSRF synchronizer token the frontend echoes on
mutating requests.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

import asyncpg
from fastapi import Body, Depends, Request, Response

from .config import parse_bool
from .connections import (
    ConnParts,
    Session,
    close_session,
    create_session,
    get_session,
)
from .errors import Forbidden, Unauthorized, ValidationError

_logger = logging.getLogger(__name__)

# Name of the opaque server-side session cookie.
SESSION_COOKIE_NAME = "sqladmin_session"

# Env var holding the comma-separated allowlist of dial-able ``host`` /
# ``host:port`` targets. Unset/empty means deny all (default-deny).
_ALLOWED_HOSTS_ENV = "SQLADMIN_ALLOWED_HOSTS"

# Header carrying the CSRF synchronizer token on mutating requests.
_CSRF_HEADER = "X-CSRF-Token"

# The login-body keys that must be present (``connectionId`` is optional).
_REQUIRED_LOGIN_KEYS = ("host", "port", "database", "username", "password")

# Default client-facing connection label when the login omits one.
_DEFAULT_CONNECTION_ID = "default"

# Env var controlling the session cookie's `Secure` attribute:
# "auto" (default) derives it from the request scheme; an explicit
# true/false value overrides.
_COOKIE_SECURE_ENV = "SQLADMIN_COOKIE_SECURE"

# The value meaning "derive from the request scheme".
_COOKIE_SECURE_AUTO = "auto"


def allowed_hosts() -> set[str]:
    """
    Parse ``SQLADMIN_ALLOWED_HOSTS`` into a normalized set.

    Each comma-separated entry is stripped and lowercased; an unset or empty var
    yields the empty set (default-deny).

    Returns:
        The set of allowed ``host`` and/or ``host:port`` strings.
    """
    raw = os.environ.get(_ALLOWED_HOSTS_ENV, "")

    return {entry.strip().lower() for entry in raw.split(",") if entry.strip()}


def is_host_allowed(host: str, port: int) -> bool:
    """
    Whether ``(host, port)`` is permitted by the allowlist.

    Both the bare ``host`` and the ``host:port`` form are accepted, so an
    operator can allow every port on a host or pin a single one. The supplied
    host is lowercased before matching (the allowlist already is).

    Returns:
        True if the target may be dialed.
    """
    allowed = allowed_hosts()
    host_lower = host.lower()

    return host_lower in allowed or f"{host_lower}:{port}" in allowed


def cookie_secure(request: Request) -> bool:
    """
    Whether the session cookie is set with the `Secure` attribute.

    ``SQLADMIN_COOKIE_SECURE`` defaults to ``auto``, which derives the flag from
    the request's scheme (``https`` -> secure). An explicit ``true``/``false``
    overrides that; an unrecognized value warns once and falls back to ``auto``.

    Returns:
        The flag passed to ``Response.set_cookie``.
    """
    raw = os.environ.get(_COOKIE_SECURE_ENV, "").strip()

    if not raw or raw.lower() == _COOKIE_SECURE_AUTO:
        return request.url.scheme == "https"

    override = parse_bool(raw)

    if override is None:
        _logger.warning(
            "%s=%r is not auto/true/false; falling back to auto",
            _COOKIE_SECURE_ENV,
            raw,
        )
        return request.url.scheme == "https"

    return override


def log_dial_policy() -> None:
    """
    Log the effective host allowlist once at startup, so an unusable
    (unset) allowlist is discoverable without a failed login first.
    """
    allowed = sorted(allowed_hosts())

    if not allowed:
        _logger.warning(
            "%s is unset — every login will be rejected with 403. Set it to the "
            "host:port of the database(s) this instance may dial.",
            _ALLOWED_HOSTS_ENV,
        )
        return

    _logger.info("%s allows: %s", _ALLOWED_HOSTS_ENV, ", ".join(allowed))


async def require_session(request: Request) -> Session:
    """
    Resolve the request's session from its cookie and mark it active.

    Raises:
        Unauthorized: if the cookie is missing or does not name a live session.

    Returns:
        The live ``Session``.
    """
    session = get_session(request.cookies.get(SESSION_COOKIE_NAME))
    session.last_seen = time.monotonic()

    return session


async def require_csrf(
    request: Request, session: Session = Depends(require_session)
) -> Session:
    """
    Enforce the CSRF synchronizer token on a mutating request.

    The session is resolved via ``require_session`` as a nested dependency (so a
    test can override it through ``app.dependency_overrides``).

    Raises:
        Unauthorized: if there is no valid session (via ``require_session``).
        Forbidden: if the ``X-CSRF-Token`` header is absent or does not match the
            session's token.

    Returns:
        The live ``Session`` (so the route can resolve its pool).
    """
    if request.headers.get(_CSRF_HEADER) != session.csrf_token:
        raise Forbidden("CSRF token missing or invalid")

    return session


def _conn_parts(body: dict) -> ConnParts:
    """
    Validate a login body and build the ``ConnParts``.

    Raises:
        ValidationError: if a required key is missing or ``port`` is not an int.

    Returns:
        The parsed connection details.
    """
    missing = [k for k in _REQUIRED_LOGIN_KEYS if body.get(k) in (None, "")]

    if missing:
        raise ValidationError(f"Missing login field(s): {', '.join(missing)}")

    try:
        port = int(body["port"])
    except (TypeError, ValueError):
        raise ValidationError("port must be an integer")

    return ConnParts(
        host=str(body["host"]),
        port=port,
        database=str(body["database"]),
        username=str(body["username"]),
        password=str(body["password"]),
        connection_id=str(body.get("connectionId") or _DEFAULT_CONNECTION_ID),
    )


def _session_body(session: Session) -> dict:
    """
    The JSON body returned by ``login``/``whoami`` — never the password.
    """
    return {
        "connectionId": session.connection_id,
        "csrfToken": session.csrf_token,
        "username": session.username,
        "database": session.database,
    }


async def login(request: Request, response: Response, body: dict = Body(...)) -> dict:
    """
    Authenticate against the target database and start a session.

    Route: ``POST /api/login``.

    Raises:
        ValidationError: on a malformed body (422).
        Forbidden: if the host is not allowlisted (403), before any dial.
        Unauthorized: if Postgres rejects the credentials, the database is
            missing, or the host is unreachable (401) — with a generic detail
            that never echoes the password or raw driver text.

    Returns:
        ``{connectionId, csrfToken, username, database}`` and a ``Set-Cookie``.
    """
    parts = _conn_parts(body)

    if not is_host_allowed(parts.host, parts.port):
        raise Forbidden(
            f"Host not allowed: '{parts.host}:{parts.port}' is not in "
            f"{_ALLOWED_HOSTS_ENV}"
        )

    try:
        session = await create_session(parts)
    except (
        asyncpg.InvalidAuthorizationSpecificationError,
        asyncpg.InvalidPasswordError,
    ) as err:
        raise Unauthorized("Invalid credentials") from err
    except asyncpg.InvalidCatalogNameError as err:
        raise Unauthorized("Cannot open target database") from err
    except (OSError, ConnectionError, asyncpg.CannotConnectNowError, asyncio.TimeoutError) as err:
        raise Unauthorized("Cannot reach database") from err

    response.set_cookie(
        SESSION_COOKIE_NAME,
        session.id,
        httponly=True,
        secure=cookie_secure(request),
        samesite="lax",
        path="/",
    )

    return _session_body(session)


async def logout(request: Request, response: Response) -> Response:
    """
    Drop the session and clear the cookie (instant revoke).

    Route: ``POST /api/logout``. Deliberately not CSRF-gated: it is idempotent
    and has no data effect (worst case a forced logout).

    Returns:
        An empty ``204`` response whose ``Set-Cookie`` clears the session cookie.
    """
    await close_session(request.cookies.get(SESSION_COOKIE_NAME))
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    response.status_code = 204

    return response


async def whoami(session: Session = Depends(require_session)) -> dict:
    """
    Return the current session's public fields (so a reload recovers the CSRF
    token without re-login).

    Route: ``GET /api/whoami``.

    Raises:
        Unauthorized: if there is no live session (401 → the frontend treats it
            as "show the login dialog").

    Returns:
        ``{connectionId, csrfToken, username, database}``.
    """
    return _session_body(session)
