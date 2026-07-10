# Database-User Authentication — Implementation Plan

## Overview

Replace the current single, env-seeded connection pool with **per-session authentication against the target Postgres server**. A user logs in by supplying full connection details (host, port, database, username, password); the backend validates them by opening a real asyncpg pool, mints an opaque server-side session, and returns an `HttpOnly` session cookie. Every subsequent `/api/{connection_id}/...` route resolves its pool from the session (the cookie), not from a global registry. Logout drops the server-side session and closes its pool (instant revoke). Authorization is entirely Postgres role grants — there is no app-level user store.

Backend touch points: [`backend/app/connections.py`](backend/app/connections.py) (the whole file is restructured from a global `pools` dict into a session store), [`backend/app/main.py:58`](backend/app/main.py#L58) (lifespan now boots with **zero** pools), [`backend/app/main.py:72`](backend/app/main.py#L72) (CORS gains `allow_credentials`), [`backend/app/errors.py`](backend/app/errors.py) (new `Unauthorized`/`Forbidden` types), plus a new `backend/app/auth.py` (session store, host allowlist, login/logout/whoami handlers, CSRF + session dependencies). Every mutating route in `main.py` gains a CSRF dependency; every route gains a session dependency.

Frontend touch points: [`frontend/src/SqlAdminApp.ts`](frontend/src/SqlAdminApp.ts) (boot now gated behind a login gate), [`frontend/src/data/api.ts`](frontend/src/data/api.ts) (fetch helpers send the CSRF header on writes), [`frontend/src/data/stores.ts:24`](frontend/src/data/stores.ts#L24) (AjaxStore proxy gains a CSRF header), plus a new `frontend/src/shell/loginDialog.ts`. The controller keeps constructing with a connection id string, but that id is now supplied by the login response instead of the hardcoded `"default"`.

---

## Architecture Decisions

### Session model — opaque server-side session id, no signing needed

The cookie carries a **cryptographically random opaque token** (`secrets.token_urlsafe(32)` → 256 bits), not a signed payload. The server keeps an in-process `dict[str, Session]`; a forged or unknown token simply misses the lookup and is rejected. Because the token is high-entropy and validated only by server-side presence, **no HMAC signing (`itsdangerous`) or `SessionMiddleware` is required** — this keeps `pyproject.toml` dependency-free of anything new (`secrets` is stdlib, asyncpg is already present). The cookie is set `HttpOnly=True`, `Secure=True`, `SameSite="lax"`, `Path="/"`.

Rejected: Starlette `SessionMiddleware` / signed cookie — it stores state client-side, which fights the requirement that logout instantly revokes (a signed cookie remains valid until expiry even after "logout") and cannot own an asyncpg pool.

### Session ↔ connection-id reconciliation — one session owns exactly one pool; path `connection_id` is vestigial-but-validated

A login supplies **one** set of connection details, so a session authenticates as one Postgres user against one server and owns **one** asyncpg pool. The `/api/{connection_id}/...` URL shape is kept unchanged (so all existing frontend URL construction keeps working), but the pool is resolved from the **session cookie**, not from the `connection_id` path segment. The session record stores a stable client-facing `connection_id` label (returned by login/whoami; the frontend keeps passing it in URLs). A session dependency (`require_session`) looks up the session by cookie and returns it; a helper `session_pool(session)` returns its pool. The path `connection_id` is validated to equal `session.connection_id` and 404s on mismatch, so a stale URL from another session can't reach this session's pool.

Rejected: "session id IS the connection id" (put the session token in the URL) — leaks the secret session token into server logs, browser history, and `Referer` headers. Rejected: session holds a *map* of many connection ids → pools — the login form supplies one credential set, so multi-server = multiple logins/sessions, not one session multiplexing servers. Keeping one-pool-per-session is the low-inference choice and matches the "logout closes the pool" revoke model.

### CSRF strategy — synchronizer token in a custom header, validated against the session

On login the server generates a second random token, `csrf_token`, stored in the session record and returned in the login/whoami JSON body (readable by JS; **not** the HttpOnly session cookie). The frontend holds it in memory and sends it as an `X-CSRF-Token` header on every mutating request (`POST`/`PUT`/`DELETE`). A FastAPI dependency `require_csrf` compares the header to `session.csrf_token` and 403s on mismatch/absence. This is stronger than double-submit (the token never rides a cookie, so it can't be replayed by an attacker who can set cookies) and does not depend on `SameSite` alone. `SameSite=lax` on the session cookie is the belt to this dependency's braces. Read-only `GET` routes require a valid session but **not** the CSRF header.

### Host allowlist / SSRF — default-deny, explicit env allowlist, checked before dialing

Because the user chooses the host, the backend constrains which hosts it will dial. `SQLADMIN_ALLOWED_HOSTS` env var holds a comma-separated allowlist of `host` or `host:port` entries; **empty/unset means deny all** (default-deny — a misconfigured deploy is closed, not open). Login resolves the requested `(host, port)` and rejects with `Forbidden` (403) **before** attempting any connection if it is not in the allowlist. Justification: default-deny is the only safe SSRF posture for a tool that dials user-supplied hosts; an explicit allowlist is operator intent, and failing closed on misconfiguration prevents an accidental open proxy into the deploy's internal network. Matching is exact string on the supplied host plus port (no DNS-rebind-time-of-check games are solved here — documented as a known limitation in Potential Challenges).

### Password-in-memory hygiene — used once, never stored, never logged

The plaintext password flows: request body → `asyncpg.create_pool(..., password=...)` → dropped. It is **not** stored on the `Session` record and **not** included in any log line or error `detail`. asyncpg retains it internally for reconnects (unavoidable and acceptable — it is the DB driver). Login/error handlers must never echo the request body. TLS: the deploy is expected to terminate the app behind HTTPS (the `Secure` cookie requires it) and to reach Postgres over TLS where the network is untrusted (`sslmode` is the operator's DSN concern; documented, not enforced here).

### Pool eviction — idle-timeout sweep plus bounded per-session pool

Each `Session` records `last_seen` (updated by the session dependency on every request). A background asyncio task (`_sweep_sessions`, started in the lifespan) wakes every `SWEEP_INTERVAL_SECONDS` (60s) and closes+drops any session idle longer than `SESSION_IDLE_TIMEOUT_SECONDS` (30 min). Each session pool is bounded `min_size=0, max_size=SESSION_POOL_MAX_SIZE` (5) so N sessions can't exhaust Postgres `max_connections`. Logout closes the pool immediately. Shutdown closes all pools. This is a background sweep (not purely lazy) so an idle session's connections are reclaimed even with no traffic.

### App boots with zero pools

The old lifespan opened pools at startup from `DATABASE_URL`. **That is removed.** The app now starts with an empty session store; pools are created only by a successful login. `DATABASE_URL` and `open_pools`/`close_pools`/`connection_dsns` are deleted. The lifespan only starts and cancels the sweep task.

---

## Public API

### `backend/app/errors.py` — new error types

```python
class Unauthorized(DomainError):
    """Missing/invalid session, or Postgres rejected the supplied credentials."""
    status_code: int = 401

class Forbidden(DomainError):
    """CSRF check failed, or the requested host is not in the allowlist."""
    status_code: int = 403
```

### `backend/app/connections.py` — session store (rewritten)

```python
@dataclass
class Session:
    id: str                    # opaque cookie token (not returned in bodies)
    connection_id: str         # stable client-facing label, echoed in URLs
    csrf_token: str            # synchronizer token, returned in JSON bodies
    pool: asyncpg.Pool
    username: str              # for whoami display; NOT the password
    host: str
    database: str
    last_seen: float           # monotonic seconds, updated per request

_sessions: dict[str, Session]  # module-global, cookie-id -> Session

async def create_session(dsn_parts: ConnParts) -> Session      # opens pool, mints ids
async def close_session(session_id: str) -> None               # pop + pool.close()
def get_session(session_id: str | None) -> Session             # raises Unauthorized on miss
async def sweep_idle_sessions() -> None                        # one sweep pass
async def close_all_sessions() -> None                         # shutdown
def session_pool_for(session: Session, connection_id: str) -> asyncpg.Pool  # validates connection_id, raises NotFound on mismatch
```

`_init_connection` (the json/jsonb codec registration, currently `connections.py:42`) is preserved and passed as `init=` to `create_pool`.

### `backend/app/auth.py` — allowlist, request dependencies, route handlers

```python
def allowed_hosts() -> set[str]                                # parses SQLADMIN_ALLOWED_HOSTS
def is_host_allowed(host: str, port: int) -> bool
async def require_session(request: Request) -> Session         # reads cookie, get_session, bumps last_seen
async def require_csrf(request: Request, session=Depends(require_session)) -> Session  # checks X-CSRF-Token

# Route handlers registered in main.py:
async def login(request: Request, response: Response, body: dict) -> dict    # POST /api/login
async def logout(request: Request, response: Response) -> Response           # POST /api/logout
async def whoami(session=Depends(require_session)) -> dict                   # GET  /api/whoami
```

`login` body shape: `{"host": str, "port": int, "database": str, "username": str, "password": str, "connectionId"?: str}` (`connectionId` defaults to `"default"`). Success → `200 {"connectionId": str, "csrfToken": str, "username": str, "database": str}` and `Set-Cookie`. `whoami` returns the same body minus `csrfToken`? No — it **includes** `csrfToken` so a page reload can recover it without re-login.

### `frontend/src/data/api.ts` / `frontend/src/shell/loginDialog.ts`

```typescript
// api.ts additions
export function login(details: LoginDetails): Promise<Session>;   // POST /api/login
export function logout(): Promise<void>;                          // POST /api/logout
export function whoami(): Promise<Session | null>;                // GET /api/whoami, null on 401
export function setCsrfToken(token: string): void;                // module-level, header source

// loginDialog.ts
export function showLoginDialog(): Promise<Session>;              // resolves once authenticated
```

---

## Internal Structure

### CSRF header wiring on the two frontend fetch paths

`api.ts` holds a module-level `_csrfToken: string | null`, set by `setCsrfToken` after login/whoami. `postJson` (and the new write helpers) merge `{ "X-CSRF-Token": _csrfToken }` into headers when set. `GET` via `getJson` does **not** send it. Both keep `fetch`'s default `credentials: "same-origin"` — the relative `/api/...` URLs are same-origin (Vite proxies `/api` in dev; same host in prod), so the session cookie flows automatically. (The task's "credentials: 'include'" is only needed cross-origin; same-origin `same-origin` already sends the cookie. Do not use `include` — it would force the CORS credential dance for no benefit.)

For the row-CRUD path, `buildStore` ([`stores.ts:18`](frontend/src/data/stores.ts#L18)) passes the CSRF header into the library `AjaxStore` proxy via its supported `headers` option (verified in the library's `AjaxProxy` — `headers?: Record<string,string>` is merged into every `fetch`). Since the token is per-session and stable for the session's life, read it from `api.ts`'s current value at `buildStore` time:

```typescript
proxy: {
    url: ...,
    headers: csrfHeader(),   // { "X-CSRF-Token": token } from api.ts
    ...
}
```

### Login gate in the boot path

`SqlAdminApp.ts` becomes async: call `whoami()`; if it returns a session, `setCsrfToken` and build the controller/shell with the returned `connectionId`. If `null`, `await showLoginDialog()` first (a non-dismissable `Dialog` — `closeOnBackdrop: false`, no Cancel button — built like [`promptQueryName`](frontend/src/promptQueryName.ts) but with a `TextField` for host/port/db/user and a `PasswordField` for the password), which resolves only on successful login, then proceed. Logout affordance: a menu-bar button (added in `SqlAdminShell`'s `buildMenuBar`) calling `logout()` then reloading the page (simplest correct reset — drops all in-memory controller/store state).

---

## Ordered Implementation Steps

1. **`backend/app/errors.py`** — add `Unauthorized` (401) and `Forbidden` (403) after `NotFound`. Check: `grep -n "status_code" backend/app/errors.py` shows 401 and 403.

2. **`backend/app/connections.py`** — rewrite. Delete `pools`, `connection_dsns`, `open_pools`, `close_pools`, `get_pool`. Keep `_init_connection`. Add the `Session` dataclass, `_sessions` dict, and the functions in *Public API*. Constants at top with the CODE_CONVENTIONS magic-number comments: `SESSION_POOL_MAX_SIZE = 5`, `SESSION_IDLE_TIMEOUT_SECONDS = 1800`, `SWEEP_INTERVAL_SECONDS = 60`. Use `secrets.token_urlsafe(32)` for both ids. `session_pool_for` raises `NotFound` if `connection_id != session.connection_id`. Check: `grep -rn "get_pool\|open_pools\|DATABASE_URL" backend/app/` — expect matches only in files you are about to update in steps 3–4.

3. **`backend/app/auth.py`** — new file. `allowed_hosts()` parses `SQLADMIN_ALLOWED_HOSTS` (comma-split, strip, lowercase; empty → empty set). `is_host_allowed(host, port)` checks `f"{host}:{port}"` and bare `host` membership. `require_session` reads `request.cookies.get(SESSION_COOKIE_NAME)`, calls `get_session` (raises `Unauthorized`), bumps `last_seen = time.monotonic()`, returns the session. `require_csrf` compares `request.headers.get("X-CSRF-Token")` to `session.csrf_token`, raises `Forbidden` on mismatch/None. `login`: validate body keys (raise `ValidationError` on missing); `is_host_allowed` gate (raise `Forbidden`); `try: session = await create_session(...)` mapping `asyncpg.InvalidAuthorizationSpecificationError`/`InvalidPasswordError` → `Unauthorized("Invalid credentials")` and `OSError`/`ConnectionError`/`asyncpg.CannotConnectNowError`/`socket.gaierror` → `Unauthorized("Cannot reach database")` (do **not** leak the exception text verbatim); on success `response.set_cookie(SESSION_COOKIE_NAME, session.id, httponly=True, secure=True, samesite="lax", path="/")` and return the JSON body. `logout`: read cookie, `close_session`, `response.delete_cookie(...)`. Constant `SESSION_COOKIE_NAME = "sqladmin_session"`. Check: `poetry run python -c "import app.auth"`.

4. **`backend/app/main.py`** —
   - Lifespan ([line 58](backend/app/main.py#L58)): drop `open_pools`/`close_pools`; start `asyncio.create_task(_sweep_loop())` on entry, cancel it and `await close_all_sessions()` on exit. `_sweep_loop` = `while True: await asyncio.sleep(SWEEP_INTERVAL_SECONDS); await sweep_idle_sessions()`.
   - CORS ([line 72](backend/app/main.py#L72)): add `allow_credentials=True`; keep the explicit `_DEV_ORIGINS` (a credentialed CORS response may not use `"*"` for origin — the list is already explicit, so this is fine).
   - Register `app.post("/api/login")(login)`, `app.post("/api/logout")(logout)`, `app.get("/api/whoami")(whoami)`.
   - Every existing `/api/{connection_id}/...` route: replace `get_pool(connection_id)` with a pool resolved from an injected session. Add `session: Session = Depends(require_session)` to **read** routes and `session: Session = Depends(require_csrf)` to **mutating** routes (`insert_row` POST, `update_row` PUT, `delete_row` DELETE, `run_query` POST, `explain_query` POST). Replace `get_pool(connection_id)` with `session_pool_for(session, connection_id)`. `require_csrf` depends on `require_session`, so mutating routes get the session transitively. The `export_rows` GET is read-only → `require_session`.
   - Add a `DomainError` subclass check is unchanged — the existing `_domain_error_handler` ([line 80](backend/app/main.py#L80)) already maps any `DomainError` (including the two new ones) to its `status_code`.
   Check: `grep -n "get_pool" backend/app/main.py` — expect zero. `grep -n "Depends(require_csrf)" backend/app/main.py` — expect 5 (the mutating routes).

5. **`backend/pyproject.toml`** — no new runtime deps (secrets/asyncio/time/socket are stdlib; asyncpg present). Confirm nothing added.

6. **`frontend/src/data/api.ts`** — add module-level `_csrfToken`, `setCsrfToken`, `csrfHeader()`. Merge `csrfHeader()` into `postJson`'s headers. Add `login`/`logout`/`whoami` (whoami maps a 401 to `null`, not a throw). Define `LoginDetails`/`Session` types (or import from a new `frontend/src/contract` addition — mirror existing contract style). Check: `grep -n "X-CSRF-Token" frontend/src/data/api.ts`.

7. **`frontend/src/data/stores.ts`** — pass `headers: csrfHeader()` into the `AjaxStore` proxy config ([line 24](frontend/src/data/stores.ts#L24)). Import `csrfHeader` from `./api`.

8. **`frontend/src/shell/loginDialog.ts`** — new file, modeled on `promptQueryName.ts`. Build a `Dialog` (`closeOnBackdrop: false`, single **Sign in** primary button, no Cancel) whose content is a `VBox` of `TextField`s (host, port, database, username; sensible placeholders/defaults host `localhost`, port `5432`) and a `PasswordField` (password). On confirm, call `api.login(...)`; on rejection show the error `detail` inline (a muted `Text` line) and re-show; resolve `showLoginDialog()` only on success, returning the `Session`.

9. **`frontend/src/SqlAdminApp.ts`** — make boot async: `const session = await whoami() ?? await showLoginDialog(); setCsrfToken(session.csrfToken); const controller = new SqlAdminController(session.connectionId);` then mount as today. Check: `grep -n '"default"' frontend/src/SqlAdminApp.ts` — expect zero (the id now comes from the session).

10. **`frontend/src/shell/SqlAdminShell.ts`** — add a **Sign out** affordance to `buildMenuBar` (a trailing `Button`, beside About) whose action calls `api.logout()` then `window.location.reload()`. Add the `MenuBarActions.onLogout` field and wire it in `SqlAdminShell`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/errors.py` |
| Rewrite | `backend/app/connections.py` |
| Create | `backend/app/auth.py` |
| Modify | `backend/app/main.py` |
| Modify | `frontend/src/data/api.ts` |
| Modify | `frontend/src/data/stores.ts` |
| Create | `frontend/src/shell/loginDialog.ts` |
| Modify | `frontend/src/SqlAdminApp.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |
| Create | `backend/tests/test_auth.py` |

---

## Expected Behaviour

Backend (unit-testable with httpx `ASGITransport` against `app`, in `pytest-asyncio` auto mode — see Verification; the host-allowlist and dependency logic are testable without a real Postgres because they reject **before** dialing):

- **Login, host not allowed** → `POST /api/login` with a host absent from `SQLADMIN_ALLOWED_HOSTS` returns **403** and sets no cookie. (Testable: set env to a fixed allowlist, request another host.)
- **Login, empty allowlist** → any host returns **403** (default-deny). (Testable.)
- **Login, allowed host but bad/unreachable DB** → **401** with a generic detail (`"Invalid credentials"` or `"Cannot reach database"`), no cookie, and the detail never contains the password or raw asyncpg text. (Testable against an allowed but non-listening `host:port` → the unreachable path; credential rejection needs a real Postgres → **manual verify**.)
- **Login success** → **200**, body has `connectionId`/`csrfToken`/`username`/`database`, and a `Set-Cookie` for `sqladmin_session` that is `HttpOnly`, `Secure`, `SameSite=Lax`. (Needs a real Postgres → **manual verify**; assert cookie flags in a manual/integration run.)
- **Protected route without cookie** → any `/api/{id}/...` returns **401**. (Testable — no DB needed; `require_session` rejects before pool use.)
- **Mutating route with valid session cookie but missing `X-CSRF-Token`** → **403**. (Testable with a stubbed session — see Potential Challenges for the fixture that injects a session without a live pool.)
- **Path `connection_id` ≠ session's connection_id** → **404**. (Testable via `session_pool_for` unit test.)
- **Expired session** → after `last_seen` older than the idle timeout, a sweep pass closes the pool and drops the session; a subsequent request with that cookie → **401**. (Unit-test `sweep_idle_sessions` directly by inserting a `Session` with an old `last_seen` and a dummy/closed pool and asserting it is removed.)
- **Logout** → `POST /api/logout` pops the session and returns a `delete_cookie`; the session id no longer resolves (**401** on reuse). (Testable at the store level; end-to-end needs a pool → **manual verify**.)

Pure-logic units (no app, mirror existing `conftest.py` style):

- `is_host_allowed` — exact `host` and `host:port` membership, empty allowlist → always `False`.
- `session_pool_for` — returns the pool on matching id, raises `NotFound` on mismatch.

Frontend (**manual verification** — UI/boot flow the harness can't drive):

- Fresh load with no session shows the non-dismissable login dialog; the shell is not interactable behind it.
- A bad login shows the inline error and keeps the dialog open.
- A good login dismisses the dialog and boots the shell; navigator/CRUD/query all work (cookie flows same-origin).
- Insert/update/delete/run-query/explain succeed with the CSRF header attached; removing the header (devtools) makes them 403.
- Sign out reloads to the login dialog.
- Reload after login skips the dialog (whoami recovers the session and csrf token).

---

## Verification

- **Backend typecheck:** `cd backend && poetry run pyright` (config in `pyproject.toml`).
- **Backend tests:** `cd backend && poetry run python -m pytest` (in a worktree use `poetry run python -m pytest`, per the project memory, so app imports resolve from the worktree). New `test_auth.py` covers the testable cases above. Existing route tests are pure-logic (no `TestClient` today), so `test_auth.py` introduces the first httpx-`ASGITransport` route tests — keep them in the same `pytest-asyncio` auto style; construct `ASGITransport(app=app)` and an `AsyncClient`.
- **Frontend typecheck/build:** `cd frontend && npm run build` (or the project's tsc/vite check).
- **Frontend unit tests:** `cd frontend && npx vitest run` — add a small test for `csrfHeader()`/`setCsrfToken` in `api.test.ts` (pure, DOM-less).
- **Manual smoke:** run backend with `SQLADMIN_ALLOWED_HOSTS=localhost:5432` and a real Postgres, run the frontend dev server, exercise the login → CRUD → logout flow named in *Expected Behaviour*.

---

## Potential Challenges

- **Testing CSRF/session without a live Postgres.** `require_session` bumps `last_seen` and returns a `Session`; its pool is only touched inside route bodies. For the "missing CSRF → 403" and "no cookie → 401" tests, inject a `Session` whose `pool` is a stand-in (the 401/403 rejections fire before any `acquire()`), or override the `require_session` dependency via `app.dependency_overrides`. Prefer `dependency_overrides` for a clean stub.
- **Sweep task lifecycle.** The sweep task must be cancelled and awaited on lifespan exit or pytest will warn about a pending task; wrap the cancel in `try/except asyncio.CancelledError`.
- **DNS-rebinding TOCTOU.** The allowlist matches the supplied host string, not the resolved IP at connect time; a hostile DNS answer could still point an allowlisted name at an internal IP. Documented limitation — mitigate operationally by allowlisting only trusted hostnames/IPs. Out of scope to resolve here.
- **Library `AjaxProxy` header timing.** `csrfHeader()` is read when `buildStore` runs (per table open), after login has set the token, so the header is present. If a store were built before login it would miss the token — but the shell only builds after the login gate resolves, so this ordering holds.
- **`Secure` cookie in local dev.** `Secure=True` cookies are not stored over plain HTTP. Dev is same-origin through Vite on `http://localhost` — browsers treat `localhost` as a secure context and **do** honour `Secure` cookies there, so no dev-only relaxation is needed. Verify during manual smoke; if a non-localhost dev host is used, that is the operator's TLS concern.

---

## Critical Files

- [`backend/app/connections.py`](backend/app/connections.py) — the file being rewritten; preserve `_init_connection`'s json/jsonb codec.
- [`backend/app/main.py`](backend/app/main.py) — every route's `get_pool(connection_id)` call site and the lifespan/CORS.
- [`backend/app/errors.py`](backend/app/errors.py) — the `DomainError` → status mapping the new errors plug into.
- [`backend/tests/conftest.py`](backend/tests/conftest.py) — the pure-logic test idiom to mirror for the allowlist/`session_pool_for` units.
- [`frontend/src/promptQueryName.ts`](frontend/src/promptQueryName.ts) — the `Dialog`/`show()` modal pattern the login dialog copies.
- [`frontend/src/data/api.ts`](frontend/src/data/api.ts) and [`frontend/src/data/stores.ts`](frontend/src/data/stores.ts) — the two fetch paths that must carry the CSRF header.
- The library `AjaxProxy` (`@jimka/typescript-ui` `src/typescript/lib/data/proxy/AjaxProxy.ts`) — confirms the `headers` proxy option exists and is merged into every write `fetch`.

---

## Non-Goals

- **No app-level user store, password hashing, or role management** — authn is "can you open a Postgres connection", authz is Postgres grants. Intentional, per the decided design.
- **No multi-connection multiplexing within one session** — one login = one server/user/pool. Multiple servers = multiple sessions (separate browser logins). Revisit only if a multi-connection UI is requested.
- **No shared/persistent session store (Redis, DB-backed)** — the session map is in-process, so a backend restart logs everyone out. Acceptable for a single-process admin tool; horizontal scaling is out of scope.
- **No IP-level SSRF resolution / DNS-rebind defense** — host-string allowlist only (documented limitation).
- **No "remember me" / long-lived tokens** — sessions are idle-expiring only.
