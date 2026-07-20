"""
In-process login rate limiting: a sliding window of failed ``POST /api/login``
attempts per client address, held in a module-global dict (the same shape as the
session registry in ``connections.py``). Single-process only — see the module
docstring's limits note.
"""

from __future__ import annotations

import math
import time

from fastapi import Request

from .errors import TooManyRequests

# Failures from one client within the window before logins are refused.
LOGIN_FAILURE_LIMIT = 10

# How long a recorded failure keeps counting (5 minutes).
LOGIN_FAILURE_WINDOW_SECONDS = 300

# Key used when the ASGI scope carries no client address (a direct in-process
# call). One shared bucket is correct here: there is no address to separate on.
_UNKNOWN_CLIENT = "unknown"

# Module-global: client key -> monotonic timestamps of recent failures.
_failures: dict[str, list[float]] = {}


def client_key(request: Request) -> str:
    """
    The client address a login attempt is counted against.

    Returns:
        The connecting peer's address, or a shared fallback key when the ASGI
        scope carries no client address.
    """
    return request.client.host if request.client else _UNKNOWN_CLIENT


def _live(stamps: list[float], now: float) -> list[float]:
    """The subset of `stamps` still inside the window."""
    cutoff = now - LOGIN_FAILURE_WINDOW_SECONDS

    return [t for t in stamps if t > cutoff]


def check_login_rate_limit(request: Request) -> None:
    """
    Raise ``TooManyRequests`` when this client is over the limit.

    Raises:
        TooManyRequests: if the client has recorded ``LOGIN_FAILURE_LIMIT`` or
            more failures within the last ``LOGIN_FAILURE_WINDOW_SECONDS``.
    """
    now = time.monotonic()
    key = client_key(request)
    stamps = _live(_failures.get(key, []), now)

    if not stamps:
        _failures.pop(key, None)
        return

    _failures[key] = stamps

    if len(stamps) < LOGIN_FAILURE_LIMIT:
        return

    retry_after = max(1, math.ceil(stamps[0] + LOGIN_FAILURE_WINDOW_SECONDS - now))

    raise TooManyRequests(
        f"Too many failed login attempts; try again in {retry_after} seconds",
        headers={"Retry-After": str(retry_after)},
    )


def record_login_failure(request: Request) -> None:
    """
    Record one failed attempt for this client and prune expired entries.
    """
    now = time.monotonic()

    # Prune every key, not just this one, so an abandoned client's entries cannot
    # accumulate for the process lifetime.
    for key, stamps in list(_failures.items()):
        live = _live(stamps, now)

        if live:
            _failures[key] = live
        else:
            del _failures[key]

    _failures.setdefault(client_key(request), []).append(now)


def clear_login_failures(request: Request) -> None:
    """
    Forget this client's failures after a successful login.
    """
    _failures.pop(client_key(request), None)
