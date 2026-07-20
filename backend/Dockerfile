FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    POETRY_VERSION=2.1.1 \
    POETRY_VIRTUALENVS_CREATE=false \
    POETRY_NO_INTERACTION=1

WORKDIR /srv

RUN pip install --no-cache-dir "poetry==${POETRY_VERSION}"

# Dependency layer — copied first so it caches independently of source changes.
COPY pyproject.toml poetry.lock* README.md ./
RUN poetry install --only main --no-root

COPY app ./app

# Run as an unprivileged user. Everything above is installed as root and only
# read at runtime; the app writes nothing to disk.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin sqladmin
USER sqladmin

EXPOSE 8000
# uvicorn 0.32.1 already enables --proxy-headers by default; it trusts proxy
# headers only from 127.0.0.1 unless the operator sets FORWARDED_ALLOW_IPS to
# the reverse proxy's address, so the command line itself needs no flag.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
