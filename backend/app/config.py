"""
App configuration read from the environment (no settings framework — bare
``os.environ`` like ``connections.py``): the admin-defined **server presets** and
the ``ALLOW_USER_PRESETS`` flag, plus the pre-auth ``GET /api/config`` handler
that feeds the login screen.

A preset is a named ``{name, host, port, database}`` connection target and
carries **no credentials** — so ``/api/config`` is safe to expose unauthenticated
(it reveals only host/port/database, never a password). Any credential-looking
key in a ``SERVER_PRESETS`` entry is dropped by the ``ServerPreset`` shape.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass

_logger = logging.getLogger(__name__)

# Env var holding a JSON array of ``{name, host, port, database}`` preset objects.
_SERVER_PRESETS_ENV = "SERVER_PRESETS"

# Env var toggling whether users may save their own (browser-local) presets.
_ALLOW_USER_PRESETS_ENV = "ALLOW_USER_PRESETS"

# The only values that turn ``ALLOW_USER_PRESETS`` off; anything else (including
# unset) leaves it on.
_FALSEY = frozenset({"0", "false", "no"})


@dataclass(frozen=True)
class ServerPreset:
    """
    An admin-defined connection target. No credential fields — ever.
    """

    name: str
    host: str
    port: int
    database: str


def server_presets() -> list[ServerPreset]:
    """
    Parse ``SERVER_PRESETS`` into a list of presets.

    Each JSON object contributes exactly ``name``/``host``/``port``/``database``;
    any other key (e.g. a stray ``username``/``password``) is ignored. A missing
    var, non-array JSON, malformed JSON, or an entry missing a required key never
    raises — it logs a warning and drops that input.

    Returns:
        The parsed presets ([] when unset or unparseable).
    """
    raw = os.environ.get(_SERVER_PRESETS_ENV)

    if not raw:
        return []

    try:
        entries = json.loads(raw)
    except json.JSONDecodeError:
        _logger.warning("%s is not valid JSON; ignoring", _SERVER_PRESETS_ENV)
        return []

    if not isinstance(entries, list):
        _logger.warning("%s is not a JSON array; ignoring", _SERVER_PRESETS_ENV)
        return []

    presets: list[ServerPreset] = []

    for entry in entries:
        try:
            presets.append(
                ServerPreset(
                    name=str(entry["name"]),
                    host=str(entry["host"]),
                    port=int(entry["port"]),
                    database=str(entry["database"]),
                )
            )
        except (TypeError, KeyError, ValueError):
            _logger.warning("Skipping malformed %s entry: %r", _SERVER_PRESETS_ENV, entry)

    return presets


def allow_user_presets() -> bool:
    """
    Whether users may create/delete their own localStorage presets.

    Defaults to True (including when unset); only ``"0"``/``"false"``/``"no"``
    (case-insensitive) turn it off.

    Returns:
        The flag.
    """
    return os.environ.get(_ALLOW_USER_PRESETS_ENV, "").strip().lower() not in _FALSEY


async def app_config() -> dict:
    """
    Return the pre-auth app config that populates the login screen.

    Route: ``GET /api/config`` (no session required).

    Returns:
        ``{"presets": [{name, host, port, database}], "allowUserPresets": bool}``.
    """
    return {
        "presets": [asdict(p) for p in server_presets()],
        "allowUserPresets": allow_user_presets(),
    }
