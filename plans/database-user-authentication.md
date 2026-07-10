# Database-User Authentication — Implementation Plan

## Overview

Replace the current single, env-seeded connection pool with **per-session authentication against the target Postgres server**. A user logs in by supplying full connection details (host, port, database, username, password); the backend validates them by opening a real asyncpg pool, mints an opaque server-side session, and returns an `HttpOnly` session cookie. Every subsequent `/api/{connection_id}/...` route resolves its pool from the session (the cookie), not from a global registry. Logout drops the server-side session and closes its pool (instant revoke). Authorization is entirely Postgres role grants — there is no app-level user store.

Backend touch points: [`backend/app/connections.py`](backend/app/connections.py) (the whole file is restructured from a global `pools` dict into a session store), [`backend/app/main.py:58`](backend/app/main.py#L58) (lifespan now boots with **zero** pools), [`backend/app/main.py:72`](backend/app/main.py#L72) (CORS gains `allow_credentials`), [`backend/app/errors.py`](backend/app/errors.py) (new `Unauthorized`/`Forbidden` types), plus a new `backend/app/auth.py` (session store, host allowlist, login/logout/whoami handlers, CSRF + session dependencies) and a new `backend/app/config.py` (env-parsed server presets + `ALLOW_USER_PRESETS`, exposed by a pre-auth `GET /api/config`). Every mutating route in `main.py` gains a CSRF dependency; every authenticated route gains a session dependency; `GET /api/config` is deliberately unauthenticated.

Frontend touch points: [`frontend/src/SqlAdminApp.ts`](frontend/src/SqlAdminApp.ts) (boot now gated behind a login gate), [`frontend/src/data/api.ts`](frontend/src/data/api.ts) (fetch helpers send the CSRF header on writes, plus a new `getConfig()`), [`frontend/src/data/stores.ts:24`](frontend/src/data/stores.ts#L24) (AjaxStore proxy gains a CSRF header), plus a new `frontend/src/shell/loginDialog.ts` and a new pure `frontend/src/data/presetStore.ts`. The controller keeps constructing with a connection id string, but that id is now supplied by the login response instead of the hardcoded `"default"`.

The login dialog also carries a **connection-presets** feature: named `{ name, host, port, database }` targets (never a username or password) picked at login instead of re-typed. Presets have **two sources** — admin-defined **server presets** from backend config (exposed by a new pre-auth `GET /api/config`) and the user's own **localStorage presets** (only when the backend's `ALLOW_USER_PRESETS` flag is true). So presets *do* touch the backend now (config + one endpoint — a new `backend/app/config.py` and a route); the earlier "zero backend changes for presets" framing is superseded by this amendment. The "no secrets at rest in our storage" property still holds — presets carry only host/port/database, never credentials. Username and password remain required per-login fields, delegated to the **browser's native credential manager** — which means the login UI MUST be a real semantic `<form>` submit whose credential inputs carry the right `autocomplete`/`name` tokens so password managers recognise and offer to fill them.

**Prerequisites (cross-repo).** The login dialog consumes two `@jimka/typescript-ui` credential components — `UsernameField` (new) and an enhanced `PasswordField` (a `newPassword?: boolean` flag; login default is exactly what we need) — specified in the library plan [`typescript-ui/plans/credential-field-components.md`](/home/jika/typescript/typescript-ui/plans/credential-field-components.md), and the library's existing `WebStorageProxy` for preset persistence. The credential-components plan must be implemented and the library rebuilt/relinked **before** this feature's login-dialog step. That is a different git repository, so the dependency is expressed here in prose, **not** via `depends-on` frontmatter (which is within-repo only).

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

The allowlist and **server presets** (below) are distinct but complementary: presets are inherently-trusted *suggested* targets, while the allowlist is the hard *enforcement* boundary — a preset host is not automatically allowed, so a locked-down deployment sets `ALLOW_USER_PRESETS=false` **plus** an allowlist matching the server-preset hosts, so users can only pick and only reach sanctioned servers.

### Password-in-memory hygiene — used once, never stored, never logged

The plaintext password flows: request body → `asyncpg.create_pool(..., password=...)` → dropped. It is **not** stored on the `Session` record and **not** included in any log line or error `detail`. asyncpg retains it internally for reconnects (unavoidable and acceptable — it is the DB driver). Login/error handlers must never echo the request body. TLS: the deploy is expected to terminate the app behind HTTPS (the `Secure` cookie requires it) and to reach Postgres over TLS where the network is untrusted (`sslmode` is the operator's DSN concern; documented, not enforced here).

### Pool eviction — idle-timeout sweep plus bounded per-session pool

Each `Session` records `last_seen` (updated by the session dependency on every request). A background asyncio task (`_sweep_sessions`, started in the lifespan) wakes every `SWEEP_INTERVAL_SECONDS` (60s) and closes+drops any session idle longer than `SESSION_IDLE_TIMEOUT_SECONDS` (30 min). Each session pool is bounded `min_size=0, max_size=SESSION_POOL_MAX_SIZE` (5) so N sessions can't exhaust Postgres `max_connections`. Logout closes the pool immediately. Shutdown closes all pools. This is a background sweep (not purely lazy) so an idle session's connections are reclaimed even with no traffic.

### App boots with zero pools

The old lifespan opened pools at startup from `DATABASE_URL`. **That is removed.** The app now starts with an empty session store; pools are created only by a successful login. `DATABASE_URL` and `open_pools`/`close_pools`/`connection_dsns` are deleted. The lifespan only starts and cancels the sweep task.

### Connection presets — two sources (server config + user localStorage), host/port/database only, no secrets

Presets are named connection targets picked at login instead of re-typed. A preset is `{ name, host, port, database }` and stores **only** those fields — never a username, never a password. Username and password stay **required per-login fields** entered every time; saving them is delegated to the **browser's native credential manager**, not to us. This keeps the "no secrets at rest in our storage" property intact even though — per this amendment — presets now have a **server-owned dimension** and are no longer purely a frontend concern.

Presets have two sources:

- **Server presets** — an admin-defined list from backend config (`SERVER_PRESETS`), read by a new `backend/app/config.py` and returned by a pre-auth `GET /api/config` (below). Users cannot edit or delete these.
- **User presets** — the user's own localStorage presets via the `PresetStore`, allowed **only** when the backend's `ALLOW_USER_PRESETS` flag (default **true**) is true.

**Pre-auth `GET /api/config`.** The login screen needs presets *before* anyone is authenticated, so `GET /api/config` returns `{ presets: ServerPreset[], allowUserPresets: boolean }` with **no** session requirement. This is safe to expose unauthenticated because it reveals only `name/host/port/database` — never credentials. Caveat to document for operators: internal hostnames are mildly sensitive (they hint at network topology), so a security-conscious deployment should treat the endpoint's host list as low-sensitivity info disclosure, not secret, and rely on the host-allowlist for actual enforcement.

**Merge and gating (frontend).** On login-dialog open, fetch `GET /api/config`. The preset picker shows **server presets always**, and **user presets only when `allowUserPresets` is true** — distinguished in the picker (a labelled section / prefix) since server presets are not deletable. When `allowUserPresets` is **false**: hide/disable the **Save preset** and **Delete preset** affordances, do **not** render any stray localStorage presets (ignore whatever `PresetStore.list()` returns), and gate every `PresetStore` write behind the flag so a disabled deployment writes nothing. When **true**: merge both lists (server section + user section); Save/Delete act only on user presets.

**Credential-manager UI constraint** (load-bearing): browser password managers only recognise, save, and offer to autofill credentials on a genuine semantic `<form>` submit whose inputs carry the right `autocomplete`/`name` tokens — a `<div>` with a click handler gets no autofill. This plan satisfies that **without any DOM manipulation** by consuming library primitives: the dialog content container is built as a semantic form via the `{ tag: "form" }` Component option (every `Component` accepts a `tag`; default `"div"` — verified in `Component.ts`), and the credential inputs are the library's `UsernameField` (defaults `autoComplete="username"`, `name="username"`) and `PasswordField` (login default `autoComplete="current-password"`, `name="password"`). No `document.createElement("form")`, no `setAttribute` on `<input>` nodes — the components and the `tag` option own those attributes.

### Preset persistence — the library's `WebStorageProxy`, not hand-rolled localStorage

User presets persist through the library's `WebStorageProxy` (`@jimka/typescript-ui/data`), constructed `{ key: "sqladmin.presets", storage: "local" }` — it persists its record array as a single JSON blob under that one key and surfaces quota/security failures as promise rejections. `PresetStore` is a **thin domain wrapper** over that proxy exposing the `ConnectionPreset` shape; it does **not** touch `window.localStorage` directly. The key stays under the app's `sqladmin.*` namespace so the existing "Clear SQL Admin data" and the localStorage inspector already cover it ([`localStorageWindow.ts:29`](frontend/src/shell/localStorageWindow.ts#L29)). Presets are **not** namespaced per connection (they exist before any connection is chosen), so the single flat `sqladmin.presets` key is correct. It stays unit-testable because `WebStorageProxy` reads its `Storage` from a global (and also supports `storage: "session"`) that a vitest can stub — mirroring the library's own `WebStorageProxy.test.ts`.

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

### `backend/app/config.py` — env-parsed app config + the pre-auth config route

```python
@dataclass(frozen=True)
class ServerPreset:
    name: str
    host: str
    port: int
    database: str
    # NO credentials — parsed from SERVER_PRESETS, credential keys ignored/rejected.

def server_presets() -> list[ServerPreset]     # parses SERVER_PRESETS (JSON array env), [] if unset/malformed
def allow_user_presets() -> bool               # parses ALLOW_USER_PRESETS env, default True

# Route handler registered in main.py (UNAUTHENTICATED — no session dependency):
async def app_config() -> dict                 # GET /api/config
```

`SERVER_PRESETS` is a JSON array env var of `{name, host, port, database}` objects (following the existing `os.environ.get` pattern in `connections.py` — there is no settings framework, so parse env directly; malformed JSON → `[]` and a logged warning, never a crash). `ALLOW_USER_PRESETS` is parsed truthy: unset/`"1"`/`"true"`/`"yes"` (case-insensitive) → `True`, `"0"`/`"false"`/`"no"` → `False`; **default `True`**. `app_config` returns `{"presets": [ServerPreset...], "allowUserPresets": bool}` and requires **no** session (it feeds the login screen). Any credential-looking key in a `SERVER_PRESETS` entry is dropped by the `ServerPreset` shape, so config can never surface a password.

### `frontend/src/data/api.ts` / `frontend/src/shell/loginDialog.ts` / `frontend/src/data/presetStore.ts`

```typescript
// api.ts additions
export function login(details: LoginDetails): Promise<Session>;   // POST /api/login
export function logout(): Promise<void>;                          // POST /api/logout
export function whoami(): Promise<Session | null>;                // GET /api/whoami, null on 401
export function setCsrfToken(token: string): void;                // module-level, header source
export function getConfig(): Promise<AppConfig>;                  // GET /api/config, UNAUTH (pre-login)

export interface AppConfig {
    presets: ConnectionPreset[];     // server presets (admin-defined)
    allowUserPresets: boolean;       // gates the user localStorage presets + Save/Delete
}

// loginDialog.ts
export function showLoginDialog(): Promise<Session>;              // resolves once authenticated

// presetStore.ts — thin domain wrapper over the library WebStorageProxy
export interface ConnectionPreset {
    name: string;      // primary key (upsert key), user-given
    host: string;
    port: number;
    database: string;
    // NO username, NO password — ever.
}

export class PresetStore {
    // Defaults to new WebStorageProxy({ key: "sqladmin.presets", storage: "local" });
    // a test injects a proxy bound to a stubbed (or "session") Storage.
    constructor(proxy?: WebStorageProxy);
    list(): Promise<ConnectionPreset[]>;            // proxy.read(), sorted by name; [] on a corrupt blob
    save(preset: ConnectionPreset): Promise<void>;  // upsert by name (create or update)
    remove(name: string): Promise<void>;            // destroy by name
}
```

`PresetStore`'s methods are **async** (the proxy's `read`/`create`/`update`/`destroy` return promises) — the login dialog is already async, so `await store.list()` etc. fit. `ConnectionPreset` is shared by both sources (server and user presets have the same shape); the login dialog tracks each entry's *origin* (server vs user) locally so it can label them and forbid deleting server ones.

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

`SqlAdminApp.ts` becomes async: call `whoami()`; if it returns a session, `setCsrfToken` and build the controller/shell with the returned `connectionId`. If `null`, `await showLoginDialog()` first (a non-dismissable `Dialog` — `closeOnBackdrop: false`, no Cancel button — built like [`promptQueryName`](frontend/src/promptQueryName.ts)), which resolves only on successful login, then proceed. Logout affordance: a menu-bar button (added in `SqlAdminShell`'s `buildMenuBar`) calling `logout()` then reloading the page (simplest correct reset — drops all in-memory controller/store state).

### Login dialog — semantic form, autofill attributes, and the preset picker

Before showing the dialog, `showLoginDialog` calls `getConfig()` once to obtain `{ presets (server), allowUserPresets }`. It then builds the picker list: **server presets always**, plus **user presets from `PresetStore.list()` only when `allowUserPresets` is true**. Each entry is tagged with its origin so the picker labels them (e.g. a "Server" / "My presets" section or a prefix) and so Delete can be refused on server entries. If `getConfig()` fails (backend unreachable), fall back to user presets only (when allowed) and let the user type the fields manually.

The dialog content container is a semantic form built with the `{ tag: "form" }` Component option — a `Panel({ tag: "form", ... })` — whose `onsubmit` prevents default and drives the same login path as the primary button, so Enter and the browser's "sign in" affordance both submit. Fields, in order: a **preset picker** (`ComboBox` listing the merged preset names, plus a blank "— none —"), `TextField` host, `TextField` port, `TextField` database, `new UsernameField()` (username), and `new PasswordField()` (password — the login default, no flag). The credential components emit `<input>`s already carrying `autocomplete="username"`/`name="username"` and `autocomplete="current-password"`/`name="password"`, so there is **no** DOM manipulation here. Load-bearing detail: the container MUST be `{ tag: "form" }` (not the default `div`) — with the components handling the field attributes, that is the only manual requirement for credential-manager autofill.

Preset affordances beside the picker — **rendered only when `allowUserPresets` is true** (hidden/disabled otherwise): a **Save preset** button (prompts for a name via the existing [`promptQueryName`](frontend/src/promptQueryName.ts)-style modal, then `await PresetStore.save({ name, host, port, database })` from the *current* host/port/database field values — never the credentials) and a **Delete** button, enabled only when the selected preset is a **user** preset (`await PresetStore.remove(selectedName)`, then refresh the picker) and never for a server preset. Selecting any preset (server or user) fills the host/port/database fields from it and moves focus to the **username** field (the first field the preset does not supply). The `PresetStore` is constructed once (default `WebStorageProxy` on `localStorage`); when `allowUserPresets` is false the dialog never reads or writes it.

---

## Ordered Implementation Steps

1. **`backend/app/errors.py`** — add `Unauthorized` (401) and `Forbidden` (403) after `NotFound`. Check: `grep -n "status_code" backend/app/errors.py` shows 401 and 403.

2. **`backend/app/connections.py`** — rewrite. Delete `pools`, `connection_dsns`, `open_pools`, `close_pools`, `get_pool`. Keep `_init_connection`. Add the `Session` dataclass, `_sessions` dict, and the functions in *Public API*. Constants at top with the CODE_CONVENTIONS magic-number comments: `SESSION_POOL_MAX_SIZE = 5`, `SESSION_IDLE_TIMEOUT_SECONDS = 1800`, `SWEEP_INTERVAL_SECONDS = 60`. Use `secrets.token_urlsafe(32)` for both ids. `session_pool_for` raises `NotFound` if `connection_id != session.connection_id`. Check: `grep -rn "get_pool\|open_pools\|DATABASE_URL" backend/app/` — expect matches only in files you are about to update in steps 3–4.

3. **`backend/app/auth.py`** — new file. `allowed_hosts()` parses `SQLADMIN_ALLOWED_HOSTS` (comma-split, strip, lowercase; empty → empty set). `is_host_allowed(host, port)` checks `f"{host}:{port}"` and bare `host` membership. `require_session` reads `request.cookies.get(SESSION_COOKIE_NAME)`, calls `get_session` (raises `Unauthorized`), bumps `last_seen = time.monotonic()`, returns the session. `require_csrf` compares `request.headers.get("X-CSRF-Token")` to `session.csrf_token`, raises `Forbidden` on mismatch/None. `login`: validate body keys (raise `ValidationError` on missing); `is_host_allowed` gate (raise `Forbidden`); `try: session = await create_session(...)` mapping `asyncpg.InvalidAuthorizationSpecificationError`/`InvalidPasswordError` → `Unauthorized("Invalid credentials")` and `OSError`/`ConnectionError`/`asyncpg.CannotConnectNowError`/`socket.gaierror` → `Unauthorized("Cannot reach database")` (do **not** leak the exception text verbatim); on success `response.set_cookie(SESSION_COOKIE_NAME, session.id, httponly=True, secure=True, samesite="lax", path="/")` and return the JSON body. `logout`: read cookie, `close_session`, `response.delete_cookie(...)`. Constant `SESSION_COOKIE_NAME = "sqladmin_session"`. Check: `poetry run python -c "import app.auth"`.

4. **`backend/app/config.py`** — new file. Follow the bare `os.environ.get` pattern from `connections.py` (there is no settings framework). `ServerPreset` frozen dataclass `{name, host, port, database}` — no credential fields. `server_presets()` reads `SERVER_PRESETS` (JSON array env), maps each object to a `ServerPreset` picking **only** the four keys (any `username`/`password` key in the JSON is ignored), returns `[]` on unset/malformed JSON (log a warning, never raise). `allow_user_presets()` parses `ALLOW_USER_PRESETS`: `False` only for `"0"`/`"false"`/`"no"` (case-insensitive), else **`True`** (default true, including unset). `app_config()` returns `{"presets": [asdict(p)...], "allowUserPresets": allow_user_presets()}`. Check: `poetry run python -c "import app.config"`; `grep -n "password\|username" backend/app/config.py` — expect only the ignore/drop comment, never a stored field.

5. **`backend/app/main.py`** —
   - Lifespan ([line 58](backend/app/main.py#L58)): drop `open_pools`/`close_pools`; start `asyncio.create_task(_sweep_loop())` on entry, cancel it and `await close_all_sessions()` on exit. `_sweep_loop` = `while True: await asyncio.sleep(SWEEP_INTERVAL_SECONDS); await sweep_idle_sessions()`.
   - CORS ([line 72](backend/app/main.py#L72)): add `allow_credentials=True`; keep the explicit `_DEV_ORIGINS` (a credentialed CORS response may not use `"*"` for origin — the list is already explicit, so this is fine).
   - Register `app.post("/api/login")(login)`, `app.post("/api/logout")(logout)`, `app.get("/api/whoami")(whoami)`, and `app.get("/api/config")(app_config)` — **`/api/config` takes no session dependency** (it feeds the login screen pre-auth).
   - Every existing `/api/{connection_id}/...` route: replace `get_pool(connection_id)` with a pool resolved from an injected session. Add `session: Session = Depends(require_session)` to **read** routes and `session: Session = Depends(require_csrf)` to **mutating** routes (`insert_row` POST, `update_row` PUT, `delete_row` DELETE, `run_query` POST, `explain_query` POST). Replace `get_pool(connection_id)` with `session_pool_for(session, connection_id)`. `require_csrf` depends on `require_session`, so mutating routes get the session transitively. The `export_rows` GET is read-only → `require_session`.
   - Add a `DomainError` subclass check is unchanged — the existing `_domain_error_handler` ([line 80](backend/app/main.py#L80)) already maps any `DomainError` (including the two new ones) to its `status_code`.
   Check: `grep -n "get_pool" backend/app/main.py` — expect zero. `grep -n "Depends(require_csrf)" backend/app/main.py` — expect 5 (the mutating routes). `grep -n '"/api/config"' backend/app/main.py` — expect 1.

6. **`backend/pyproject.toml`** — no new runtime deps (secrets/asyncio/time/socket/json are stdlib; asyncpg present). Confirm nothing added.

7. **`frontend/src/data/api.ts`** — add module-level `_csrfToken`, `setCsrfToken`, `csrfHeader()`. Merge `csrfHeader()` into `postJson`'s headers. Add `login`/`logout`/`whoami` (whoami maps a 401 to `null`, not a throw) and `getConfig()` (`GET /api/config` via `getJson`, no auth). Define `LoginDetails`/`Session`/`AppConfig`/`ConnectionPreset` types (or import from a new `frontend/src/contract` addition — mirror existing contract style). Check: `grep -n "X-CSRF-Token\|/api/config" frontend/src/data/api.ts`.

8. **`frontend/src/data/stores.ts`** — pass `headers: csrfHeader()` into the `AjaxStore` proxy config ([line 24](frontend/src/data/stores.ts#L24)). Import `csrfHeader` from `./api`.

9. **`frontend/src/data/presetStore.ts`** — new thin domain wrapper over the library `WebStorageProxy` (import `WebStorageProxy`, `Model`, `ModelRecord` from `@jimka/typescript-ui/data`). Module-level `PRESETS_KEY = "sqladmin.presets"` (flat, not per-connection — see the presets decision) and `PRESET_MODEL = new Model([{ name: "name" }, { name: "host" }, { name: "port" }, { name: "database" }], "name")` (primary key `name`). Constructor defaults `this._proxy = new WebStorageProxy({ key: PRESETS_KEY, storage: "local" })` but accepts an injected `WebStorageProxy` (for tests). `async list()`: `(await this._proxy.read()) as ConnectionPreset[]` sorted by `name`, wrapped so a corrupt blob (WebStorageProxy's `read()` parses with no guard) resolves to `[]` instead of throwing. `async save(preset)`: read the array; if an entry with that `name` exists → `await this._proxy.update(new ModelRecord(PRESET_MODEL, preset))`, else `await this._proxy.create(new ModelRecord(PRESET_MODEL, preset))`. `async remove(name)`: `await this._proxy.destroy(new ModelRecord(PRESET_MODEL, { name }))`. **Store only `{ name, host, port, database }`** — neither the type nor the `Model` has a credential field, so nothing can leak. Do NOT hand-roll `window.localStorage`. Check: `grep -n "password\|username\|window.localStorage" frontend/src/data/presetStore.ts` — expect zero.

10. **`frontend/src/shell/loginDialog.ts`** — new file, modeled on `promptQueryName.ts`. **Depends on the library credential components (cross-repo prerequisite — see Overview).** First `const config = await getConfig().catch(() => ({ presets: [], allowUserPresets: true }))`. Build the merged preset list: server presets (from `config.presets`, tagged origin `"server"`) plus, **only when `config.allowUserPresets`**, `await new PresetStore().list()` (tagged `"user"`). Build a `Dialog` (`closeOnBackdrop: false`, single **Sign in** primary button, no Cancel). **The content container MUST be a semantic form via the `{ tag: "form" }` Component option** — `Panel({ tag: "form", ... })` — with an `onsubmit` handler that `preventDefault()`s and runs the login path, so a browser password manager offers to save/fill. Fields: a preset `ComboBox` (merged names, labelled by origin, + a blank entry), `TextField`s host/database and a port `TextField` (defaults host `localhost`, port `5432`), then `new UsernameField()` and `new PasswordField()` — the credential components supply the `autocomplete`/`name` attributes, so do **not** hand-set any input attributes and do **not** build a raw `<form>` via `document.createElement`. Preset controls, **rendered only when `config.allowUserPresets` is true**: **Save preset** (prompt for a name, then `await store.save({ name, host, port, database })` from the current field values — never credentials) and **Delete**, enabled only when the selected entry's origin is `"user"` (`await store.remove(selected)`, refresh the ComboBox) — never for a server preset. Selecting any preset fills host/port/database and focuses the username field. On submit/confirm call `api.login(...)`; on rejection show the error `detail` inline (a muted `Text` line) and keep the dialog open; resolve `showLoginDialog()` only on success, returning the `Session`. Check: `grep -n 'tag: *"form"\|UsernameField\|PasswordField\|allowUserPresets\|getConfig' frontend/src/shell/loginDialog.ts` — expect the form tag, both credential components, and the gating present; `grep -n 'createElement\|setAttribute' frontend/src/shell/loginDialog.ts` — expect zero (no DOM hacks).

11. **`frontend/src/SqlAdminApp.ts`** — make boot async: `const session = await whoami() ?? await showLoginDialog(); setCsrfToken(session.csrfToken); const controller = new SqlAdminController(session.connectionId);` then mount as today. Check: `grep -n '"default"' frontend/src/SqlAdminApp.ts` — expect zero (the id now comes from the session).

12. **`frontend/src/shell/SqlAdminShell.ts`** — add a **Sign out** affordance to `buildMenuBar` (a trailing `Button`, beside About) whose action calls `api.logout()` then `window.location.reload()`. Add the `MenuBarActions.onLogout` field and wire it in `SqlAdminShell`.

13. **`frontend/src/data/presetStore.test.ts`** — new vitest mirroring the library's `WebStorageProxy.test.ts`. sqladmin's vitest runs the **node** environment (no DOM), so the `Storage` globals must be stubbed: a Map-backed `Storage` stand-in installed via `vi.stubGlobal("localStorage", makeStorage())` in `beforeEach` (and `vi.unstubAllGlobals()` in `afterEach`). Then exercise `PresetStore` with its default proxy — assert save / list-sorted / upsert-by-name / remove / persistence across a fresh `PresetStore` over the same storage, and that the serialized blob holds only `name`/`host`/`port`/`database` (no credentials). (Alternatively inject `new WebStorageProxy({ key, storage: "session" })` after stubbing `sessionStorage`.) Check: `cd frontend && npx vitest run presetStore`.

14. **`backend/tests/test_config.py`** — new pure-logic test (no app, mirrors `conftest.py` style): monkeypatch env and assert `server_presets()` parses a valid `SERVER_PRESETS` JSON array, drops credential keys, returns `[]` on unset/malformed; `allow_user_presets()` defaults `True`, is `False` only for the false-y strings. Check: `poetry run python -m pytest tests/test_config.py`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `backend/app/errors.py` |
| Rewrite | `backend/app/connections.py` |
| Create | `backend/app/auth.py` |
| Create | `backend/app/config.py` |
| Modify | `backend/app/main.py` |
| Modify | `frontend/src/data/api.ts` |
| Modify | `frontend/src/data/stores.ts` |
| Create | `frontend/src/data/presetStore.ts` |
| Create | `frontend/src/data/presetStore.test.ts` |
| Create | `frontend/src/shell/loginDialog.ts` |
| Modify | `frontend/src/SqlAdminApp.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |
| Create | `backend/tests/test_auth.py` |
| Create | `backend/tests/test_config.py` |

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

Config endpoint (**unit-testable** via httpx `ASGITransport`, no session, no DB):

- **`GET /api/config` is reachable unauthenticated** → returns **200** `{presets, allowUserPresets}` with no cookie present. (Testable.)
- **Server presets surface at login** → with `SERVER_PRESETS` set to a JSON array, `GET /api/config` returns those presets (name/host/port/database only). (Testable.)
- **`allowUserPresets` reflects the env** → `ALLOW_USER_PRESETS=false` → `false`; unset → `true`. (Testable.)
- **Config never leaks credentials** → a `SERVER_PRESETS` entry that (wrongly) includes `username`/`password` returns those keys stripped. (Testable.)

Pure-logic units (no app, mirror existing `conftest.py` style):

- `is_host_allowed` — exact `host` and `host:port` membership, empty allowlist → always `False`.
- `session_pool_for` — returns the pool on matching id, raises `NotFound` on mismatch.
- `server_presets()` — parses a valid JSON array, drops credential keys, `[]` on unset/malformed.
- `allow_user_presets()` — `True` by default and for truthy strings, `False` only for `"0"`/`"false"`/`"no"`.

`PresetStore` (**unit-testable**, node/vitest over `WebStorageProxy` with a stubbed `Storage` global, mirrors the library's `WebStorageProxy.test.ts`):

- **Save a preset** → `await save({name, host, port, database})` then `await list()` returns it.
- **Upsert by name** → saving a second preset with an existing name replaces it (list length unchanged, fields updated).
- **List sorted** → `list()` returns presets ordered by `name`.
- **Delete** → `remove(name)` drops exactly that preset; removing an absent name is a no-op.
- **Persistence** → a fresh `PresetStore` over the same storage reads back what a prior instance wrote (the reload case, since `WebStorageProxy` persists to the `Storage` blob).
- **Credentials never persisted** → the stored JSON blob contains only `name`/`host`/`port`/`database` keys — no `username`/`password`. (Assert on the serialized value in storage.)
- **Corrupt value** → a non-JSON blob under the key yields `[]` from `list()` (the wrapper guards `WebStorageProxy.read()`'s unguarded `JSON.parse`), never throws.

Frontend UI (**manual verification** — boot/DOM flow the harness can't drive):

- Fresh load with no session shows the non-dismissable login dialog; the shell is not interactable behind it.
- A bad login shows the inline error and keeps the dialog open.
- A good login dismisses the dialog and boots the shell; navigator/CRUD/query all work (cookie flows same-origin).
- Insert/update/delete/run-query/explain succeed with the CSRF header attached; removing the header (devtools) makes them 403.
- Sign out reloads to the login dialog.
- Reload after login skips the dialog (whoami recovers the session and csrf token).
- **Server presets appear at login without auth** → with `SERVER_PRESETS` configured, the login picker lists them before anyone signs in (they come from the pre-auth `GET /api/config`).
- **`allowUserPresets=false` hides save/delete and suppresses user presets** → the Save/Delete affordances are gone, any pre-existing `sqladmin.presets` entries are NOT shown, and only server presets are selectable; the dialog performs no `PresetStore` writes.
- **`allowUserPresets=true` merges both** → the picker shows server presets and the user's localStorage presets, labelled by origin; Save/Delete are available for user presets only.
- **A server preset can't be deleted** → selecting a server preset leaves Delete disabled/absent (Delete acts only on user presets).
- **Save current fields as a preset** (prompt for a name, `allowUserPresets=true`) → it appears in the preset picker's user section.
- **Selecting a preset** (server or user) fills host/port/database and focuses the username field; username/password stay empty.
- **Delete a user preset** removes it from the picker.
- **User presets persist across reload** (they live in localStorage) — the picker still lists them after a full page reload / re-login.
- **The browser offers to save/fill username+password**: because the login UI is a semantic `<form>` submit with `autocomplete="username"` / `autocomplete="current-password"`, the password manager prompts to save on a successful sign-in and offers autofill next time. (Verify the DOM: the form is a real `<form>` element and the two inputs carry the autocomplete attributes.)
- **We never persist the password** — after a login, `localStorage` under `sqladmin.presets` holds no credential fields (inspect via the Tools → Show localStorage window).

---

## Verification

- **Backend typecheck:** `cd backend && poetry run pyright` (config in `pyproject.toml`).
- **Backend tests:** `cd backend && poetry run python -m pytest` (in a worktree use `poetry run python -m pytest`, per the project memory, so app imports resolve from the worktree). New `test_auth.py` covers the auth/CSRF/allowlist cases and `test_config.py` covers config parsing + the unauthenticated `GET /api/config` (server presets surface, `allowUserPresets` reflects env, credential keys stripped). Existing route tests are pure-logic (no `TestClient` today), so these introduce the first httpx-`ASGITransport` route tests — keep them in the same `pytest-asyncio` auto style; construct `ASGITransport(app=app)` and an `AsyncClient`.
- **Frontend typecheck/build:** `cd frontend && npm run build` (or the project's tsc/vite check).
- **Frontend unit tests:** `cd frontend && npx vitest run` — the new `presetStore.test.ts` covers the `PresetStore` cases above (over `WebStorageProxy` with a stubbed `Storage` global, per the library's `WebStorageProxy.test.ts`), plus a small test for `csrfHeader()`/`setCsrfToken` in `api.test.ts` (pure, DOM-less).
- **Manual smoke:** run backend with `SQLADMIN_ALLOWED_HOSTS=localhost:5432` and a real Postgres, run the frontend dev server, exercise the login → CRUD → logout flow named in *Expected Behaviour*, plus the preset save/select/delete/persist cases. Run once with `SERVER_PRESETS='[{"name":"Local","host":"localhost","port":5432,"database":"sqladmin"}]'` and confirm the preset appears at login pre-auth; run once with `ALLOW_USER_PRESETS=false` and confirm Save/Delete are hidden and stray localStorage presets are suppressed. Confirm in devtools that the login content is a real `<form>` and the credential inputs carry `autocomplete="username"` / `autocomplete="current-password"` (the browser should prompt to save the password on sign-in), and that `sqladmin.presets` in localStorage never contains a username or password.

---

## Potential Challenges

- **Testing CSRF/session without a live Postgres.** `require_session` bumps `last_seen` and returns a `Session`; its pool is only touched inside route bodies. For the "missing CSRF → 403" and "no cookie → 401" tests, inject a `Session` whose `pool` is a stand-in (the 401/403 rejections fire before any `acquire()`), or override the `require_session` dependency via `app.dependency_overrides`. Prefer `dependency_overrides` for a clean stub.
- **Sweep task lifecycle.** The sweep task must be cancelled and awaited on lifespan exit or pytest will warn about a pending task; wrap the cancel in `try/except asyncio.CancelledError`.
- **DNS-rebinding TOCTOU.** The allowlist matches the supplied host string, not the resolved IP at connect time; a hostile DNS answer could still point an allowlisted name at an internal IP. Documented limitation — mitigate operationally by allowlisting only trusted hostnames/IPs. Out of scope to resolve here.
- **Library `AjaxProxy` header timing.** `csrfHeader()` is read when `buildStore` runs (per table open), after login has set the token, so the header is present. If a store were built before login it would miss the token — but the shell only builds after the login gate resolves, so this ordering holds.
- **Forgetting `{ tag: "form" }` on the container.** With the credential components (`UsernameField`/`PasswordField`) owning the field `autocomplete`/`name` attributes, the one remaining way to break credential-manager save/fill is to leave the content container the default `div` instead of `{ tag: "form" }` — then there is no form submit for the manager to hook. Verify in the DOM that the dialog content is a real `<form>` and that the components rendered `<input autocomplete="username">` / `<input autocomplete="current-password">`. Do **not** hand-set these attributes or build a raw `<form>` — that is the library components' and the `tag` option's job now.
- **Cross-repo prerequisite ordering.** The login-dialog step imports `UsernameField`/`PasswordField` from `@jimka/typescript-ui`; if the library plan (`credential-field-components.md`) is not yet implemented and relinked, that step won't compile. Implement the library plan first (it is in a different repo, so `/implement` here can't sequence it) — the rest of this plan (backend auth, sessions, config, `PresetStore`) does not depend on it and can proceed.
- **`Secure` cookie in local dev.** `Secure=True` cookies are not stored over plain HTTP. Dev is same-origin through Vite on `http://localhost` — browsers treat `localhost` as a secure context and **do** honour `Secure` cookies there, so no dev-only relaxation is needed. Verify during manual smoke; if a non-localhost dev host is used, that is the operator's TLS concern.

---

## Critical Files

- [`backend/app/connections.py`](backend/app/connections.py) — the file being rewritten; preserve `_init_connection`'s json/jsonb codec.
- [`backend/app/main.py`](backend/app/main.py) — every route's `get_pool(connection_id)` call site and the lifespan/CORS.
- [`backend/app/errors.py`](backend/app/errors.py) — the `DomainError` → status mapping the new errors plug into.
- [`backend/app/connections.py:34`](backend/app/connections.py#L34) — the bare `os.environ.get("DATABASE_URL")` idiom `config.py` follows (no settings framework exists).
- [`backend/tests/conftest.py`](backend/tests/conftest.py) — the pure-logic test idiom to mirror for the allowlist/`session_pool_for`/config units.
- [`frontend/src/promptQueryName.ts`](frontend/src/promptQueryName.ts) — the `Dialog`/`show()` modal pattern the login dialog copies (and the name-prompt reused for "save preset").
- [`frontend/src/shell/localStorageWindow.ts`](frontend/src/shell/localStorageWindow.ts) — the `sqladmin.*` key-namespace convention presets follow (so "Clear SQL Admin data" and the inspector cover `sqladmin.presets` for free).
- [`frontend/src/data/api.ts`](frontend/src/data/api.ts) and [`frontend/src/data/stores.ts`](frontend/src/data/stores.ts) — the two fetch paths that must carry the CSRF header.
- The library `AjaxProxy` (`@jimka/typescript-ui` `src/typescript/lib/data/proxy/AjaxProxy.ts`) — confirms the `headers` proxy option exists and is merged into every write `fetch`.
- The library `WebStorageProxy` (`@jimka/typescript-ui` `src/typescript/lib/data/proxy/WebStorageProxy.ts`, exported from `@jimka/typescript-ui/data`) — the localStorage blob store `PresetStore` wraps; its `tests/unit/data/proxy/WebStorageProxy.test.ts` is the vitest template (Map-backed `Storage` + `vi.stubGlobal`, plus the `Model`/`ModelRecord` construction) for `presetStore.test.ts`.
- The library `Component` `tag` option (`@jimka/typescript-ui` `src/typescript/lib/core/Component.ts`, default `"div"`) — how the login dialog's content container becomes a semantic `<form>`.
- The library credential components `UsernameField` (new) and enhanced `PasswordField` (`@jimka/typescript-ui/component/input`) — consumed by the login dialog for the `autocomplete`/`name` attributes; specified in the library plan below (they do **not** exist yet).
- [`typescript-ui/plans/credential-field-components.md`](/home/jika/typescript/typescript-ui/plans/credential-field-components.md) — **cross-repo prerequisite plan** defining `UsernameField`/`PasswordField`; must be implemented and the library relinked before this plan's login-dialog step. Different git repo, so this dependency is prose only, not `depends-on` frontmatter.

---

## Non-Goals

- **No app-level user store, password hashing, or role management** — authn is "can you open a Postgres connection", authz is Postgres grants. Intentional, per the decided design.
- **No multi-connection multiplexing within one session** — one login = one server/user/pool. Multiple servers = multiple sessions (separate browser logins). Revisit only if a multi-connection UI is requested.
- **No shared/persistent session store (Redis, DB-backed)** — the session map is in-process, so a backend restart logs everyone out. Acceptable for a single-process admin tool; horizontal scaling is out of scope.
- **No IP-level SSRF resolution / DNS-rebind defense** — host-string allowlist only (documented limitation).
- **No "remember me" / long-lived tokens** — sessions are idle-expiring only.
- **Presets never store credentials** — no username, no password, no token in a preset, in backend config, or in our localStorage. Saving username/password is delegated entirely to the browser's native credential manager. Not negotiable — it is the property that keeps "no secrets at rest in our storage" true.
- **No per-user server-side preset storage or sync** — the backend serves a single admin-defined `SERVER_PRESETS` list (broadcast to everyone, read-only); it does not persist or sync a given user's own presets. User presets stay per-browser in localStorage. A user-scoped, server-persisted preset store is out of scope.
- **No auth on `GET /api/config`** — intentionally unauthenticated so it can populate the login screen; it exposes only host/port/database (no credentials). Operators who consider internal hostnames sensitive rely on the host-allowlist for enforcement, not on hiding this endpoint.
