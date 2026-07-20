---
touches-shared: [backend/app/main.py, backend/Dockerfile, README.md, backend/README.md]
---

# Harden SQLAdmin for Publication — Implementation Plan

## Overview

SQLAdmin works when you run it on your own machine and reach it at `http://localhost:8000`. Move it one step away — a LAN address, a hostname, a reverse proxy — and login succeeds but every request after it returns 401, with nothing on screen explaining why. This plan makes SQLAdmin a tool you can point at a real database on a real host, and closes the security gaps that only matter once anyone can pull the image.

Three groups of changes. **Off-localhost correctness**: the session cookie stops being unconditionally `Secure` ([`backend/app/auth.py:193-200`](backend/app/auth.py#L193)), the host-allowlist rejection says which host it rejected and which variable governs it ([`auth.py:178-179`](backend/app/auth.py#L178)), and startup logs whether the allowlist is usable at all. **Cheap hardening**: a non-root container user, FastAPI's `/docs` / `/redoc` / `/openapi.json` off by default, and the credentialed dev-origin CORS middleware deleted ([`backend/app/main.py:96,139-145`](backend/app/main.py#L139)). **The real feature**: an in-process rate limiter on `POST /api/login`, in a new `backend/app/rate_limit.py`.

This plan lands **before** `plans/publish-v0-1-0.md`. That plan builds a root `Dockerfile` whose Python stage is carried over from [`backend/Dockerfile`](backend/Dockerfile#L1), so the container changes here are made in `backend/Dockerfile` and travel forward.

---

## Architecture Decisions

### Environment flags follow `config.py`'s shape

Every new setting is a module-level `_…_ENV` constant plus a small pure function reading bare `os.environ` — the convention established by [`backend/app/config.py:22-30`](backend/app/config.py#L22) and its readers `server_presets()` / `allow_user_presets()` ([`config.py:45,90`](backend/app/config.py#L90)). No settings framework, no Pydantic settings class. Unparseable input logs a warning and falls back to the default rather than raising, mirroring [`config.py:65`](backend/app/config.py#L65).

New names all carry the `SQLADMIN_` prefix, matching `SQLADMIN_ALLOWED_HOSTS` ([`auth.py:35`](backend/app/auth.py#L35)) and the `SQLADMIN_STATIC_DIR` the publication plan adds.[^prefix]

### The cookie's `Secure` flag is derived per request, with an override

`auth.py` gains `cookie_secure(request)`. `SQLADMIN_COOKIE_SECURE` defaults to `auto`, which means "secure when this request arrived over https". An explicit `true` or `false` wins over `auto`.

| `SQLADMIN_COOKIE_SECURE` | Request scheme | `secure=` passed to `set_cookie` |
|---|---|---|
| unset or `auto` | `https` | `True` |
| unset or `auto` | `http` | `False` |
| `true` / `1` / `yes` / `on` | `http` | `True` |
| `false` / `0` / `no` / `off` | `https` | `False` |
| `banana` | `http` | `False` — unrecognized, warn once and fall back to `auto` |

The scheme comes from `request.url.scheme`, which is what proxy-header handling rewrites (next decision).

### Proxy trust is `FORWARDED_ALLOW_IPS`, not a new uvicorn flag

The installed uvicorn 0.32.1 already enables `--proxy-headers` by default.[^proxy-default] What it does *not* do is trust an arbitrary proxy: `ProxyHeadersMiddleware` honours `X-Forwarded-Proto` and `X-Forwarded-For` only from `127.0.0.1` unless `FORWARDED_ALLOW_IPS` says otherwise. So the uvicorn command line is left alone and the operator sets `FORWARDED_ALLOW_IPS` to the reverse proxy's address.

This is why `auto` and proxy trust are one design and not two. Behind an nginx container that SQLAdmin does not trust, `X-Forwarded-Proto: https` is discarded, `request.url.scheme` stays `http`, and `auto` produces a cookie without `Secure`. A browser on https accepts that cookie, so login still works — the failure is a weaker cookie, not a broken app.[^auto-fails-usable] Setting `FORWARDED_ALLOW_IPS` restores the correct scheme, and the same setting is what makes the rate limiter see real client addresses instead of the proxy's.

### The allowlist stays default-deny; the rejection names the variable

`allowed_hosts()` is unchanged — an unset `SQLADMIN_ALLOWED_HOSTS` still rejects every login. Two things make that discoverable:

| Situation | What the user sees |
|---|---|
| Wrong password on an allowed host | `Invalid credentials` (401) |
| Host absent from the allowlist | `Host not allowed: 'localhost:5432' is not in SQLADMIN_ALLOWED_HOSTS` (403) |
| Allowlist unset, at startup | Server log: `SQLADMIN_ALLOWED_HOSTS is unset — every login will be rejected` |

The 403/401 split already exists ([`errors.py:55-69`](backend/app/errors.py#L55)) and the frontend already renders the backend's `detail` string verbatim in its error dialog (`frontend/src/data/api.ts:93-105`, `frontend/src/shell/LoginDialog.ts:213-218`), so improving the message is a one-line change with no frontend work.

### `GET /api/config` stays unauthenticated and unchanged

It carries only what the operator put in `SERVER_PRESETS`, never credentials ([`config.py:33-43`](backend/app/config.py#L33)), and the login screen needs it before any session exists. An operator who does not want host names disclosed simply leaves `SERVER_PRESETS` unset. Listed in `## Non-Goals`.

### The CORS middleware is deleted outright, not made conditional

The frontend issues relative `/api/...` URLs with `fetch`'s default `credentials: "same-origin"`, and the Vite dev server proxies `/api` to port 8000 (`frontend/vite.config.ts:29-31`). Dev requests are therefore already same-origin and never consult CORS. The middleware at [`main.py:139-145`](backend/app/main.py#L139) is dead in dev and unwanted in the image, so it goes away entirely — no env toggle for a code path nothing uses.[^cors-dead]

### Rate limiting is an in-process sliding window in a new `rate_limit.py`

A module-global `dict` of client key to failure timestamps, pruned inline. This mirrors the session registry at [`connections.py:76`](backend/app/connections.py#L76) — module-global state, plain stdlib, tunables as module constants like [`connections.py:29-36`](backend/app/connections.py#L29). No Redis, no `slowapi`, no new dependency.[^no-redis]

The rule: **more than 10 failed login attempts from one client address within 5 minutes returns 429 until the window drains.** The key is the client address alone, not address plus username.[^ip-only] Only failures count, and a success clears the client's history.

| Sequence from `10.0.0.5` | Result |
|---|---|
| Attempts 1–10 fail | 401 or 403 each; 10 timestamps recorded |
| Attempt 11, within 5 min of attempt 1 | 429 + `Retry-After`, no database dial |
| Attempt 11, more than 5 min after attempt 1 | attempt 1 has expired — the dial proceeds |
| Attempt 5 succeeds | history cleared; the next 10 failures are free again |

`Retry-After` is the whole seconds until the oldest recorded attempt leaves the window, minimum 1.

### `429` joins the existing error taxonomy

A new `TooManyRequests(DomainError)` with `status_code = 429`, alongside the classes in [`errors.py:30-69`](backend/app/errors.py#L30). `DomainError` gains an optional `headers` argument so the single handler at [`main.py:155-160`](backend/app/main.py#L155) can attach `Retry-After`; every existing subclass keeps working because the argument defaults to `None`.

---

## Public API

`backend/app/config.py`:

```python
def parse_bool(raw: str | None) -> bool | None:
    """True/False for a recognized flag value; None for unset or unrecognized."""

def enable_docs() -> bool:
    """Whether to expose /docs, /redoc and /openapi.json (default False)."""
```

`backend/app/auth.py`:

```python
def cookie_secure(request: Request) -> bool:
    """Whether the session cookie is set with the `Secure` attribute."""

def log_dial_policy() -> None:
    """Log the effective host allowlist once at startup."""
```

`backend/app/errors.py`:

```python
class DomainError(Exception):
    status_code: int = 400
    detail: str
    headers: dict[str, str] | None

    def __init__(self, detail: str, headers: dict[str, str] | None = None) -> None: ...

class TooManyRequests(DomainError):
    status_code: int = 429
```

`backend/app/rate_limit.py` (new):

```python
LOGIN_FAILURE_LIMIT: int = 10
LOGIN_FAILURE_WINDOW_SECONDS: int = 300

def client_key(request: Request) -> str:
    """The client address a login attempt is counted against."""

def check_login_rate_limit(request: Request) -> None:
    """Raise TooManyRequests when this client is over the limit."""

def record_login_failure(request: Request) -> None:
    """Record one failed attempt for this client and prune expired entries."""

def clear_login_failures(request: Request) -> None:
    """Forget this client's failures after a successful login."""
```

---

## Internal Structure

### `backend/app/config.py` additions

```python
# Env var opting the FastAPI docs UIs (/docs, /redoc, /openapi.json) back on.
_ENABLE_DOCS_ENV = "SQLADMIN_ENABLE_DOCS"

# Recognized flag spellings, case-insensitive. Anything else is "unrecognized".
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES = frozenset({"0", "false", "no", "off"})


def parse_bool(raw: str | None) -> bool | None:
    if raw is None:
        return None

    value = raw.strip().lower()

    if value in _TRUE_VALUES:
        return True

    if value in _FALSE_VALUES:
        return False

    return None


def enable_docs() -> bool:
    return parse_bool(os.environ.get(_ENABLE_DOCS_ENV)) is True
```

Leave `allow_user_presets()` and its `_FALSEY` set exactly as they are.[^keep-falsey]

### `backend/app/auth.py` additions

```python
_logger = logging.getLogger(__name__)

# Env var controlling the session cookie's `Secure` attribute:
# "auto" (default) derives it from the request scheme; an explicit
# true/false value overrides.
_COOKIE_SECURE_ENV = "SQLADMIN_COOKIE_SECURE"

# The value meaning "derive from the request scheme".
_COOKIE_SECURE_AUTO = "auto"


def cookie_secure(request: Request) -> bool:
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
    allowed = sorted(allowed_hosts())

    if not allowed:
        _logger.warning(
            "%s is unset — every login will be rejected with 403. Set it to the "
            "host:port of the database(s) this instance may dial.",
            _ALLOWED_HOSTS_ENV,
        )
        return

    _logger.info("%s allows: %s", _ALLOWED_HOSTS_ENV, ", ".join(allowed))
```

### `backend/app/rate_limit.py`

```python
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
    return request.client.host if request.client else _UNKNOWN_CLIENT


def _live(stamps: list[float], now: float) -> list[float]:
    """The subset of `stamps` still inside the window."""
    cutoff = now - LOGIN_FAILURE_WINDOW_SECONDS

    return [t for t in stamps if t > cutoff]


def check_login_rate_limit(request: Request) -> None:
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
    _failures.pop(client_key(request), None)
```

### `login` after the change (`backend/app/auth.py`)

The whole failure path is wrapped once, so every rejection — malformed body, disallowed host, bad credentials — counts as one attempt:

```python
async def login(request: Request, response: Response, body: dict = Body(...)) -> dict:
    check_login_rate_limit(request)

    try:
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
    except DomainError:
        record_login_failure(request)
        raise

    clear_login_failures(request)

    response.set_cookie(
        SESSION_COOKIE_NAME,
        session.id,
        httponly=True,
        secure=cookie_secure(request),
        samesite="lax",
        path="/",
    )

    return _session_body(session)
```

`TooManyRequests` is raised by `check_login_rate_limit` **before** the `try`, so a rate-limited request never records another failure against itself.

---

## Ordered Implementation Steps

### Phase 1 — Error taxonomy (foundation for the rest)

1. **`backend/app/errors.py`** — give `DomainError.__init__` a second parameter `headers: dict[str, str] | None = None`, store it as `self.headers`, and document it in the docstring. Add `TooManyRequests(DomainError)` with `status_code = 429` and a docstring naming it as the login rate limit. Checkpoint: `cd backend && poetry run pytest` — still green (the parameter is optional).

2. **`backend/app/main.py`** — in `_domain_error_handler` ([`main.py:155-160`](backend/app/main.py#L155)), pass `headers=exc.headers` to the `JSONResponse`.

### Phase 2 — Cookie and allowlist (test-first)

3. **Write the tests** in `backend/tests/test_auth.py`, appended after the existing route tests: cases 1–7 of `## Expected Behaviour`. Use the existing `_client()` helper ([`test_auth.py:79-80`](backend/tests/test_auth.py#L79)) and `monkeypatch.setenv`. Run `cd backend && poetry run pytest tests/test_auth.py` — expect the new tests red.

4. **`backend/app/config.py`** — add `_ENABLE_DOCS_ENV`, `_TRUE_VALUES`, `_FALSE_VALUES`, `parse_bool`, and `enable_docs` per `## Internal Structure`. Do not touch `allow_user_presets`.

5. **`backend/app/auth.py`** — add `import logging`, then `_logger`, `_COOKIE_SECURE_ENV`, `_COOKIE_SECURE_AUTO`, `cookie_secure`, and `log_dial_policy`, importing `parse_bool` from `.config`. Rewrite `login` per `## Internal Structure` (cookie flag + the named 403 message). Leave the rate-limit calls out for now — they arrive in Phase 4.

6. **`backend/app/main.py`** — call `log_dial_policy()` as the first statement inside `lifespan` ([`main.py:114`](backend/app/main.py#L114)), before `asyncio.create_task(_sweep_loop())`, and add `log_dial_policy` to the `from .auth import …` line ([`main.py:29`](backend/app/main.py#L29)).

7. Re-run `cd backend && poetry run pytest tests/test_auth.py` — expect green.

### Phase 3 — Docs off and CORS out

8. **Write the tests**: cases 8–10 in `backend/tests/test_config.py`. Run — expect red for the CORS case.

9. **`backend/app/main.py`** — change the app construction at [`main.py:137`](backend/app/main.py#L137) to:

   ```python
   # The interactive docs publish the whole API surface with no authentication,
   # so they are off unless SQLADMIN_ENABLE_DOCS opts them back in.
   _docs_on = enable_docs()

   app = FastAPI(
       title="SQLAdmin",
       lifespan=lifespan,
       docs_url="/docs" if _docs_on else None,
       redoc_url="/redoc" if _docs_on else None,
       openapi_url="/openapi.json" if _docs_on else None,
   )
   ```

   Add `enable_docs` to the `from .config import app_config` line ([`main.py:30`](backend/app/main.py#L30)).

10. **`backend/app/main.py`** — delete the `app.add_middleware(CORSMiddleware, …)` block ([lines 139-145](backend/app/main.py#L139)), the `_DEV_ORIGINS` constant ([line 96](backend/app/main.py#L96)), and the `from fastapi.middleware.cors import CORSMiddleware` import ([line 26](backend/app/main.py#L26)). Update the module docstring at [`main.py:1-14`](backend/app/main.py#L1), which currently advertises "credentialed CORS for the dev origins". Checkpoint: `grep -rn "CORS\|_DEV_ORIGINS" backend/app/` — expect zero matches.

11. Re-run `cd backend && poetry run pytest` — full suite green.

### Phase 4 — Login rate limiting (test-first)

12. **Add the reset fixture to `backend/tests/conftest.py`** — an `autouse` fixture that empties `app.rate_limit._failures` before and after every test. Without it, failed-login route tests in different modules share one bucket and leak state into each other.

13. **Write `backend/tests/test_rate_limit.py`** covering cases 11–18, mirroring the two-part shape of `test_auth.py`: pure-logic tests that seed `rate_limit._failures` directly (the technique used at [`test_auth.py:167`](backend/tests/test_auth.py#L167) for the session registry), then route tests through `_client()`. Run — expect failures (the module does not exist).

14. **Write `backend/app/rate_limit.py`** per `## Internal Structure`.

15. **`backend/app/auth.py`** — import the three rate-limit functions and `DomainError`, and add the calls to `login` exactly as `## Internal Structure` shows. Re-run `cd backend && poetry run pytest` — expect the whole suite green.

### Phase 5 — Container

16. **`backend/Dockerfile`** — insert, after `COPY app ./app` (line 17) and before `EXPOSE 8000`:

    ```dockerfile
    # Run as an unprivileged user. Everything above is installed as root and only
    # read at runtime; the app writes nothing to disk.
    RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin sqladmin
    USER sqladmin
    ```

    Leave the `CMD` unchanged — uvicorn 0.32.1 already enables `--proxy-headers`, and the proxy trust list is set by the operator through `FORWARDED_ALLOW_IPS`. Add a comment above `CMD` saying exactly that, so the publication plan's carried-over copy keeps it.

    Checkpoint: `docker build -t sqladmin-backend:hardened ./backend && docker run --rm sqladmin-backend:hardened id -un` prints `sqladmin`.

### Phase 6 — Documentation

17. **Rewrite the `### Configuration` section of `README.md`** ([README.md:77-87](README.md#L77)) and add the two operational notes, per `## Documentation Impact`.

18. **Update `backend/README.md`** ([backend/README.md:19-29](backend/README.md#L19)) with the same three new variables plus `FORWARDED_ALLOW_IPS`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `backend/app/rate_limit.py` |
| Create | `backend/tests/test_rate_limit.py` |
| Modify | `backend/app/errors.py` (`DomainError.headers`, `TooManyRequests`) |
| Modify | `backend/app/config.py` (`parse_bool`, `enable_docs`) |
| Modify | `backend/app/auth.py` (`cookie_secure`, `log_dial_policy`, rewritten `login`) |
| Modify | `backend/app/main.py` (docs URLs, CORS removal, `headers=` on the error handler, `log_dial_policy()` in the lifespan) |
| Modify | `backend/tests/conftest.py` (autouse rate-limit reset fixture) |
| Modify | `backend/tests/test_auth.py` (cookie + 403-message cases) |
| Modify | `backend/tests/test_config.py` (docs flag + CORS-absence cases) |
| Modify | `backend/Dockerfile` (non-root user, CMD comment) |
| Modify | `README.md` (configuration, proxy note, container-to-host note) |
| Modify | `backend/README.md` (new environment variables) |

---

## Expected Behaviour

All cases below are unit-testable through httpx's `ASGITransport` except where marked **manual**. Route cases that reach `login` must run with a `SQLADMIN_ALLOWED_HOSTS` value that makes the host either allowed or denied on purpose — none of them dials a real database.

### Cookie — `backend/tests/test_auth.py`

A login that reaches `set_cookie` needs `create_session` to succeed. Patch it with `monkeypatch.setattr("app.auth.create_session", …)` returning a fake `Session` (build it with the existing `_fake_session()` helper at [`test_auth.py:49`](backend/tests/test_auth.py#L49)).

1. **http, default config → no `Secure`.** `SQLADMIN_COOKIE_SECURE` unset, request to `http://test/api/login` succeeds: the `set-cookie` header contains `HttpOnly` and does **not** contain `Secure`.
2. **https, default config → `Secure`.** Same, with the client's `base_url` on `https://test`: the header contains `Secure`.
3. **Override on.** `SQLADMIN_COOKIE_SECURE=true` over `http://test` → header contains `Secure`.
4. **Override off.** `SQLADMIN_COOKIE_SECURE=false` over `https://test` → header does not contain `Secure`.
5. **Unrecognized value falls back to auto.** `SQLADMIN_COOKIE_SECURE=banana` over `http://test` → the login still returns 200 and the cookie has no `Secure`.

### Allowlist message — `backend/tests/test_auth.py`

6. **The 403 names the host and the variable.** With `SQLADMIN_ALLOWED_HOSTS=allowed.host`, a login for `evil.host:5432` returns 403 and its `detail` contains both `evil.host:5432` and `SQLADMIN_ALLOWED_HOSTS`. (The existing `test_login_host_not_allowed_is_403` keeps its status assertion; this extends it.)
7. **A wrong password stays distinguishable.** The existing `test_login_unreachable_host_is_401` still returns 401 and its `detail` does **not** mention `SQLADMIN_ALLOWED_HOSTS`.

### Docs and CORS — `backend/tests/test_config.py`

8. **Docs are off by default.** With `SQLADMIN_ENABLE_DOCS` unset at import time, `app.docs_url`, `app.redoc_url` and `app.openapi_url` are all `None`, and `GET /openapi.json` returns 404.
9. **`enable_docs()` parsing.** `parse_bool` returns `True` for `1`/`true`/`yes`/`on` (any case), `False` for `0`/`false`/`no`/`off`, and `None` for unset or `banana`. `enable_docs()` is `True` only for a truthy value.
10. **No CORS headers.** A `GET /api/config` carrying `Origin: http://localhost:5173` returns 200 with **no** `access-control-allow-origin` header; an `OPTIONS /api/login` preflight carrying that `Origin` and `Access-Control-Request-Method: POST` does not return 200 with CORS headers.

### Rate limiting — `backend/tests/test_rate_limit.py`

11. **Under the limit passes.** Seed 9 timestamps at `time.monotonic()` for key `127.0.0.1`; `check_login_rate_limit` on a request from that address does not raise.
12. **At the limit raises.** Seed 10 fresh timestamps; `check_login_rate_limit` raises `TooManyRequests` whose `headers["Retry-After"]` parses as an integer ≥ 1.
13. **Expired timestamps do not count.** Seed 10 timestamps at `time.monotonic() - LOGIN_FAILURE_WINDOW_SECONDS - 1`; `check_login_rate_limit` does not raise, and the key is gone from `_failures`.
14. **Failures accumulate.** Ten calls to `record_login_failure` leave 10 timestamps under the client's key.
15. **Success clears.** After seeding 5 timestamps, `clear_login_failures` removes the key entirely.
16. **Pruning is global.** With one key holding only expired timestamps and another holding a fresh one, a single `record_login_failure` for a third client leaves exactly the fresh key plus the third client's key.
17. **The route returns 429.** With `SQLADMIN_ALLOWED_HOSTS` unset, post 10 logins to `/api/login` (each 403), then an 11th: status 429, a `Retry-After` header, and a `detail` containing `Too many failed login attempts`.
18. **A rate-limited request does not dial.** The 11th request in case 17 returns 429 even though its body names an allowed host — assert by setting `SQLADMIN_ALLOWED_HOSTS=127.0.0.1:1` only for that final request and confirming the response is 429, not the 401 an unreachable host would produce.

### Manual

19. **Off-localhost login works.** Run the backend on a LAN machine and open `http://<lan-ip>:8000` from another machine. Log in; the object navigator loads and no request returns 401. Before this plan the same steps 401 immediately after login.
20. **Non-root container.** `docker run --rm sqladmin-backend:hardened id -un` prints `sqladmin`.
21. **Docs opt-in.** `docker run -e SQLADMIN_ENABLE_DOCS=1 …` then `curl -sI localhost:8000/docs | head -1` → 200; without the variable → 404.
22. **Dev workflow intact.** `docker compose up -d db`, backend via poetry on 8000, `npm run dev` on 5173. Log in through the Vite URL, browse a table, edit a row. Nothing 401s and no CORS error appears in the browser console.
23. **Startup warning.** Starting the backend with `SQLADMIN_ALLOWED_HOSTS` unset logs the warning naming the variable.

---

## Verification

1. `cd backend && poetry run pytest` — full suite green, including `test_rate_limit.py`.
2. `grep -rn "CORS\|_DEV_ORIGINS\|8015" backend/app/` — zero matches.
3. `grep -n "secure=True" backend/app/auth.py` — zero matches.
4. `cd backend && poetry run pyright` (or the editor's Pyright, `typeCheckingMode = "standard"` per [`pyproject.toml`](backend/pyproject.toml#L27)) — no new errors.
5. `docker build -t sqladmin-backend:hardened ./backend` succeeds; `docker run --rm sqladmin-backend:hardened id -un` prints `sqladmin`.
6. Manual cases 19–23 above, in that order. Case 22 is the regression guard for the dev loop and must not be skipped.

---

## Documentation Impact

`README.md` — rewrite the `### Configuration` list ([README.md:77-87](README.md#L77)) to cover, in this order:

- `SQLADMIN_ALLOWED_HOSTS` — unchanged text, but promoted to **required**: without it every login is rejected. Keep the default-deny sentence.
- `SQLADMIN_COOKIE_SECURE` — `auto` (default), `true`, or `false`. Explain `auto` in one sentence: the session cookie is marked `Secure` when the request arrived over https. Note that reaching SQLAdmin over plain http on a LAN address now works, where before the cookie was silently dropped.
- `SQLADMIN_ENABLE_DOCS` — off by default; set truthy to expose `/docs`, `/redoc`, and `/openapi.json`, which publish the whole API surface without authentication.
- `FORWARDED_ALLOW_IPS` — uvicorn's own variable. Behind a reverse proxy, set it to the proxy's address so SQLAdmin sees the real scheme and the real client address. Say what goes wrong when it is unset: the cookie is not marked `Secure` even over https, and every client shares one rate-limit bucket.
- `SERVER_PRESETS` and `ALLOW_USER_PRESETS` — unchanged.

Two additional notes in the same section:

- **Reaching a database on the Docker host.** Inside the container, `localhost` is the container. Use `host.docker.internal`, and on Linux add `--add-host=host.docker.internal:host-gateway`:

  ```bash
  docker run --rm -p 8000:8000 \
    -e SQLADMIN_ALLOWED_HOSTS=host.docker.internal:5432 \
    --add-host=host.docker.internal:host-gateway \
    <image>
  ```

- **Login rate limiting.** More than 10 failed logins from one address within 5 minutes returns 429 with `Retry-After`. State the limits are fixed, and that the counter is per process — it does not protect a multi-replica deployment.

`backend/README.md` — extend the environment list ([backend/README.md:19-29](backend/README.md#L19)) with `SQLADMIN_COOKIE_SECURE`, `SQLADMIN_ENABLE_DOCS`, and `FORWARDED_ALLOW_IPS`, one line each, pointing at the root README for the reverse-proxy explanation. Add `app/rate_limit.py` to the `## Layout` list.

---

## Potential Challenges

- **The rate-limit dict is process state and tests share it.** Any test module that posts a failing login adds to the same bucket, because httpx's `ASGITransport` reports one fixed client address. The autouse fixture in `conftest.py` (step 12) is the only thing keeping the suite deterministic — add it before writing the route tests, not after.
- **`enable_docs()` is read once at import.** Changing `SQLADMIN_ENABLE_DOCS` with `monkeypatch.setenv` inside a test cannot move `app.docs_url`, because `app.main` was already imported. Test the parsing function directly and verify the opt-in path manually (case 21).
- **One shared bucket behind an untrusted proxy.** If `FORWARDED_ALLOW_IPS` is unset, every request appears to come from the proxy, so one attacker's failures can lock out all users. The README note is the mitigation; there is no code fix that does not require trusting a header.
- **`--network host` changes what `localhost` means again.** The `host.docker.internal` advice applies to the default bridge network. Under `--network host`, `localhost` already is the host and the extra `--add-host` is unnecessary.
- **The `Retry-After` header only reaches the client if the handler forwards it.** Step 2 is small and easy to skip; without it the 429 body is right and the header is missing. Case 17 asserts the header.

---

## Critical Files

- [`backend/app/config.py:22-30,90-100`](backend/app/config.py#L22) — the environment-reading convention every new flag follows, and the "warn and fall back" behaviour for bad input.
- [`backend/app/auth.py:30-59,160-202`](backend/app/auth.py#L30) — the allowlist, the `login` handler, and the `set_cookie` call being changed.
- [`backend/app/errors.py:11-69`](backend/app/errors.py#L11) — the taxonomy `TooManyRequests` joins and the `DomainError` constructor being extended.
- [`backend/app/connections.py:29-36,76`](backend/app/connections.py#L29) — the module-global registry plus module-constant tunables that `rate_limit.py` mirrors.
- [`backend/app/main.py:1-14,26,96,114,137-160`](backend/app/main.py#L137) — module docstring, CORS import and block, app construction, lifespan, and the domain-error handler.
- [`backend/tests/test_auth.py:49,79-125,148-176`](backend/tests/test_auth.py#L79) — the `_fake_session` helper, the `ASGITransport` route-test shape, and the precedent for seeding a module-global registry from a test.
- [`backend/Dockerfile:14-20`](backend/Dockerfile#L14) — the stage the non-root user is added to, and the `CMD` the publication plan carries into its root `Dockerfile`.
- [`frontend/vite.config.ts:24-32`](frontend/vite.config.ts#L24) — the `/api` dev proxy that makes the dev loop same-origin, which is why deleting the CORS middleware is safe.
- `plans/publish-v0-1-0.md` — the sibling plan that runs next; its root `Dockerfile` and README sections must not contradict this one.

---

## Non-Goals

- **Authenticating `GET /api/config`.** The login screen needs it before a session exists, and it discloses only what the operator put in `SERVER_PRESETS`. An operator who objects leaves that variable unset.
- **TLS termination in the container.** A reverse proxy does that; this plan makes SQLAdmin behave correctly behind one.
- **Distributed or persistent rate-limit state.** The limiter is per process and resets on restart. SQLAdmin already cannot run multiple workers — the session registry is a module-global dict — so a shared store would solve a problem the app does not have.
- **Making the rate limit configurable.** The limits are module constants. An env var would be one more thing to document for a value almost nobody tunes.
- **Rate limiting anything but `POST /api/login`.** Every other route already requires a live session.
- **A startup hint or preset for `host.docker.internal`.** Guessing that a login for `localhost` "meant" the host would be wrong whenever the database really is in the container's network namespace. The README note and the named 403 message cover it instead.
- **Refactoring `allow_user_presets()` onto `parse_bool`.** Its semantics differ — anything unrecognized is true — and it works.
- **Anything in `plans/publish-v0-1-0.md`.** The root `Dockerfile`, the license files, the SPA mount, and the release workflow all belong to that plan.

---

## Notes

[^prefix]: The repo has two naming styles: `SQLADMIN_ALLOWED_HOSTS` is prefixed, while `SERVER_PRESETS` and `ALLOW_USER_PRESETS` are not. The unprefixed pair predates the prefix and is documented in two READMEs and `docker-compose.yml`, so renaming them would be a breaking change for no benefit. New variables use the prefix, which is also what the publication plan's `SQLADMIN_STATIC_DIR` does.

[^proxy-default]: Checked against the installed `uvicorn 0.32.1`. `uvicorn/main.py:222-225` declares `--proxy-headers/--no-proxy-headers` with `default=True`, and `uvicorn/config.py:331-335` resolves `forwarded_allow_ips` from the `FORWARDED_ALLOW_IPS` environment variable, falling back to `127.0.0.1`. `uvicorn/middleware/proxy_headers.py` rewrites `scope["scheme"]` from `X-Forwarded-Proto` and `scope["client"]` from `X-Forwarded-For`, but only when the connecting peer is in the trusted set. So the gap is not that proxy headers are ignored — it is that a proxy on any other address is not trusted, which is exactly what an operator must configure and what the README now explains.

[^auto-fails-usable]: The two ways `auto` can be wrong are not symmetric. Guessing `http` when the browser is on https produces a cookie without `Secure` — the browser still stores and sends it, so the app works and the only loss is the flag. Guessing `https` when the browser is on plain http produces a cookie the browser discards, which is precisely today's bug. `auto` therefore defaults toward the harmless error, and `SQLADMIN_COOKIE_SECURE=true` exists for the operator who wants the flag forced on behind a proxy they have not added to `FORWARDED_ALLOW_IPS`.

[^cors-dead]: Three facts together: `frontend/src/data/api.ts` builds every URL as a relative `/api/...`; it keeps `fetch`'s default `credentials: "same-origin"` rather than `include`; and `frontend/vite.config.ts:29-31` proxies `/api` from the dev server to `http://localhost:8000`. A request from the Vite page therefore has the same origin as the page and never triggers a CORS check. `http://localhost:8015` is the `@jimka/typescript-ui` gallery dev server, which has no reason to call this backend at all. An env-gated CORS toggle was considered and dropped: it would ship configuration for a path with no user.

[^no-redis]: Four libraries were considered. `slowapi` pulls in `limits` and is built around a decorator on a route function, but SQLAdmin registers `login` by handle (`app.post("/api/login")(login)` at [`main.py:149`](backend/app/main.py#L149)), so the decorator form does not fit without restructuring. `fastapi-limiter` requires Redis outright. `fastapi-advanced-rate-limiter` (GitHub `awais7012/FastAPI-RateLimiter`) does support an in-memory backend with Redis as an optional extra, so it is technically viable, but it was 6 stars / 1 fork / one author with two releases ever (2.0.0 Oct 2025, 2.1.0 Dec 2025) at evaluation time — thin provenance for the dependency guarding the login endpoint of a publicly pullable image. It also carries a name-collision hazard: it installs as `fastapi-advanced-rate-limiter`, while the similar PyPI name `fastapi-ratelimiter` belongs to an unrelated project by a different author. And it integrates as HTTP middleware counting *requests*, whereas this design counts *failed logins* — successful logins consume no budget, and an already-rejected request records no further failure against itself. `limits` used directly (without `slowapi`) is the strongest library option and remains a reasonable future swap; it was not chosen because it buys nothing the 60 stdlib lines in `rate_limit.py` do not. Every option adds a dependency to an image whose whole point is being one self-contained container.

[^ip-only]: Keying on address plus username was rejected because it makes the attack cheaper, not harder: a credential-stuffing run tries many usernames against one host, so per-username buckets would each stay under the limit forever. Keying on the address alone counts the thing the attacker cannot vary for free. The cost is that many users behind one NAT share a bucket, which the limit of 10 failures per 5 minutes is set high enough to absorb.

[^keep-falsey]: `allow_user_presets()` means "true unless explicitly disabled" — an unrecognized value is true. `parse_bool` cannot express that, because it returns `None` for unrecognized input so the caller can decide. Rewriting `allow_user_presets` on top of `parse_bool` would either change its behaviour for unrecognized values or need a wrapper longer than the current one line, and six tests in `test_config.py:75-92` pin the current semantics.

---

## Implementation Notes

- No codebase drift from the plan's assumptions was found: every referenced file, line number, and code shape matched exactly.
- `backend/tests/test_auth.py`'s `_client()` helper gained an optional `base_url` parameter (default unchanged) so the https-scheme cookie tests could exercise `cookie_secure`'s `auto` branch — a minimal, backward-compatible extension the plan didn't spell out but needed for cases 2 and 4.
- Manual verification cases 20, 21, and 23 (non-root container, docs opt-in, startup warning) were executed exactly as specified and passed. Case 19 (off-localhost login) and case 22 (full dev workflow through the browser) were **not** run as literally specified: this environment has no second machine for a real LAN test, and port 8000 (the frontend's hardcoded dev-proxy target) was already bound by a long-running, pre-existing `sqladmin-backend` Docker container unrelated to this work, which was left undisturbed rather than stopped. In their place, the backend was run standalone (`poetry run uvicorn`, `SQLADMIN_ALLOWED_HOSTS=localhost:5432`, against the already-running `sqladmin-db` container) and exercised with `curl`: a login over plain `http://127.0.0.1` succeeded and set a cookie **without** `Secure` (the core mechanism cases 19 and 22 depend on), and `GET /api/config` with an `Origin` header returned no `access-control-allow-*` headers. This covers the backend-side behaviour both cases rely on but does not substitute for a real cross-machine login or a live frontend session — an operator should still run cases 19 and 22 as written before relying on this hardening in a real deployment.
