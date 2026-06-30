# tsuiSQLAdmin Phase 2a — Read-Only Roles / Users / Groups Browser — Implementation Plan

## Overview

Phase 2a adds a **read-only** PostgreSQL roles browser to tsuiSQLAdmin. It rides the activity-bar seam the Phase-1 bible reserved precisely for this ([`plans/implemented/tsui-sql-admin.md:61`](plans/implemented/tsui-sql-admin.md#L61) — *Phase-2 view containers are a Card seam*, and the Non-Goal at [:697](plans/implemented/tsui-sql-admin.md#L697)): **exactly one** more rail `ToggleButton` + **one** more `Card` deck page, disturbing the Database explorer not at all.

The feature spans both halves of the app. **Backend:** four new CQRS `Query` operations over `pg_catalog` (roles list, one role's attributes, its memberships, its table privileges) plus their FastAPI routes, all read-only and following the strict `__init__`/`apply`/`get_result` three-phase contract ([`backend/app/operations/base.py:21`](backend/app/operations/base.py#L21)). **Frontend:** a new `RolesExplorerView` Card page (a `Tree` of roles over a read-only key/value `RolesPropertiesPanel`), wired into `SqlAdminController` and registered through the existing `ActivityBar(views)` API ([`frontend/src/shell/ActivityBar.ts:61`](frontend/src/shell/ActivityBar.ts#L61)), with a thin typed-fetch data path added to [`frontend/src/data/api.ts`](frontend/src/data/api.ts) and matching contract types in [`frontend/src/contract.ts`](frontend/src/contract.ts) / [`backend/app/contract.py`](backend/app/contract.py).

It introduces no mutation, no `Form` component, and no multi-connection fan-out — it reuses the single `"default"` connection seam end to end.

---

## Architecture Decisions

### It registers through the existing `ActivityBar(views)` API — no new shell machinery

`ActivityBar(views: ActivityView[])` already takes an ordered list of view containers, each `{ id, label, glyph, component }`, builds one rail `ToggleButton` + one `Card` page per entry, and runs the show/collapse reconciliation generically ([`frontend/src/shell/ActivityBar.ts:35`](frontend/src/shell/ActivityBar.ts#L35), [:61](frontend/src/shell/ActivityBar.ts#L61), [:105](frontend/src/shell/ActivityBar.ts#L105)). Phase 1 passes a one-element array from `buildSidebar` ([`frontend/src/shell/SqlAdminShell.ts:70`](frontend/src/shell/SqlAdminShell.ts#L70)). Phase 2a appends a **second** element. The view's `id` becomes its component id, which the deck's `Card` matches against ([`ActivityBar.ts:106`](frontend/src/shell/ActivityBar.ts#L106), [:126](frontend/src/shell/ActivityBar.ts#L126)) — the same contract `DatabaseExplorerView(controller, id)` already honours ([`frontend/src/shell/DatabaseExplorerView.ts:34`](frontend/src/shell/DatabaseExplorerView.ts#L34)). So the only shell change is one more array entry and one glyph registration; `ActivityBar.ts` itself is untouched.

### The role picker is a `Tree` of leaf nodes (reusing the navigator pattern)

The roles are a flat set, so a single-select `List` would also fit — `List extends AbstractCustomList<string>` with `selectedIndex`/`value` and `reduceSelection` is a genuine selection picker ([`component/list/List.d.ts`](../../typescript-ui/dist/lib/types/component/list/List.d.ts); the *bullets* components are the separate `BulletedList`/`NumberedList`). A flat `Tree` is chosen instead because it **reuses the navigator's already-proven selection→detail wiring verbatim**: `tree.on("selection", nodes => …)` reads `node.data` and routes to the controller ([`frontend/src/navigator/NavigatorTree.ts:20`](frontend/src/navigator/NavigatorTree.ts#L20)), with `Tree.setNodes` / `selectNode` the established API ([`tree/Tree.d.ts`](../../typescript-ui/dist/lib/types/component/tree/Tree.d.ts) lines 31/36/37). A flat `Tree` (leaf nodes, no `hasChildren`/`loadChildren`) matches the navigator the user already knows with zero new component wiring. Roles load **eagerly** (a single small list) via `setNodes`, unlike the navigator's lazy `loadChildren` levels — there is no hierarchy to defer.

### Read-only detail is a paged key/value Table, mirroring `PropertiesPanel`

The detail panel follows `PropertiesPanel`'s read-only key/value shape ([`frontend/src/properties/PropertiesPanel.ts:24`](frontend/src/properties/PropertiesPanel.ts#L24)): a two-field (`property`,`value`) `Model` rendered by a `Table(store, { columns: [], rowReadOnly: () => true })`. The role's attributes, memberships, and privileges are flattened into property/value rows (one row per membership, one per privilege grant — see `roleDetailRows`), so no second component is needed. The bible's binding note ([`tsui-sql-admin.md:449`](plans/implemented/tsui-sql-admin.md#L449)) confirms a plain key/value layout is the baseline and **no `Form` exists**, so `Binding`/`Bindable` is not introduced.

**Paging deviation from `PropertiesPanel`:** a superuser can hold ~1500 grants, and the library's `Table` silently renders zero rows when handed a large in-memory dataset in one `loadData` (logged in `LIBRARY_NOTES.md`; `AbstractStore.loadData` updates the store correctly, but the Table's large-dataset render path fails). So instead of a plain `MemoryStore` + `loadData`, the panel pages the rows through a `Store` + a small in-memory `PagingMemoryProxy` (slices a settable array by `page`/`pageSize`, reports the full count) + a `PaginationBar`, ≤50 rows per page — mirroring the MiscPanel paginated-table demo. The Table never receives more than a page, which is both phpMyAdmin-style UX and a guard against the library limit. Each selection calls `proxy.setData(rows)` then resets to page 1 and reloads.

### Data path: one-shot typed fetch (`api.ts`), not `AjaxStore`

This is introspection, not row CRUD. The bible splits the two ([`tsui-sql-admin.md:287`](plans/implemented/tsui-sql-admin.md#L287) and the navigator/columns precedent): one-shot/introspection reads go through the plain typed-fetch client in [`frontend/src/data/api.ts:23`](frontend/src/data/api.ts#L23) (`getJson<T>`), which reads the backend's `{detail}` error body directly and returns contract types — exactly what `getDatabases`/`getSchemas`/`getColumns` already do ([`api.ts:49`](frontend/src/data/api.ts#L49)–[:72](frontend/src/data/api.ts#L72)). `AjaxStore`/`AjaxProxy` is the CRUD path (pageable, PK-addressed, writable) and is wrong for a static role browse. New functions `getRoles` and `getRoleDetail` are added alongside the existing introspection fetchers.

### Endpoint granularity: a list endpoint + a per-role combined-detail endpoint

`GET /api/{connection_id}/roles` returns the picker rows (`rolname` + the boolean attribute flags, enough to populate the tree and a summary). `GET /api/{connection_id}/roles/{role}` returns **one combined detail payload** — attributes + memberships + privileges — for the selected role. This mirrors the navigator's coarse-list-then-detail rhythm (list `objects`, then `columns` for the clicked one), keeps the per-selection round-trip to a single request, and confines the three `pg_catalog` joins to the rarely-hit detail call instead of fanning out three endpoints the frontend would have to orchestrate. Each maps to its own `Query` op; the detail route runs the three member ops in sequence on one acquired connection (the same acquire-construct-apply-get_result shape as every existing route, [`backend/app/main.py:144`](backend/app/main.py#L144)).

### Backend never returns raw Postgres values

Per the contract rule ([`backend/app/contract.py:1`](backend/app/contract.py#L1)), every native asyncpg value is mapped in `get_result()`: `rolname`→str, the boolean attributes→bool, `rolconnlimit`→int (with the `-1` "no limit" sentinel preserved as a number — the frontend renders it), `rolvaliduntil`→`isoString` via `.isoformat()` or `None`. No `WireType` envelope is needed for the fixed-shape role payload (these are typed dataclass→`to_contract()` dicts, like `ColumnMeta`), but the temporal/limit mapping is done by hand in `get_result()` so the values are wire scalars, not driver objects.

---

## Public API

### Contract types — `frontend/src/contract.ts` (mirror in `backend/app/contract.py`)

```ts
/** One PostgreSQL role/user/group, with its catalog attribute flags. */
export interface RoleSummary {
    name: string;            // rolname
    canLogin: boolean;       // rolcanlogin (a "user" can log in; a "group" cannot)
    isSuperuser: boolean;    // rolsuper
    inherit: boolean;        // rolinherit
    createRole: boolean;     // rolcreaterole
    createDb: boolean;       // rolcreatedb
    replication: boolean;    // rolreplication
    connectionLimit: number; // rolconnlimit; -1 means "no limit"
    validUntil: string | null; // rolvaliduntil as ISO-8601, or null for no expiry
}

/** One membership edge: this role is a member of `roleName`. */
export interface RoleMembership {
    roleName: string;    // the granting/parent role (rolname of pg_auth_members.roleid)
    admin: boolean;      // admin_option on the membership
}

/** One object privilege granted to a role. */
export interface RolePrivilege {
    schema: string;        // table_schema
    table: string;         // table_name
    privilege: string;     // privilege_type (SELECT/INSERT/...)
    grantable: boolean;    // is_grantable
}

/** The combined per-role detail the detail endpoint returns. */
export interface RoleDetail {
    role: RoleSummary;
    memberOf: RoleMembership[];   // roles this role belongs to
    privileges: RolePrivilege[];  // table grants held by this role
}
```

### Frontend data path — `frontend/src/data/api.ts`

```ts
/** The Roles view's role list (introspection one-shot). */
export function getRoles(connectionId: string): Promise<RoleSummary[]>;

/** One role's combined attributes + memberships + privileges. */
export function getRoleDetail(connectionId: string, role: string): Promise<RoleDetail>;
```

### Frontend components

```ts
// frontend/src/roles/RolesPropertiesPanel.ts
/** Read-only key/value inspector for the selected role (mirrors PropertiesPanel). */
export class RolesPropertiesPanel {
    readonly component: Panel;
    show(detail: RoleDetail): void;
    clear(): void;                 // empty state before any selection
}

// frontend/src/roles/RolesTree.ts
/** Flat Tree of roles; selection drives the controller's role detail. */
export function RolesTree(controller: SqlAdminController): Tree;

// frontend/src/shell/RolesExplorerView.ts
/** The Roles Card page: RolesTree over RolesPropertiesPanel in an accordion. */
export function RolesExplorerView(controller: SqlAdminController, id: string): Component;
```

### Controller additions — `frontend/src/SqlAdminController.ts`

```ts
readonly rolesProperties: RolesPropertiesPanel;  // new field, ctor-built like `properties`
/** Load the named role's detail and show it in the roles inspector (stale-guarded). */
showRole(name: string): Promise<void>;
/** Populate the roles tree on first build, surfacing load errors to the status bar. */
loadRoles(): Promise<RoleSummary[]>;
```

### Backend operations — `backend/app/operations/` (export from `__init__.py`)

```python
class ListRolesQuery(Query):       # roles.py — pg_roles list
class RoleAttributesQuery(Query):  # role_detail.py — one role's pg_roles row
class RoleMembershipsQuery(Query): # role_detail.py — pg_auth_members for the role
class RolePrivilegesQuery(Query):  # role_detail.py — information_schema.role_table_grants
```

Each carries the standard `_conn`/input/`_raw` fields, an async `apply()`, and a pure `get_result()` raising `RuntimeError` before `apply()`.

---

## Internal Structure

### `ListRolesQuery` SQL (read-only, `pg_catalog`)

```sql
SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolcanlogin, rolreplication, rolconnlimit, rolvaliduntil
FROM pg_catalog.pg_roles
ORDER BY rolname
```

`pg_roles` is the publicly-readable view over `pg_authid` (it blanks the password), so no superuser is required — the correct read-only source for attributes. `get_result()` maps each row → `RoleSummary` contract dict: booleans via `bool(...)`, `rolconnlimit` passed through as int (sentinel `-1` preserved), `rolvaliduntil` → `r["rolvaliduntil"].isoformat() if r["rolvaliduntil"] is not None else None`.

### `RoleMembershipsQuery` SQL — "what is this role a member of"

```sql
SELECT g.rolname AS role_name, m.admin_option
FROM pg_catalog.pg_auth_members m
JOIN pg_catalog.pg_roles r ON r.oid = m.member
JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
WHERE r.rolname = $1
ORDER BY g.rolname
```

`pg_auth_members.member` is the member role; `.roleid` is the group it belongs to. Bound by name (validated; see Potential Challenges). `get_result()` → `[{"roleName": str, "admin": bool}]`.

### `RolePrivilegesQuery` SQL — table grants held by the role

```sql
SELECT table_schema, table_name, privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE grantee = $1
ORDER BY table_schema, table_name, privilege_type
```

`information_schema.role_table_grants` is the privilege-aware view (it shows only grants the current user may see), already used elsewhere in the bible's introspection approach. `is_grantable` is the text `'YES'`/`'NO'`; `get_result()` maps it to a bool (`r["is_grantable"] == "YES"`) and emits `[{"schema", "table", "privilege", "grantable"}]`.

### `RolesPropertiesPanel.show` row flattening

```
Attributes  → "Name", "Can login" (Yes/No), "Superuser", "Inherit", "Create role",
              "Create DB", "Replication", "Connection limit" ("-1" → "No limit"),
              "Valid until" (ISO string or "—")
Member of   → one row per membership: property "Member of", value `${roleName}${admin ? " (admin)" : ""}`
Privileges  → one row per grant: property "Grant", value `${schema}.${table}: ${privilege}${grantable ? " (grantable)" : ""}`
```

Empty memberships / privileges contribute no rows (the section simply has none), matching the navigator-Properties "show what's there" style.

---

## Ordered Implementation Steps

1. **Contract types (backend).** In [`backend/app/contract.py`](backend/app/contract.py), add frozen dataclasses `RoleSummary`, `RoleMembership`, `RolePrivilege`, `RoleDetail`, each with a `to_contract()` returning the camelCase dict (mirroring `ColumnMeta.to_contract()`).
2. **`ListRolesQuery`.** New `backend/app/operations/roles.py` with the `pg_roles` query and `get_result()` → `list[dict]` of `RoleSummary` contract dicts. Map `rolvaliduntil`/`rolconnlimit` per *Internal Structure*.
3. **Detail ops.** New `backend/app/operations/role_detail.py` with `RoleAttributesQuery` (single `pg_roles` row by `rolname`; `get_result()` returns the `RoleSummary` dict, or `None` when the row is absent — kept pure, the route raises `NotFound`, matching the route-level convention in `_columns_for`), `RoleMembershipsQuery`, `RolePrivilegesQuery`.
4. **Export ops.** Add the four classes to `backend/app/operations/__init__.py` imports + `__all__` ([`__init__.py:6`](backend/app/operations/__init__.py#L6), [:17](backend/app/operations/__init__.py#L17)).
5. **Routes.** In [`backend/app/main.py`](backend/app/main.py), under a new `# --- Role introspection ---` banner, add `GET /api/{connection_id}/roles` (acquire → `ListRolesQuery` → apply → get_result) and `GET /api/{connection_id}/roles/{role}` (acquire once → run the three detail ops in sequence; if `RoleAttributesQuery.get_result()` is `None`, raise `NotFound` → 404 via the existing handler, mirroring `_columns_for` at [`main.py:111`](backend/app/main.py#L111); else assemble `{role, memberOf, privileges}`). Import the four ops. Group the two `roles` routes with the other 2-segment routes (see Potential Challenges — ordering is not load-bearing).
6. **Contract types (frontend).** In [`frontend/src/contract.ts`](frontend/src/contract.ts), add `RoleSummary`, `RoleMembership`, `RolePrivilege`, `RoleDetail` (the TS shapes above).
7. **Frontend data path.** In [`frontend/src/data/api.ts`](frontend/src/data/api.ts), add `getRoles` and `getRoleDetail` using `getJson<T>` against the two routes.
8. **`RolesPropertiesPanel` + paging.** New `frontend/src/roles/roleDetailRows.ts` (pure `roleDetailRows(detail)` flattening per *Internal Structure*, unit-tested in `roleDetailRows.test.ts`) and `frontend/src/roles/PagingMemoryProxy.ts` (an in-memory `Proxy` slicing a settable array by `page`/`pageSize`, `getLastTotalCount` = full length). `frontend/src/roles/RolesPropertiesPanel.ts` follows `PropertiesPanel`'s key/value `Table` but over a `Store` + `PagingMemoryProxy` + `PaginationBar` (`setPageSize(50)`); `show(detail)`/`clear()` call `proxy.setData(rows)` then reset to page 1 and reload (see the paging deviation in *Architecture Decisions*).
9. **`RolesTree`.** New `frontend/src/roles/RolesTree.ts`: build a `Tree`, eagerly `getRoles` → `setNodes(leaf nodes)` (each `node.data = role.name`, glyph differentiating login roles vs groups optional), wire `on("selection", …)` → `controller.showRole(name)`, route load errors to `controller.notifyError`.
10. **Controller wiring.** In [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts), add the `rolesProperties` field (built in the ctor like `properties`, [:55](frontend/src/SqlAdminController.ts#L55)), `loadRoles()`, and `showRole(name)` with a monotonic stale-guard mirroring `showProperties`/`_propsSeq` ([:203](frontend/src/SqlAdminController.ts#L203)).
11. **`RolesExplorerView`.** New `frontend/src/shell/RolesExplorerView.ts`, copied from `DatabaseExplorerView` ([`DatabaseExplorerView.ts:29`](frontend/src/shell/DatabaseExplorerView.ts#L29)): an `AccordionPanel` with a "Roles" navigator section (the `RolesTree`, `NAV_FILL_HINT` preferred height) over a "Details" section (`controller.rolesProperties.component`), `setCompact(true)`.
12. **Register the view.** In [`frontend/src/shell/SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts): import the `users` glyph (`@jimka/typescript-ui/glyphs/solid/users`) and add it to the `Glyph.register(...)` call ([:27](frontend/src/shell/SqlAdminShell.ts#L27)); add a `ROLES_VIEW_ID = "roles"` const; in `buildSidebar` ([:70](frontend/src/shell/SqlAdminShell.ts#L70)) append a second `ActivityView` `{ id: ROLES_VIEW_ID, label: "Roles", glyph: "users", component: RolesExplorerView(controller, ROLES_VIEW_ID) }`.
13. **Backend tests.** Add `backend/tests/test_roles.py` and `test_role_detail.py` covering the `get_result()` cases enumerated in *Expected Behaviour* (set `op._raw` by hand, `NO_CONN`), mirroring `test_list_objects.py`.
14. **Regression checkpoints.** `grep -n "ActivityView" frontend/src/shell/SqlAdminShell.ts` — expect two entries; `grep -rn "Form" frontend/src` — expect zero (no `Form` introduced); backend `pytest`; frontend `npm run build` (or `tsc --noEmit`) clean.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `backend/app/operations/roles.py` |
| Create | `backend/app/operations/role_detail.py` |
| Create | `backend/tests/test_roles.py` |
| Create | `backend/tests/test_role_detail.py` |
| Create | `frontend/src/roles/RolesPropertiesPanel.ts` (paged key/value detail) |
| Create | `frontend/src/roles/roleDetailRows.ts` (pure row flattening) |
| Create | `frontend/src/roles/roleDetailRows.test.ts` (unit test) |
| Create | `frontend/src/roles/PagingMemoryProxy.ts` (in-memory paging proxy) |
| Create | `frontend/src/roles/RolesTree.ts` |
| Create | `frontend/src/shell/RolesExplorerView.ts` |
| Modify | `backend/app/contract.py` (role dataclasses) |
| Modify | `backend/app/operations/__init__.py` (export ops) |
| Modify | `backend/app/main.py` (two routes) |
| Modify | `frontend/src/contract.ts` (role types) |
| Modify | `frontend/src/data/api.ts` (`getRoles`, `getRoleDetail`) |
| Modify | `frontend/src/SqlAdminController.ts` (`rolesProperties`, `loadRoles`, `showRole`) |
| Modify | `frontend/src/shell/SqlAdminShell.ts` (glyph register + second `ActivityView`) |
| Modify | `LIBRARY_NOTES.md` (large `MemoryStore.loadData` Table render limit) |

---

## Expected Behaviour

### Backend `get_result()` — offline unit-testable (pure transform, set `_raw` by hand)

- **`ListRolesQuery`** — a typical role row (`rolname="app"`, `rolcanlogin=True`, others false, `rolconnlimit=-1`, `rolvaliduntil=None`) maps to `{"name": "app", "canLogin": true, "isSuperuser": false, …, "connectionLimit": -1, "validUntil": null}`. All nine attributes present and correctly typed.
- **NULL `rolvaliduntil`** → `validUntil: null`; a non-null `datetime` → its `.isoformat()` string.
- **`rolconnlimit = -1`** → `connectionLimit: -1` (sentinel preserved as a number, not dropped or remapped); a positive limit passes through.
- **A superuser/group row** (`rolsuper=True`, `rolcanlogin=False`) maps flags correctly (distinguishes a group from a login user).
- **Empty result** → `[]`.
- **`get_result()` before `apply()`** → `RuntimeError` (every op).
- **`RoleMembershipsQuery`** — two membership rows → `[{"roleName": …, "admin": bool}, …]` in name order; `admin_option=True` → `admin: true`. **Empty memberships** → `[]`.
- **`RolePrivilegesQuery`** — privilege rows → `[{"schema","table","privilege","grantable"}]`; `is_grantable="YES"` → `grantable: true`, `"NO"` → `false`. **No-privilege role** → `[]`.
- **`RoleAttributesQuery`** — present row → one `RoleSummary` dict; **absent role** (`_raw` empty) → `get_result()` returns `None` (the detail route then raises `NotFound` → 404 via the existing handler, [`main.py:68`](backend/app/main.py#L68)). Both the dict-mapping and the `None`-on-empty cases are offline-unit-testable.

### Frontend — live / manual-verify via chrome-devtools (DOM events, layout, rendering)

Run frontend `:5173` + backend `:8000` against a real Postgres. `RolesExplorerView` is a factory returning an `AccordionPanel` (there is no `RolesExplorerView` DOM class, and no `TabPanel` anywhere in this app), so scope DevTools queries to the roles deck page by its `id="roles"` (e.g. `#roles`, or the `AccordionPanel` under it) to avoid the coexisting Database view.

- A **second rail button** ("Roles", `users` glyph) appears below the Database button; its tooltip reads "Roles".
- Clicking it shows the Roles Card page (a tree of roles + an empty/"select a role" detail) and deselects the Database button; clicking Database returns to the explorer with **no roles-view residue**.
- Selecting a role populates the detail with its attributes, memberships, and privileges; selecting another role replaces them in place (no flicker, `loadData` re-render).
- A role with **no memberships / no privileges** shows only the attribute rows.
- A role with **expired-or-no `validUntil`** shows "—"; `connectionLimit -1` shows "No limit".
- Rapid role clicks never render a stale role (the `showRole` stale-guard).
- A backend error (e.g. permission denied on `role_table_grants`) surfaces in the status bar via `notifyError`, not as a blank panel.

---

## Verification

- **Backend:** `cd backend && pytest tests/test_roles.py tests/test_role_detail.py` — green; full `pytest` for regressions.
- **Frontend typecheck/build:** `cd frontend && npm run build` (or `tsc --noEmit`) clean.
- **Grep invariants:** `grep -rn "Form" frontend/src` → zero; `grep -c "ActivityView" frontend/src/shell/SqlAdminShell.ts` → reflects two views; `grep -rn "Command" backend/app/operations/roles.py backend/app/operations/role_detail.py` → zero (all `Query`).
- **Manual smoke (chrome-devtools):** the *Expected Behaviour* live list above, entry point = the new "Roles" rail button.

---

## Potential Challenges

- **Route ordering (tidy grouping, not a correctness requirement).** `/api/{connection_id}/roles` is a 2-segment path (like `/databases` at [`main.py:134`](backend/app/main.py#L134) and `/query` at [`:323`](backend/app/main.py#L323)); the schema/object routes are 3-segment with a literal suffix (`/api/{connection_id}/{database}/schemas`, [`main.py:151`](backend/app/main.py#L151)), so there is **no actual overlap** for FastAPI to mis-match. `/roles/{role}` would only collide with `{database}/schemas` if a database were literally named `roles` and `.../roles/schemas` were requested. Group the two `roles` routes with the other 2-segment routes for readability; ordering is not load-bearing.
- **Role-name binding safety.** The `{role}` path segment is bound as a **query parameter** (`$1`) in every detail op — never interpolated into SQL — so no identifier quoting/`quote_ident` is needed and injection is impossible; the role simply not existing yields `NotFound`.
- **`pg_roles` readability.** `pg_roles` (not `pg_authid`) is the non-privileged source; `role_table_grants` only returns grants the connection user may observe — a low-privilege connection legitimately sees fewer privileges. This is correct read-only behaviour, not a bug; surface backend errors via the status bar rather than masking them.
- **Glyph not pre-registered.** `setGlyph("users")` on the rail button resolves by name from the registry; the `users` glyph must be added to `Glyph.register(...)` in `SqlAdminShell.ts` ([:27](frontend/src/shell/SqlAdminShell.ts#L27)) or the icon renders blank (the `LIBRARY_NOTES.md` ToggleButton-glyph caveat already noted at [`ActivityBar.ts:112`](frontend/src/shell/ActivityBar.ts#L112) still applies — use `setGlyph`, which `ActivityBar` already does).

---

## Advisory (not a blocker) — rail-button tooltip via `showText: false`

The rail `ToggleButton`s currently pass `text: ""`, call `setGlyph`, and attach the tooltip manually with `Tooltip.attach(button, view.label)` ([`ActivityBar.ts:108`](frontend/src/shell/ActivityBar.ts#L108)–[:115](frontend/src/shell/ActivityBar.ts#L115)). Since Phase 2a adds a second rail button, there is an **optional** consistency cleanup: the library's `Button`/`ToggleButton` now support `showText: false` ([`button/Button.d.ts:16`](../../typescript-ui/dist/lib/types/component/button/Button.d.ts#L16), `setShowText`/`isShowText` at [:156](../../typescript-ui/dist/lib/types/component/button/Button.d.ts#L156)), where the `text` drives the tooltip and accessible name while the visible label is suppressed (`_rebuildTooltip` reads `text`; `_reflectAccessibleName` sets the aria-label). Passing the label as `text` with `showText: false` would let the rail drop the manual `Tooltip.attach` and gain an aria-label for free. **This is a refactor of `ActivityBar.ts` shared by both views, touching code outside the read-only feature — keep it out of the core Phase 2a change** and do it as a separate, independently-verified cleanup (re-test the Database tooltip too) if desired.

---

## Critical Files

- [`frontend/src/shell/ActivityBar.ts`](frontend/src/shell/ActivityBar.ts) — the `ActivityView` interface and registration loop the new view plugs into (do not modify for the core feature).
- [`frontend/src/shell/DatabaseExplorerView.ts`](frontend/src/shell/DatabaseExplorerView.ts) — the Card-page shape `RolesExplorerView` mirrors.
- [`frontend/src/properties/PropertiesPanel.ts`](frontend/src/properties/PropertiesPanel.ts) — the read-only key/value `MemoryStore`+`Table` pattern `RolesPropertiesPanel` copies.
- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts) — the `Tree` selection→controller wiring `RolesTree` mirrors.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — the mediator (`properties`/`showProperties`/`_propsSeq` stale-guard) the role detail copies.
- [`backend/app/operations/base.py`](backend/app/operations/base.py), [`list_objects.py`](backend/app/operations/list_objects.py), [`list_columns.py`](backend/app/operations/list_columns.py) — the `Query` three-phase contract the new ops follow.
- [`backend/app/main.py`](backend/app/main.py) — the `acquire → construct → apply → get_result` route shape.
- [`backend/app/contract.py`](backend/app/contract.py) — `ColumnMeta`/`to_contract()` the role dataclasses mirror.
- [`backend/tests/test_list_objects.py`](backend/tests/test_list_objects.py), [`tests/conftest.py`](backend/tests/conftest.py) — the `NO_CONN` + set-`_raw` test pattern.
- [`plans/implemented/tsui-sql-admin.md`](plans/implemented/tsui-sql-admin.md) (Card seam :61, Properties :449, Non-Goal :697) and [`plans/implemented/query-panels.md`](plans/implemented/query-panels.md) — the governing patterns.

---

## Non-Goals

- **Any mutation** — `CREATE`/`ALTER`/`DROP ROLE`, `GRANT`/`REVOKE`. All ops are `Query`, never `Command`. (That is a future Phase 2b.)
- **Password management** — `pg_roles` already blanks the password; no password field is read or shown.
- **Multi-connection fan-out** — only the single `"default"` connection seam, exactly like Phase 1.
- **A `Form` component** — the library has none; the detail panel is a plain key/value `MemoryStore`+`Table`, and `Binding`/`Bindable` is not introduced.
- **Modifying `ActivityBar.ts` for the core feature** — the rail is reused as-is; the `showText` tooltip cleanup is advisory only.
- **Column-level / routine / default privileges, and role-config (`rolconfig`) GUCs** — Phase 2a shows role attributes, memberships, and table grants only.
