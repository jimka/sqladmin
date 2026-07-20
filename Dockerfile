# Frontend build. Pinned to the *build* platform so the JS bundle is built
# once, natively, and copied into every target architecture — arm64 never
# runs Node under QEMU.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS frontend

WORKDIR /build

# Dependency layer first so it caches independently of source changes.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# API + static server.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    POETRY_VERSION=2.1.1 \
    POETRY_VIRTUALENVS_CREATE=false \
    POETRY_NO_INTERACTION=1

WORKDIR /srv

RUN pip install --no-cache-dir "poetry==${POETRY_VERSION}"

COPY backend/pyproject.toml backend/poetry.lock* backend/README.md ./
RUN poetry install --only main --no-root

COPY backend/app ./app
COPY --from=frontend /build/dist ./static
COPY LICENSE.md THIRD-PARTY-NOTICES.md ./

# Run as an unprivileged user (carried over from backend/Dockerfile).
# Everything above is installed as root and only read at runtime.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin sqladmin
USER sqladmin

EXPOSE 8000

# Single worker, deliberately. The session registry is a module-global dict
# in app/connections.py, so a second worker would resolve cookies against an
# empty registry and 401 at random. Do not add `--workers`.
#
# No proxy flags: uvicorn enables --proxy-headers by default and trusts only
# 127.0.0.1; behind a reverse proxy the operator sets FORWARDED_ALLOW_IPS.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
