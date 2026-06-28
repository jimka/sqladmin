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

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
