"""Development launcher behind ``poetry run dev``.

A ``[project.scripts]`` entry point must be an importable ``module:callable``,
not a shell command — so the documented dev invocation
(``SQLADMIN_ALLOWED_HOSTS=localhost:5432 uvicorn app.main:app --reload
--port 8000``) is reproduced here as a function that sets the env default and
starts uvicorn in-process. Dev-only: it hardcodes ``--reload`` and the
localhost defaults; production runs uvicorn directly (see the root README).
"""

import os

import uvicorn

from .auth import ALLOWED_HOSTS_ENV

# Mirror the README's documented dev command.
_DEFAULT_ALLOWED_HOSTS = "localhost:5432"
_PORT = 8000


def main() -> None:
    """Start the API with auto-reload for local development.

    ``setdefault`` lets an explicit ``SQLADMIN_ALLOWED_HOSTS`` in the
    environment win, so ``SQLADMIN_ALLOWED_HOSTS=other:5432 poetry run dev``
    still overrides the localhost default. The value is set before
    ``uvicorn.run`` so the reloader's worker subprocess inherits it.
    """
    os.environ.setdefault(ALLOWED_HOSTS_ENV, _DEFAULT_ALLOWED_HOSTS)

    # Pass the import string (not the app object) — uvicorn's reloader needs it
    # to re-import the app in the worker subprocess on each change.
    uvicorn.run("app.main:app", reload=True, port=_PORT)
