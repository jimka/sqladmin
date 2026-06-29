---
depends-on:
  - tree-node-data
  - ajax-proxy-error-detail
  - dock-panel-lifecycle
---

# tsuiSQLAdmin (SQLAdmin) — Implementation Plan

## Overview

**tsuiSQLAdmin** ("SQLAdmin") is a phpMyAdmin-style PostgreSQL admin UI built as a *demo application* on top of this widget library, paired with a thin Python/FastAPI backend. It is almost entirely **composition of existing components** — `Border` shell, a VSCode-style **activity bar** in the left region (a vertical `ToolBar` of `ToggleButton`s selecting `Card` view containers), a lazy `Tree` navigator, `Dock` work area, `Table` data grid, `AjaxStore`/`AjaxProxy` with a custom `Reader`/`Writer`. **The app is a standalone external workspace** — its own repo with its own `package.json`, Vite/build setup, and FastAPI `backend/` — that declares `@jimka/typescript-ui` as a dependency and imports components through the package's subpath `exports` (e.g. `@jimka/typescript-ui/layout`, `/data`, `/component/table`). It does **not** live anywhere inside this library repo.

This plan covers **Phase 0** (backend contract + one real table rendered in a `Dock` data grid) and **Phase 1** (the full app shell). Phase 1.5 (arbitrary-SQL query panels) and Phase 2 (user/group management) are named only as seams/non-goals.

The library is already npm-publishable: [`package.json`](../package.json) declares `name: "@jimka/typescript-ui"` with a subpath `exports` map, `build:lib` emits `dist/lib` ES bundles + `.d.ts` types ([`package.json:95`](../package.json#L95)), `files: ["dist/lib"]` ([`package.json:85`](../package.json#L85)), and `sideEffects` pins `core.es.js` ([`package.json:89`](../package.json#L89)). The app consumes the **built** package, not this repo's `~/...` source paths.

The SQLAdmin effort needs **three** in-repo library plans, and **all three are now implemented & merged** — so **no in-repo library work remains** and the external app can be built against a published build:

- **`dock-panel-lifecycle` — implemented.** `Dock` originally offered no app-facing panel-lifecycle hook: a consumer could not learn when a panel closes (to dispose resources), could not programmatically focus an open panel, and could not programmatically remove one. That gap is closed — the sibling plan [`dock-panel-lifecycle.md`](./implemented/dock-panel-lifecycle.md) has landed (now under `plans/implemented/`), adding exactly the three additive `Dock` capabilities the app's dock disposal/dedup needs: a Dock-level **`"close"`** event (payload `DockPanelEvent { id, content, window }` — [`Dock.ts:98`](../src/typescript/lib/overlay/Dock.ts#L98), one of the `DockEvent`s `"attach" | "detach" | "moved" | "focus" | "close"` — [`Dock.ts:89`](../src/typescript/lib/overlay/Dock.ts#L89)), **`focusPanel(id): boolean`** ([`Dock.ts:1196`](../src/typescript/lib/overlay/Dock.ts#L1196)), and **`removePanel(id): boolean`** ([`Dock.ts:1230`](../src/typescript/lib/overlay/Dock.ts#L1230)). **This plan's `depends-on: dock-panel-lifecycle` is therefore satisfied** (see frontmatter): the app's dock disposal/dedup discipline can be built directly against the merged Dock surface.
- **`tree-node-data` — implemented.** The component-level `TreeNode` originally carried only `label`, `children`, `hasChildren`, `loadChildren` — no payload field to ride the database object identity (schema, table, kind) a navigator selection needs. That gap is closed — the sibling plan [`tree-node-data.md`](./implemented/tree-node-data.md) has landed (now under `plans/implemented/`), adding an optional `data?: unknown` field to `TreeNode` ([`component/tree/TreeNode.ts:58`](../src/typescript/lib/component/tree/TreeNode.ts#L58)), re-exported from [`component/tree/index.ts:5`](../src/typescript/lib/component/tree/index.ts#L5). **This plan's `depends-on: tree-node-data` is therefore satisfied** (see frontmatter): the navigator attaches each database object's `DbObjectRef` to `TreeNode.data` and reads it back from the Tree's selection event — no app-side side-map.
- **`ajax-proxy-error-detail` — implemented.** `AjaxProxy` now throws an exported `AjaxError` (carrying `status`, `statusText`, `body`, `operation`, `url`) on any `!response.ok`, via a shared `throwHttpError` helper across every proxy fetch site ([`AjaxProxy.ts:110`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L110) and the other op sites; helper at [`:334`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L334)). `AjaxError` lives at [`data/proxy/AjaxError.ts`](../src/typescript/lib/data/proxy/AjaxError.ts) and is re-exported from the `data` barrel ([`data/index.ts:31`](../src/typescript/lib/data/index.ts#L31)); the store's `'exception'`/`'sync'` `error` field carries that `AjaxError` unchanged (**no store change**). SQLAdmin's row-CRUD error surfacing (see *Error handling* below) relies on this, and **`depends-on: ajax-proxy-error-detail` is therefore satisfied** (see frontmatter — the sibling plan is at [`ajax-proxy-error-detail.md`](./implemented/ajax-proxy-error-detail.md)).

---

## Architecture Decisions

### Where the app lives — a standalone external workspace

SQLAdmin is **not** an entry inside this library repo. It is a separate project — its own git repo, its own `package.json`, its own Vite/build setup — that depends on `@jimka/typescript-ui` like any other consumer. Mixing a full application into this repo's *component gallery* ([`src/typescript/main.ts`](../src/typescript/main.ts), bootstrapped by [`index.html`](../index.html)) would muddy both and couple the app's release cadence to the library's. The app's own layout (in the external workspace, illustrative):

```
sqladmin/                    # the external app repo — NOT in this library repo
  package.json               # declares "@jimka/typescript-ui" as a dependency
  vite.config.ts             # the app's own Vite config + dev server
  index.html                 # the app's HTML entry
  src/
    SqlAdminApp.ts           # app bootstrap (builds shell + controller, mounts on Body)
    SqlAdminController.ts     # the mediator (see Frontend structure)
    shell/…  navigator/…  dock/…  data/…  contract.ts
  backend/                   # Python/FastAPI — alongside the app, in the SAME external workspace
    app/  pyproject.toml  …
```

Justification:
- **The app imports through the published subpath `exports`** ([`package.json:7`](../package.json#L7)) — `@jimka/typescript-ui/core`, `/layout`, `/overlay`, `/data`, `/component/table`, `/component/tree`, `/component/menubar`, `/component/button`, `/component/container`, `/primitive` — never this repo's `~/*` source aliases. Every bucket the app needs is verified present in the `exports` map (see *Imports* below).
- **`backend/` lives in the external app workspace**, alongside the app, not in this library repo. It is a separate runtime with its own dependency manager (`pyproject.toml`/`uv` or `requirements.txt`); it has nothing to do with this repo's `tsc`/Vite/ESLint/`cloc`/docs tooling.

This adds **no** files to this library repo at all (the in-repo changes the broader effort needs are the sibling library plans `tree-node-data`, `ajax-proxy-error-detail`, and `dock-panel-lifecycle` — all three implemented & merged, each covered by its own plan) — honoring "compose existing pieces; do not grow the library."

### The left region is an activity bar (ToolBar + Card), not a west-side `Tab`

The Border `WEST` region hosts a VSCode-style **activity bar**, not a bare navigator. Three existing pieces compose it:

1. A narrow vertical **`ToolBar`** as the *activity rail* — `new ToolBar({ orientation: "vertical" })` ([`ToolBar.ts:153`](../src/typescript/lib/component/menubar/ToolBar.ts#L153); `orientation` option at [`:43`](../src/typescript/lib/component/menubar/ToolBar.ts#L43)); the default is `"horizontal"` so the vertical orientation must be set explicitly. `ToolBar` extends `Container`, defaults `flat: true` ([`ToolBar.ts:86`](../src/typescript/lib/component/menubar/ToolBar.ts#L86)) for the flat-rail look, and already wires roving-tabindex arrow nav. It holds a group of **icon-only `ToggleButton`s** ([`component/button/ToggleButton.ts:27`](../src/typescript/lib/component/button/ToggleButton.ts#L27)) — one per view container. Note `ToggleButton`'s constructor is **positional**, `constructor(text: string, options?: ToggleButtonOptions)` ([`ToggleButton.ts:38`](../src/typescript/lib/component/button/ToggleButton.ts#L38)) — not options-only; an icon-only button is `new ToggleButton("", { glyph: … })`, **not** `new ToggleButton({ … })` (which won't compile). Each button fires `"action"`/`"change"` on toggle and exposes `isSelected` ([`ToggleButton.ts:126`](../src/typescript/lib/component/button/ToggleButton.ts#L126)) / `setSelected` ([`ToggleButton.ts:135`](../src/typescript/lib/component/button/ToggleButton.ts#L135)). The buttons form a mutually-exclusive group: selecting one deselects the rest (app-managed, the rail being a mode selector).
2. A **`Card`** layout ([`layout/Card.ts:25`](../src/typescript/lib/layout/Card.ts#L25)) as the *view-container host* — a deck showing exactly one view at a time. The active child is selected by id via `card.setVisibleComponentId(id)` ([`Card.ts:176`](../src/typescript/lib/layout/Card.ts#L176)); `getVisibleComponentId` reads it back. (Note: the selector is `setVisibleComponentId`, **not** a `setActive`.)
3. Clicking the **already-active** rail button collapses the whole sidebar (VSCode signature). Collapse routes through the Border `WEST` region's collapsible support — `border.setRegionCollapsed(Placement.WEST, true)` / `isRegionCollapsed(Placement.WEST)` ([`Border.ts:252,233`](../src/typescript/lib/layout/Border.ts#L252) (setRegionCollapsed=252, isRegionCollapsed=233)), enabled by `setRegionCollapsible(Placement.WEST, true)` ([`Border.ts:342`](../src/typescript/lib/layout/Border.ts#L342)) or the `collapsible: true` constraint on the region. The rail-button handler: if the clicked button was already selected → toggle the WEST region's collapsed state; otherwise → re-select it, `card.setVisibleComponentId(viewId)`, and ensure the region is expanded.

**Why ToolBar + Card and not a west-side `Tab`.** A `Tab` brings tear-off, reorder, close, and always-one-selected semantics — all wrong for a nav rail, which wants click-active-to-collapse and an icons-only, label-less affordance. `ToolBar` + `Card` gives exactly the rail's required behaviour (toggle group → `Card.setVisibleComponentId` + region collapse) with none of the tab baggage, and is the clean Phase-2 seam: adding a view container is one more rail `ToggleButton` + one more `Card` page, disturbing nothing else (see *Phase-2 view containers are a Card seam*). The rail ships in Phase 1 with a **single** button (the Database explorer) precisely because that one button is also the documented extension point — it is the seam, not speculative over-engineering.

### Phase-2 view containers are a Card seam

Phase 2 (users/groups/permissions browser) is a clean addition to the activity bar: one more `ToggleButton` on the rail + one more `Card` page, with **zero** disturbance to the Database explorer view. This is the entire reason the rail exists in Phase 1 despite starting with a single button. The users/groups browser itself stays in *Non-Goals* (Phase 2) — only the rail/`Card` seam is built now.

### Local-dev linking — `npm link` against the built `dist/lib`

Before any registry publish, the external app must resolve `@jimka/typescript-ui` from the local working copy. **Recommended: `npm link`.**

```bash
# in the library repo (this repo):
npm run build:lib        # emits dist/lib — what the package "files" ships
npm link                 # registers @jimka/typescript-ui as a global symlink

# in the external app repo:
npm link @jimka/typescript-ui
```

The app consumes the **built** `dist/lib` (the `exports` targets resolve to `dist/lib/*.es.js` + `dist/lib/types/`), **not** the library source — so a source change in this repo is invisible to the app until the library is rebuilt. Either re-run `npm run build:lib` after each change, or run it in a watch loop during active co-development. This is the one sharp edge of `npm link`: stale `dist/lib`.

Reproducible alternatives, when symlink resolution misbehaves (e.g. Vite optimizeDeps duplicating instances) or for CI: a **`file:` path dependency** (`"@jimka/typescript-ui": "file:../typescript-ui"` in the app's `package.json`, which installs from the built `dist/lib`), or an **`npm pack` tarball** (`npm pack` here → `npm install ../typescript-ui/jimka-typescript-ui-0.1.0.tgz` in the app) for a byte-exact preview of the published artefact. Both still require a fresh `build:lib`. Prefer `npm link` for the tight inner loop; reach for the tarball when reproducing a publish.

### Imports come from the published subpath buckets

Every library symbol the app uses is imported from a subpath in the `exports` map ([`package.json:7`](../package.json#L7)), never from `~/*`. Verified bucket → symbol mapping (each barrel re-export confirmed at write time):

| Symbol | App import | Barrel re-export (verified) |
|---|---|---|
| `Panel`, `Body`, `Binding`, `Bindable` | `@jimka/typescript-ui/core` | [`core/index.ts:19,24,36,38`](../src/typescript/lib/core/index.ts#L19) (Binding=36; Bindable=38, a type-only `export type` — use `import type { Bindable }`) — **note: `Binding`/`Bindable` are in `core`, not `data`** |
| `Placement` | `@jimka/typescript-ui/primitive` | [`primitive/index.ts:9`](../src/typescript/lib/primitive/index.ts#L9) — **note: `Placement` is in `primitive`, not `layout`** |
| `Accordion`, `AccordionConstraints`, `Border`, `Card` | `@jimka/typescript-ui/layout` | [`layout/index.ts:15,17,22,45`](../src/typescript/lib/layout/index.ts#L15) (Accordion=15, AccordionConstraints=17, Border=22, Card=45) |
| `Dock` (+ `DockPanelSpec`) | `@jimka/typescript-ui/overlay` | [`overlay/index.ts`](../src/typescript/lib/overlay/index.ts) |
| `MenuBar`, `ToolBar` | `@jimka/typescript-ui/component/menubar` | [`component/menubar/index.ts:3,6`](../src/typescript/lib/component/menubar/index.ts#L3) (MenuBar=3, ToolBar=6) |
| `ToggleButton` | `@jimka/typescript-ui/component/button` | [`component/button/index.ts:5`](../src/typescript/lib/component/button/index.ts#L5) — **note: `ToggleButton` is in `component/button`, not `menubar`** |
| `StatusBar` | `@jimka/typescript-ui/component/container` | [`component/container/index.ts:17`](../src/typescript/lib/component/container/index.ts#L17) |
| `Table`, `ColumnConfig`, `ColumnSpec`, `ComboOption` | `@jimka/typescript-ui/component/table` | [`component/table/index.ts:3,10`](../src/typescript/lib/component/table/index.ts#L3) |
| `Tree`, `TreeNode` | `@jimka/typescript-ui/component/tree` | [`component/tree/index.ts:3,5`](../src/typescript/lib/component/tree/index.ts#L3) |
| `Field`, `Model`, `SortDescriptor`, `FilterDescriptor`, `AjaxStore`, `MemoryStore`, `AjaxProxy`, `JsonReaderOptions`, `JsonReader`, `Writer`, `StoreExceptionEvent`, `StoreSyncEvent`, `StoreOperation`, `AjaxError` | `@jimka/typescript-ui/data` | [`data/index.ts:4–36`](../src/typescript/lib/data/index.ts#L4); `AjaxError` re-exported at [`data/index.ts:31`](../src/typescript/lib/data/index.ts#L31) (from the implemented [`ajax-proxy-error-detail.md`](./implemented/ajax-proxy-error-detail.md)) |

All of `core`, `primitive`, `layout`, `overlay`, `component/menubar`, `component/button`, `component/container`, `component/table`, `component/tree`, `data` are present in the `exports` map (`./component/button` at [`package.json:36`](../package.json#L36)).

**`TreeNode.data` (already landed):** the `data` field is part of the `TreeNode` interface re-exported from [`component/tree/index.ts:5`](../src/typescript/lib/component/tree/index.ts#L5) ([`tree-node-data.md`](./implemented/tree-node-data.md) is merged); the app picks it up through the `@jimka/typescript-ui/component/tree` import after a `build:lib`. No new bucket is needed. (General rule for the implementer: the app cannot import a symbol a barrel does not re-export — if a needed symbol is missing from its bucket's `index.ts`, that is a library-side barrel addition to flag, not an app-side assumption.)

### Reader/Writer is the FastAPI ⇄ proxy bridge — not param-dialect bending

The library's `AjaxProxy` ([`data/proxy/AjaxProxy.ts:44`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L44)) emits a **fixed read request shape** and parses responses through a pluggable `Reader`/`Writer`. The exact contract the proxy sends (verified from source):

- **Read URL** (`buildReadUrl`, [`AjaxProxy.ts:131`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L131)) appends, via `URLSearchParams`, only when present:
  - `page=<number>` and `pageSize=<number>` (pagination; set whenever `params.page`/`params.pageSize` exist),
  - `sort=<JSON.stringify(SortDescriptor[])>` (only when `remoteSort` is on and sorters exist),
  - `filter=<JSON.stringify(FilterDescriptor[])>` (only when `remoteFilter` is on and filters exist).
  - HTTP method defaults to `GET`; `params.signal` (an `AbortSignal`) is threaded into `fetch` so a superseded read aborts.
- **`SortDescriptor`** ([`AbstractStore.ts:115`](../src/typescript/lib/data/AbstractStore.ts#L115)): `{ field: string; dir: 'asc' | 'desc'; sorterFn?: … }` — `sorterFn` is a function and is silently dropped by `JSON.stringify`, so the wire form is `{field, dir}`.
- **`FilterDescriptor`** ([`FilterDescriptor.ts:10`](../src/typescript/lib/data/FilterDescriptor.ts#L10)): a tagged union — `{type:'eq'|'neq'|'gt'|'gte'|'lt'|'lte', field, value}`, `{type:'contains'|'startsWith', field, value, caseSensitive?}`, `{type:'in', field, values}`, and the composites `{type:'and'|'or', filters}` / `{type:'not', filter}`.

The proxy then hands the parsed JSON body to the **`Reader`** ([`data/proxy/Reader.ts:31`](../src/typescript/lib/data/proxy/Reader.ts#L31)):

```typescript
interface Reader { read(raw: any, paginated: boolean): ReadResult; }
interface ReadResult { records: any[]; total?: number; success?: boolean; message?: string; }
```

— `read` receives the already-`JSON.parse`d body and a `paginated` flag (`true` when the request carried `page`/`pageSize`), and must return `ReadResult`. The proxy stores `result.total` and returns `result.records` ([`AjaxProxy.ts:113`–`119`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L113)).

The **`Writer`** ([`data/proxy/Writer.ts:15`](../src/typescript/lib/data/proxy/Writer.ts#L15)):

```typescript
interface Writer {
    writeRecord(record: ModelRecord): string;       // body for create/update
    writeRecords(records: ModelRecord[]): string;   // body for *Batch ops
}
```

— returns the **request body string** for create (`POST {url}`), update (`PUT {url}/{id}` where `id = record.getId()`), and the batch ops. `destroy` sends `DELETE {url}/{id}` with no body (no `Writer` involvement). Create/update parse the response with `this._root ? json[root] : json` directly — **not** through the `Reader` — and return the unwrapped object.

**Decision:** FastAPI emits its natural REST shape; we reconcile on the read path with a **configured `JsonReader`** and on the write path with a **custom `SqlAdminWriter`**, rather than forcing FastAPI to mirror the proxy's defaults. Concretely:
- FastAPI's list endpoint returns `{ "rows": [...], "totalCount": N }` (natural FastAPI/pydantic naming). The default `JsonReader` needs only `rootProperty:'rows'`, `totalProperty:'totalCount'` — which `JsonReader` already supports via `JsonReaderOptions` ([`Reader.ts:50`](../src/typescript/lib/data/proxy/Reader.ts#L50)). A **configured `JsonReader({ rootProperty: 'rows', totalProperty: 'totalCount' })` is the read path** — no bespoke reader is written. The two original justifications for a custom `SqlAdminReader` are both gone: (a) read errors do **not** flow through the Reader at all — `AjaxProxy.read` throws on `!response.ok` *before* it ever calls `reader.read` ([`AjaxProxy.ts:109`–`110`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L109)), so the reader never sees a non-2xx body to surface (see *Error handling* decision); and (b) Postgres-type coercion is now the backend's job in `get_result()` (see *Backend data access* and *Postgres types → contract*), so the reader receives already-contract-typed scalars. With neither justification standing, the custom reader is **dropped**; the configured `JsonReader` suffices for Phase 0–1.
- `SqlAdminWriter.writeRecord` serializes `record.getData()` but **omits server-managed columns** (a Postgres `serial`/`identity` PK on insert, generated columns) so FastAPI's `INSERT` does not fight the sequence. This is the concrete reason a custom Writer earns its place over `JsonWriter` — and the one piece of the seam that **remains**.

This keeps the **front-end decoupled from FastAPI's exact JSON shape**: changing the list envelope keys is a `JsonReader` option change, never a proxy or store change.

### Error handling — store events + `AjaxError`, not in-envelope status

Row-CRUD errors do **not** surface through the Reader or an in-envelope `success`/`message` field. `AjaxProxy.read` throws on `!response.ok` **before** the Reader runs ([`AjaxProxy.ts:109`–`110`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L109)), so the Reader can never see a non-2xx error body. The real mechanism is the store's first-class error reporting plus the enriched proxy error:

- **Row-CRUD errors → store events carrying an `AjaxError`.** `AbstractStore` already reports failures: `load()` emits an `'exception'` event (`StoreExceptionEvent { operation, records, error }` — [`AbstractStore.ts:50`](../src/typescript/lib/data/AbstractStore.ts#L50), emitted at [`AbstractStore.ts:346`](../src/typescript/lib/data/AbstractStore.ts#L346)) and rethrows on a genuine failure ([`AbstractStore.ts:348`](../src/typescript/lib/data/AbstractStore.ts#L348)); `sync()` collects per-op write failures into a `'sync'` event (`StoreSyncEvent { failures: StoreExceptionEvent[] }` — [`AbstractStore.ts:96`](../src/typescript/lib/data/AbstractStore.ts#L96), emitted at [`AbstractStore.ts:1097`](../src/typescript/lib/data/AbstractStore.ts#L1097)). `StoreOperation` is `'read'|'create'|'update'|'destroy'` ([`AbstractStore.ts:37`](../src/typescript/lib/data/AbstractStore.ts#L37)). The `error` field carries the raw thrown value verbatim, which — now that the implemented [`ajax-proxy-error-detail.md`](./implemented/ajax-proxy-error-detail.md) has landed — is an **`AjaxError`** with `status` plus the backend's parsed `body` (e.g. FastAPI `{detail}`). **The store is NOT extended** — this is existing API; the app only registers listeners.
- **Introspection errors surface differently.** Introspection does **not** go through the proxy/store at all (see *Frontend structure*); its `data/api.ts` fetch client reads the error body directly and throws/returns the backend `detail`.
- **A consistent backend error contract.** The backend defines a small exception taxonomy — `ValidationError`→422, `NotFound`→404, integrity/unique violation→409 — and a single FastAPI exception handler maps each to the matching HTTP status with a `{ "detail": … }` JSON body (see *Backend Structure*: operations raise the typed exception; the handler maps it). So every error the app sees is `(status, {detail})`, whether it arrives as an `AjaxError` (row CRUD) or off an `api.ts` catch (introspection).
- **One error sink.** All app-side errors — every row store's `'exception'`/`'sync'` and every `api.ts` catch — funnel to a single `SqlAdminController.notifyError`, which renders them to the StatusBar / a toast. No error path is handled ad-hoc at a component.

### Multi-database seam without single-DB hard-coding

PostgreSQL is the only backend Phase 0–1, but the contract must not bake "one database" into types. The seam is a **`connectionId` (or DSN handle) carried as a path/query prefix**, not a global:

- Schema-introspection endpoints are namespaced `/{connectionId}/databases`, `/{connectionId}/schemas`, etc. Phase 0–1 ships exactly one connection (`"default"`), so every URL begins `/api/default/…` — but the route shape already admits more.
- The backend keeps a tiny `pools: dict[str, asyncpg.Pool]` registry keyed by `connectionId`; Phase 0 seeds one entry from env (`DATABASE_URL`). No driver abstraction beyond "look up a pool by id" — that is the *small abstraction that avoids hard-coding* without over-engineering. We do **not** add a dialect-translation layer, a plugin system, or per-DB feature flags now.

### Backend data access — `asyncpg`, not SQLAlchemy

The backend uses **`asyncpg`** directly — native async, fast, no ORM weight for what is a thin pass-through. SQLAlchemy Core is **not** pulled in. The one place a query builder would have earned its keep — composing `WHERE`/`ORDER BY` from the `FilterDescriptor`/`SortDescriptor` JSON — is handled instead by a small, **pure** compiler:

- **Values** are never interpolated: asyncpg binds them as positional `$1, $2, …` parameters.
- **Identifiers** (table/column names) cannot be parameterized in *any* driver, so they are **validated against the introspected column set** (the only legal identifiers) and additionally passed through a tiny `quote_ident()` (double-quote, escape embedded `"`) as defense-in-depth. Validation happens in the operation constructor — before any I/O.
- `FilterCompiler` (`FilterDescriptor` → `(sql_fragment, params)`) and `OrderCompiler` (`SortDescriptor[]` → `ORDER BY` clause) are **pure functions** of `(descriptor, validated columns, bind-index)` — no DB, trivially unit-tested.
- Paginated `totalCount` comes from `count(*) OVER()` in the same row query — no second round-trip.
- **The backend NEVER returns raw Postgres/asyncpg values.** asyncpg decodes Postgres types to native Python objects (`Decimal`, `datetime`, `UUID`, `bytes`, `list`, …) that do not serialize to the contract verbatim. Each operation's **pure `get_result()`** maps every native value into the defined `WireType` contract scalar (see *Public API*): `Decimal`→string preserving precision **or** number (decided per column at introspection time, recorded in `ColumnMeta.wireType`), `timestamptz`/`timestamp`/`date`/`time`→ISO-8601 string, `uuid`→string, `jsonb`/`json`→passthrough, `bytea`→base64 string, arrays→JSON arrays. This is a *transformation* responsibility — it fits squarely in `get_result()`'s pure transform phase (CQRS read/write transform), **not** a leak of raw rows into the response. Because the wire contract is fixed, the frontend `Model`/`Field` types mirror the contract (`WireType`), never Postgres — and the read-path `JsonReader` receives already-contract-typed scalars (the reason no app-side scalar coercion is needed; see *Reader/Writer*).

### Backend handler structure — CQRS `Query` / `Command` operations

Every endpoint's work is a single operation object with a strict three-phase contract that separates I/O from transformation for testability:

- **Constructor takes *all* inputs — including the `asyncpg` connection — and validates them.** Identifier checks, required-param checks, and `Filter`/`Order` compilation all happen here, so an invalid request raises *before* touching the DB. After construction the object is a self-contained, single-use unit of work.
- **`async def apply(self)`** — nullary; executes against the instance's connection and stores the raw driver result in an instance var. Raises on I/O failure. This is the *only* async, I/O-bearing method.
- **`def get_result(self)`** — nullary and **sync/pure**; transforms the stored raw result into the response payload. Raises if called before `apply()` populated the raw result (a cheap temporal-coupling guard). Because it is pure, it is unit-testable by hand-feeding the raw-result instance var, with **no database at all**.

Two base classes share this contract: **`Query`** (reads — `apply` runs `SELECT`s, no transaction) and **`Command`** (writes — `apply` wraps its statements in a transaction on the connection). There is deliberately **no** `run()` convenience that fuses `apply()` + `get_result()`: the route calls them in sequence (`await op.apply(); return op.get_result()`), which is clear on its own and keeps each method single-responsibility. FastAPI routes become thin: acquire a connection from the pool, construct the operation (which validates), `await apply()`, return `get_result()`, mapping domain exceptions to HTTP status.

### Navigator object identity rides on `TreeNode.data`

The navigator attaches each database object's `DbObjectRef` to the node's `data` field as the node is constructed in `loadChildren`, and reads it back from `Tree.on("selection", nodes => …)` ([`Tree.ts:191`](../src/typescript/lib/component/tree/Tree.ts#L191)), which hands back the same `TreeNode` objects the app authored. `data` is opaque to the tree (never read for identity/dedup — the tree keys nodes by object reference), so it is a passive carrier of "schema=public, table=orders, kind=table".

This relies on the `data?: unknown` field added by the sibling plan [`tree-node-data.md`](./implemented/tree-node-data.md), **now merged** ([`TreeNode.ts:58`](../src/typescript/lib/component/tree/TreeNode.ts#L58)); this plan's frontmatter records the (now-satisfied) `depends-on` relationship. *(Earlier drafts of this plan used an app-side `Map<TreeNode, DbObjectRef>` side-map as a no-library-change workaround; that is superseded by `TreeNode.data`.)*

### Dock panels own their toolbar inline; no focus-driven visibility

Each table opened from the navigator becomes a `DockPanelSpec` whose `content` is an app-defined `TableWorkPanel` (a `Panel` with a `Border` layout: its own `ToolBar` at `NORTH`, a `Card`/`Tab` body switching data-grid vs. structure at `CENTER`). The toolbar is a **child of the panel**, always present. Focus-based show/hide is explicitly deferred — the design simply must not *preclude* it (the toolbar is a discrete child component, so a later experiment can toggle its visibility), but no focus wiring is built now.

### Frontend structure — mediator + two data paths + one error sink

The app source is organized around a single mediator, two explicitly-separate data paths, and one error sink. The approved directory shape (in the external app's `src/`):

```
src/
  SqlAdminApp.ts           # bootstrap: build shell + controller, mount on Body
  SqlAdminController.ts     # the mediator
  shell/   ActivityBar.ts  DatabaseExplorerView.ts  PropertiesPanel.ts  SqlAdminShell.ts
  navigator/ NavigatorTree.ts
  dock/    TableWorkPanel.ts
  data/    api.ts  SqlAdminWriter.ts  buildModel.ts  stores.ts
  contract.ts
```

Three patterns hold this together:

- **One mediator (`SqlAdminController`).** The controller owns the app's mutable state — the `Dock` reference, the open-panel registry (deduped by `panelId`), and the current connection — and wires navigator selection → `openTable(ref)`. Components stay dumb: the navigator merely *emits* a selection, the controller *decides* what to do with it (open a panel, focus an existing one, update Properties). The `openTable` sketch and the `panelId` dedup below live **on the controller**, not free functions.
- **Two explicitly-separate data paths.** (1) **Introspection** goes through `data/api.ts` — a plain typed `fetch` client that reads error bodies directly and returns `contract.ts` types (databases/schemas/objects/columns). It does **not** touch the proxy or a store. (2) **Row CRUD** goes through `AjaxStore`/`AjaxProxy` (one store per open table, built in `data/stores.ts`). Naming the split is deliberate — earlier drafts blurred "the backend" into one undifferentiated client; they are two clients with two error styles (see *Error handling*).
- **One error sink + disposal discipline.** Every row store's `'exception'`/`'sync'` and every `api.ts` catch funnel to `SqlAdminController.notifyError` → StatusBar/toast — a single choke point, no per-component error handling. Disposal hangs off a single `dock.on("close", ({ id }) => this.disposePanel(id))` subscription wired in the controller constructor (no per-spec `onClose`), and re-open dedup off `dock.focusPanel(id)` — **both from the implemented `dock-panel-lifecycle` dependency** (`"close"` event + `focusPanel`/`removePanel`). On a Dock-panel **close** — genuine destruction — `disposePanel` aborts any in-flight load (the proxy already threads `params.signal` into `fetch`), releases its listeners, and drops it from the registry, so a closed table leaks nothing. (A tear-off to a float fires `"detach"`, not `"close"` — the panel survives, so its store is *not* disposed; the controller may also observe `"detach"`/`"attach"`/`"focus"`, but disposes only on `"close"`.)

### Phase-1.5 query panels are a seam, not a feature

`Dock.addPanel` ([`Dock.ts:262`](../src/typescript/lib/overlay/Dock.ts#L262)) takes any `DockPanelSpec` whose `content` is an arbitrary `Component`. A future "run SQL → arbitrary result grid" panel is just *another* `DockPanelSpec` with a different `content` component and its own store. Nothing in the Phase-1 dock or panel design assumes panels are table-bound. We add **no** query UI now.

---

## Public API (TypeScript Signatures)

No **library** API changes in this plan (the `TreeNode.data` field is delivered by [`tree-node-data.md`](./implemented/tree-node-data.md)). The app defines these app-level types in its own external workspace, not exported from any library barrel:

```typescript
// src/contract.ts — the wire contract mirrored on the TS side
type DbObjectKind = "database" | "schema" | "table" | "view";

interface DbObjectRef {
    connectionId: string;   // "default" in Phase 0–1; the multi-DB seam
    database?:    string;
    schema?:      string;
    name?:        string;   // table/view name
    kind:         DbObjectKind;
}

// FastAPI list-envelope (what the configured JsonReader parses)
interface TableListEnvelope {
    rows:       Record<string, any>[];
    totalCount: number;
}

// One column's introspected metadata (drives Model + ColumnSpec generation)
interface ColumnMeta {
    name:        string;
    dataType:    string;     // Postgres type name, e.g. "integer", "text", "timestamptz"
    nullable:    boolean;
    isPrimaryKey:boolean;
    isGenerated: boolean;    // serial / identity / generated — omitted from INSERT body
    wireType:    WireType;   // the contract scalar a row value of this column arrives as
}

// The fixed contract scalar set. The backend NEVER emits a raw Postgres/asyncpg
// value; get_result() maps every native value into one of these (see Backend
// data access). The frontend Model/Field types mirror this set, not Postgres.
type WireType =
    | "number"     // smallint/int/bigint/real/double, and numeric mapped to number
    | "string"     // text/varchar/char/uuid (uuid→string), and numeric mapped to string (precision-preserving)
    | "boolean"    // bool
    | "isoString"  // timestamptz/timestamp/date/time → ISO-8601 string
    | "json"       // json/jsonb → passthrough (object/array/scalar)
    | "base64"     // bytea → base64 string
    | "jsonArray"; // Postgres array → JSON array
```

The **read path uses the library's configured `JsonReader`** — no app reader is defined (see *Reader/Writer* decision). Only the writer is bespoke:

```typescript
// app: src/data/SqlAdminWriter.ts — imports { Writer } from '@jimka/typescript-ui/data'
class SqlAdminWriter implements Writer {
    constructor(generatedColumns: ReadonlySet<string>);  // names to strip on insert
    writeRecord(record: ModelRecord): string;
    writeRecords(records: ModelRecord[]): string;
}
```

This implements the library's `Writer` interface ([`Writer.ts:15`](../src/typescript/lib/data/proxy/Writer.ts#L15)); it is passed to `AjaxProxy`/`AjaxStore` via the existing `writer` option, and the read side passes a `new JsonReader({ rootProperty: 'rows', totalProperty: 'totalCount' })` ([`Reader.ts:50`](../src/typescript/lib/data/proxy/Reader.ts#L50)) through the existing `reader` option ([`AjaxProxy.ts:71`–`72`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L71)).

No new DOM property, no new theme token: the app uses existing component setters and the library's theme tokens. (If a SQLAdmin-specific accent is wanted later, it routes through `Theme.ts` like any token — but Phase 0–1 reuse the defaults.)

---

## Backend Contract (FastAPI)

Thin, stateless-per-request, **`asyncpg`** for introspection + CRUD (see *Backend data access* decision). All routes under `/api/{connectionId}`. Every endpoint's work is a CQRS `Query`/`Command` operation (see *Backend handler structure* and *Backend Structure* below).

### Schema introspection (feeds the lazy navigator)

| Method/Route | Returns | Source |
|---|---|---|
| `GET /api/{conn}/databases` | `[{name}]` | `pg_database` (filter `datistemplate=false`) |
| `GET /api/{conn}/{database}/schemas` | `[{name}]` | `information_schema.schemata` |
| `GET /api/{conn}/{database}/{schema}/objects` | `[{name, kind}]` | `information_schema.tables` (`table_type` → `table`/`view`) |
| `GET /api/{conn}/{database}/{schema}/{table}/columns` | `[ColumnMeta]` | `information_schema.columns` + `pg_catalog` for PK / generated |

These map 1:1 onto the navigator's lazy levels (database → schema → table/view), and `/columns` drives the `Model` + `ColumnSpec` the data grid needs.

### Table data CRUD (one table, Phase 0)

All read params come straight off the proxy's emitted query string (see *Reader/Writer* decision):

| Method/Route | Request | Response |
|---|---|---|
| `GET /api/{conn}/{db}/{schema}/{table}/rows?page&pageSize&sort&filter` | `sort`=JSON `SortDescriptor[]`, `filter`=JSON `FilterDescriptor[]` | `{ rows: [...], totalCount: N }` |
| `POST /api/{conn}/{db}/{schema}/{table}/rows` | body = `SqlAdminWriter.writeRecord` (PK/generated omitted) | created row object |
| `PUT  /api/{conn}/{db}/{schema}/{table}/rows/{id}` | body = full record data | updated row object |
| `DELETE /api/{conn}/{db}/{schema}/{table}/rows/{id}` | — | 204 |

The backend translates the `sort`/`filter` JSON into a **parameterized** `ORDER BY` / `WHERE` (never string-interpolated — identifiers validated against the introspected column set, values bound as parameters). `{id}` is matched against the introspected PK column(s).

**Note on `{url}/{id}`:** the proxy builds update/destroy URLs as `` `${url}/${id}` `` ([`AjaxProxy.ts:208`,`231`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L208)). So the store's `url` must be the **collection** URL `…/{table}/rows`, and FastAPI must mount `…/rows/{id}` for update/delete — which the table above does.

### Backend Structure (CQRS operation handlers)

Each route delegates to one operation object (see *Backend handler structure* decision). The base contract:

```python
# backend/app/operations/base.py
class Operation:
    """Single backend unit of work. ALL inputs — incl. the asyncpg connection —
    arrive via __init__, which also validates them. apply() does the I/O and
    stores the raw driver result; get_result() purely transforms it. No run()."""

    async def apply(self) -> None:          # only async, I/O-bearing method
        raise NotImplementedError
    def get_result(self):                   # sync, pure transform
        raise NotImplementedError

class Query(Operation):
    """A read. apply() runs SELECTs; no transaction."""

class Command(Operation):
    """A write. apply() wraps statements in `async with self._conn.transaction()`."""
```

A concrete read, showing the three phases + the pure compilers:

```python
# backend/app/operations/list_rows.py
class ListRowsQuery(Query):
    def __init__(self, conn, table: TableRef, page, page_size, sort, filter, columns):
        self._conn   = conn
        self._table  = table
        # validation + clause compilation happen HERE — before any I/O:
        self._where, self._params = FilterCompiler(filter, columns).compile()   # raises on bad identifier
        self._order               = OrderCompiler(sort, columns).compile()
        self._limit, self._offset = page_size, (page - 1) * page_size
        self._raw = None

    async def apply(self):
        sql = (f'SELECT *, count(*) OVER() AS __total '
               f'FROM {quote_ident(self._table.schema)}.{quote_ident(self._table.name)} '
               f'{self._where} {self._order} LIMIT ${len(self._params)+1} OFFSET ${len(self._params)+2}')
        self._raw = await self._conn.fetch(sql, *self._params, self._limit, self._offset)

    def get_result(self) -> dict:
        if self._raw is None:
            raise RuntimeError("get_result() called before apply()")
        rows  = [dict(r) for r in self._raw]
        total = rows[0]["__total"] if rows else 0
        for r in rows:
            r.pop("__total", None)
            to_wire(r, self._columns)   # map asyncpg native values → WireType contract scalars
        return {"rows": rows, "totalCount": total}
```

The `to_wire(row, columns)` step is the pure type-mapping of *Backend data access* — `Decimal`/`datetime`/`UUID`/`bytes`/array → the column's `WireType` — so the response carries contract scalars, never raw asyncpg objects.

The route stays thin (acquire → construct → `apply` → `get_result`):

```python
@router.get("/api/{conn}/{db}/{schema}/{table}/rows")
async def list_rows(conn, db, schema, table, page=1, pageSize=100, sort=None, filter=None):
    async with pools[conn].acquire() as c:                  # one connection per request
        columns = await ListColumnsQuery(c, TableRef(db, schema, table)).run_for_columns()  # introspection
        op = ListRowsQuery(c, TableRef(db, schema, table), page, pageSize,
                           parse_sort(sort), parse_filter(filter), columns)
        await op.apply()
        return op.get_result()      # FastAPI serializes the {rows, totalCount} dict
```

(`Command`s — `InsertRowCommand`, `UpdateRowCommand`, `DeleteRowCommand` — follow the same shape; their `apply()` opens a transaction and `get_result()` returns the affected row / nothing.)

#### Pool lifecycle (FastAPI `lifespan`)

The `asyncpg.Pool`(s) are owned by the app's lifespan, not opened per request: a FastAPI `lifespan` opens the pool(s) on startup (one per `connectionId` in the registry, seeded from `DATABASE_URL`) and closes them on shutdown. Each route `acquire()`s a connection from the relevant pool for the duration of the request and hands it to the operation constructor (as the route above shows) — consistent with the CQRS handler contract where the connection is a constructor input.

```python
@contextlib.asynccontextmanager
async def lifespan(app):
    for conn_id, dsn in connection_dsns().items():     # seeded from DATABASE_URL
        pools[conn_id] = await asyncpg.create_pool(dsn)
    yield
    for pool in pools.values():
        await pool.close()
```

#### Error contract (typed exceptions → one handler)

Operations raise a small **exception taxonomy** — `ValidationError` (bad identifier / param / filter), `NotFound` (PK miss on update/delete), and integrity/unique violation (caught from asyncpg's `UniqueViolationError` / integrity error) — and a **single FastAPI exception handler** maps each to the matching HTTP status with a `{ "detail": … }` JSON body:

| Domain exception | HTTP status | Body |
|---|---|---|
| `ValidationError` | 422 | `{ "detail": "<message>" }` |
| `NotFound` | 404 | `{ "detail": "<message>" }` |
| integrity / unique violation | 409 | `{ "detail": "<message>" }` |

This is the backend half of the *Error handling* decision: the frontend's `AjaxError.status` + `AjaxError.body.detail` (row CRUD) and the `api.ts` catch (introspection) both consume this one `(status, {detail})` contract.

---

## Internal Structure

### Phase 1 shell (`SqlAdminShell` — a `Panel` with `Border`)

```
Body
└─ SqlAdminShell (Panel, Border layout)
   ├─ NORTH  : MenuBar          (setMenus([...]))  — File / View / Tools (Tools→Phase-1.5 seam, stubbed/disabled)
   ├─ WEST   : ActivityBar       (the left region; collapsible:true) — see below
   ├─ CENTER : Dock              (work area; empty initially)
   └─ SOUTH  : StatusBar         (setMessage(...) for connection + row counts)
```

Region assignment uses `addComponent(child, { placement: Placement.NORTH|WEST|CENTER|SOUTH, collapsible? })`, exactly as the gallery's [`BorderPanel.ts`](../src/typescript/BorderPanel.ts) does. The `WEST` region is made collapsible (`collapsible: true`, or `border.setRegionCollapsible(Placement.WEST, true)` — [`Border.ts:342`](../src/typescript/lib/layout/Border.ts#L342)) so the activity-rail can collapse it. `Border` is imported aliased from the layout bucket (`import { Border as BorderLayout } from '@jimka/typescript-ui/layout'`) to avoid the primitive `Border` name clash (per [`Border.ts:49`](../src/typescript/lib/layout/Border.ts#L49)); `Placement` comes from `@jimka/typescript-ui/primitive`.

### Activity bar (the `WEST` region — VSCode-style rail + view-container deck)

```
ActivityBar (Panel, Border layout)
├─ WEST   : ToolBar { orientation:"vertical" }   — the activity RAIL
│            └─ group of icon-only ToggleButtons (one per view container)
│               • Phase 1: a single "Database" button
└─ CENTER : Card  — the view-container HOST (deck; one view at a time)
             └─ DatabaseExplorerView   (the only page in Phase 1)
```

- The **rail** is a `new ToolBar({ orientation: "vertical" })` ([`ToolBar.ts:153`](../src/typescript/lib/component/menubar/ToolBar.ts#L153); `orientation` option at [`:43`](../src/typescript/lib/component/menubar/ToolBar.ts#L43); default `"horizontal"`, so set it), `flat` by default ([`ToolBar.ts:86`](../src/typescript/lib/component/menubar/ToolBar.ts#L86)), holding icon-only `ToggleButton`s ([`ToggleButton.ts:27`](../src/typescript/lib/component/button/ToggleButton.ts#L27)). Arrow-key roving-tabindex nav is built into `ToolBar`.
- The **deck** is a `Card` ([`Card.ts:25`](../src/typescript/lib/layout/Card.ts#L25)); the active page is chosen with `card.setVisibleComponentId(viewId)` ([`Card.ts:176`](../src/typescript/lib/layout/Card.ts#L176)).
- Each rail button's `"action"` handler (the rail is a **mode selector**, app-managed mutual exclusion via `setSelected`):
  - clicked button **was already selected** → toggle the shell's `WEST` region collapsed state (`shellBorder.setRegionCollapsed(Placement.WEST, !shellBorder.isRegionCollapsed(Placement.WEST))` — [`Border.ts:252,233`](../src/typescript/lib/layout/Border.ts#L252) (setRegionCollapsed=252, isRegionCollapsed=233));
  - **otherwise** → deselect the others, `card.setVisibleComponentId(viewId)`, and ensure `WEST` is expanded (`setRegionCollapsed(Placement.WEST, false)`).
- The rail deliberately is **not** a `Tab` (see *The left region is an activity bar* decision). Adding a Phase-2 view container is one more `ToggleButton` + one more `Card` page.

### Database explorer view (the first Card page — an `Accordion`)

```
DatabaseExplorerView (Component, Accordion layout)
  Accordion { singleOpen:false, fillHeight:true }
  ├─ Section "Navigator"  : the lazy Tree (object navigator)
  └─ Section "Properties" : read-only key/value panel (selection-driven)
```

- The view is laid out by an `Accordion` ([`Accordion.ts:137`](../src/typescript/lib/layout/Accordion.ts#L137)) configured `singleOpen: false` and `fillHeight: true` ([`AccordionOptions`, `Accordion.ts:86–96`](../src/typescript/lib/layout/Accordion.ts#L86)) so both sections stay open at once and share the available height (the VSCode explorer/outline feel). Sections are added via `addComponent(content, new AccordionConstraints(label, initiallyOpen))` ([`AccordionConstraints.ts:30`](../src/typescript/lib/layout/AccordionConstraints.ts#L30)).
- **"Navigator" section** — the object navigator: the lazy `Tree` specced below (relocated here from the bare `WEST` region of earlier drafts).
- **"Properties" section** — a **read-only, context-sensitive key/value panel** reflecting the currently selected navigator object (a table → name / schema / owner / estimated row count / size / comment; a column → type / nullable / default). It binds to the Tree's `"selection"` event reading `node.data as DbObjectRef`. **Verification item — binding approach:** the library has no confirmed dedicated `Form` component; the panel is therefore a **simple key/value layout** (a `VBox`/`Grid` of label+value rows) populated from the selected object — do **not** assume a `Form` class exists. If a read-only binding is wanted at implementation time it may drive the values via `Binding`/`Bindable` (imported from `@jimka/typescript-ui/core` — [`core/index.ts:36`](../src/typescript/lib/core/index.ts#L36)) over a `Model` (from `@jimka/typescript-ui/data`), but the panel must not invent a `Form`. Read-only in Phase 1; editing table/column properties (DDL) stays out of Phase 1 (see *Non-Goals*).

### Navigator (lazy `Tree`, inside the Database explorer's "Navigator" section)

- Roots from `GET …/databases`, each `TreeNode` with `hasChildren:true` and a `loadChildren` that fetches the next level and returns child `TreeNode[]` (each again `hasChildren:true` until the table/view leaf). Lazy semantics are exactly the library's: `loadChildren` invoked once, result cached into `children`, a rejection leaves the node collapsed for retry ([`TreeNode.ts:45`](../src/typescript/lib/component/tree/TreeNode.ts#L45)).
- `tree.on("loaderror", (node, err) => statusBar.setMessage(...))` ([`Tree.ts:203`](../src/typescript/lib/component/tree/Tree.ts#L203)) surfaces a failed expand.
- As each node is built, the app sets `node.data = dbObjectRef` (the `TreeNode.data` slot from [`tree-node-data.md`](./implemented/tree-node-data.md)).
- `tree.on("selection", nodes => …)` ([`Tree.ts:191`](../src/typescript/lib/component/tree/Tree.ts#L191)): on a table/view leaf double-activation, read `node.data as DbObjectRef` → open it in the Dock.

### Opening a table into the Dock (a `SqlAdminController` method)

`openTable` is a **method on `SqlAdminController`** (the mediator), not a free function — the controller owns the `Dock`, the open-panel registry, and the connection (see *Frontend structure*):

```typescript
// SqlAdminController.openTable
async openTable(ref: DbObjectRef): Promise<void> {
    const id = this.panelId(ref);                           // stable: `${schema}.${table}`
    if (this.dock.focusPanel(id)) { return; }               // dedup: focusPanel both checks + activates
    const columns = await this.api.getColumns(ref);         // introspection path: ColumnMeta[]
    const model   = buildModel(columns);                    // new Model({fields:[...]})
    const store   = buildStore(ref, model, columns);        // AjaxStore (JsonReader + SqlAdminWriter)
    store.on('exception', e => this.notifyError(e));        // row-CRUD errors → the one sink
    store.on('sync',      e => e.failures.forEach(f => this.notifyError(f)));
    this.openPanels.set(id, store);
    this.dock.addPanel({                                    // Dock.addPanel — no per-spec onClose
        id,
        title: ref.name!,
        content: () => new TableWorkPanel(store, columns),  // lazy factory
    });
    await store.load();
}
```

Disposal is **not** a per-spec field — there is no `DockPanelSpec.onClose`. It is wired **once** at controller setup: the `SqlAdminController` constructor does `this.dock.on("close", ({ id }) => this.disposePanel(id))`, a single subscription that fires for every panel the dock genuinely closes (from the implemented [`dock-panel-lifecycle.md`](./implemented/dock-panel-lifecycle.md)).

- `panelId` is stable so re-opening focuses the existing panel and `Dock.getLayoutState()` round-trips ([`Dock.ts:302`](../src/typescript/lib/overlay/Dock.ts#L302)). Re-opening a known id is short-circuited by `dock.focusPanel(id)` (it both checks existence and activates the host tab, returning `true` when found); the `openPanels` registry is kept for store lookup/disposal, not the focus/dedup check.
- Disposal fires from the single `dock.on("close", …)` subscription, where `disposePanel(id)` aborts any in-flight load (the proxy already threads `params.signal` into `fetch`), releases the store's listeners, and removes it from `openPanels` (see *Frontend structure*: disposal discipline).
- **Tear-off caveat:** a panel torn off to a float fires **`"detach"`**, not **`"close"`** — the panel survives, so its store must **not** be disposed; `disposePanel` runs only on the `"close"` event that genuine destruction fires. Acceptable for the demo — the store stays alive in the float, disposed when that panel is genuinely closed.

### `TableWorkPanel` (data grid + structure view + inline toolbar)

```
TableWorkPanel (Panel, Border layout)
├─ NORTH : ToolBar  (Refresh, Add row, Delete row, Save — and a "Data | Structure" toggle)
└─ CENTER: Card     switching:
            ├─ Table(store, columnSpec)      — the data grid
            └─ Table(structureStore, …)      — the structure view (one row per column: name/type/nullable/PK)
```

- The **data grid** is `new Table(store, spec)` ([`Table.ts:104`](../src/typescript/lib/component/table/Table.ts#L104)). `spec: ColumnSpec` is generated from `ColumnMeta[]`: each `ColumnConfig.field = col.name`, `readOnly:true` for generated/PK columns, and — where the introspected type is an enum or a small FK lookup — `values: ComboOption[]` to get the combo cell editor ([`ColumnConfig.ts:128`](../src/typescript/lib/component/table/ColumnConfig.ts#L128), expanded by `normalizeComboOptions`).
- The **structure view** is a second `Table` over a `MemoryStore` of the `ColumnMeta[]` rows — read-only, no backend round-trip.
- Toolbar buttons drive the store: Refresh → `store.load()`; Add → `store.add({})` (`AbstractStore.add` takes raw data and builds the `ModelRecord` itself — [`AbstractStore.ts:751`](../src/typescript/lib/data/AbstractStore.ts#L751); do **not** pre-wrap with `createRecord`); Delete → `store.remove(selected)` ([`AbstractStore.ts:820`](../src/typescript/lib/data/AbstractStore.ts#L820)); Save → `store.sync()` ([`AbstractStore.ts:1071`](../src/typescript/lib/data/AbstractStore.ts#L1071)).
- Sorting/filtering: enable `remoteSort:true`/`remoteFilter:true` and `setPageSize(n)` on the `AjaxStore` so the proxy emits `sort`/`filter`/`page`/`pageSize` and the backend does the work (matches the verified `buildReadUrl` contract).

### Store wiring (configured `JsonReader` + custom `SqlAdminWriter`)

```typescript
// Use the SINGLE-BAG form: only this branch applies AbstractStoreOptions
// (remoteSort/remoteFilter). The positional `new AjaxStore(model, proxyOptions)`
// form applies ONLY proxy options, so sort=/filter= would never be emitted.
const store = new AjaxStore({
    model,
    proxy: {
        url:    `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/rows`,
        reader: new JsonReader({ rootProperty: "rows", totalProperty: "totalCount" }),
        writer: new SqlAdminWriter(generatedColumnNames),
    },
    remoteSort:   true,   // → proxy appends sort=<json>
    remoteFilter: true,   // → proxy appends filter=<json>
});
store.setPageSize(100);   // → proxy emits page/pageSize
```

Errors are not handled here: `load()`/`sync()` failures surface as the store's `'exception'`/`'sync'` events carrying an `AjaxError` (see *Error handling*), wired to `SqlAdminController.notifyError` in `openTable`.

---

## Ordered Implementation Steps

**Scope note — what `/implement` does in THIS repo.** **No in-repo library work remains** for the SQLAdmin effort: its three sibling library plans — `tree-node-data`, `ajax-proxy-error-detail`, and `dock-panel-lifecycle` — are all implemented & merged. The only conceivable in-repo follow-up is a one-line barrel addition if a needed symbol turns out not to be re-exported from its bucket's barrel (no such gap is currently known). **The app itself — every step below tagged `[external app]` — is built in the standalone app workspace, not here.** Do not scaffold the app, a second Vite entry, a `src/app/` tree, or `backend/` inside this repo. The steps below are listed for the app workspace's own implementation pass; they are out of this repo's `/implement` scope.

**This-repo prerequisites — all satisfied (no steps).** All three sibling library plans — [`tree-node-data`](./implemented/tree-node-data.md), [`ajax-proxy-error-detail`](./implemented/ajax-proxy-error-detail.md), and [`dock-panel-lifecycle`](./implemented/dock-panel-lifecycle.md) — are implemented & merged; the symbols each adds (`TreeNode.data`, `AjaxError`, the Dock `"close"`/`focusPanel`/`removePanel` lifecycle) are detailed in *Overview* and ship in `dist/lib` after `npm run build:lib`. No sequencing — go straight to Phase 0. The only conceivable in-repo follow-up is a one-line barrel re-export if a needed symbol is missing from its bucket (none known; see *Imports*).

**Phase 0 — backend contract + one table in a Dock grid** *(all `[external app]`)*

1. **Scaffold the app workspace + `backend/`** `[external app]`: a new repo with `package.json` declaring `@jimka/typescript-ui` (resolved via `npm link` per *Local-dev linking*), its own `vite.config.ts`/`index.html`, and a sibling FastAPI `backend/` — `pyproject.toml`/`requirements.txt`, a `connections` registry seeded from `DATABASE_URL`, CORS allowing the app's Vite dev origin. Verify: `uvicorn` serves `GET /api/default/databases` against a real PostgreSQL; `npm run dev` in the app serves its page resolving `@jimka/typescript-ui/*`.
1a. **Pool lifecycle + error contract** `[external app]`: wire a FastAPI `lifespan` that opens the `asyncpg.Pool`(s) on startup and closes them on shutdown (routes `acquire()` per request), and register the exception handler mapping the typed taxonomy (`ValidationError`→422, `NotFound`→404, integrity/unique→409) to `(status, {detail})`. Verify: app starts/stops cleanly closing pools; a forced typed exception returns the mapped status with a `{detail}` body.
2. **Implement introspection routes** `[external app]` (`/databases`, `/schemas`, `/objects`, `/columns`) via `information_schema`/`pg_catalog`; `/columns` records each column's `WireType`. Verify: each returns the documented JSON for a known DB.
3. **Implement table CRUD** `[external app]` for one table (`/rows` list with `page`/`pageSize`/`sort`/`filter`, `POST`, `PUT /{id}`, `DELETE /{id}`), parameterized, identifiers validated against introspected columns, and `get_result()` mapping asyncpg native values to the `WireType` contract (`to_wire`). Verify: `curl` a paginated, sorted, filtered read returns `{rows, totalCount}` with contract-typed scalars (no raw Postgres values).
4. **Write `SqlAdminWriter` + wire the configured `JsonReader`** `[external app]`: implement the library `Writer` (imported from `@jimka/typescript-ui/data`) stripping generated columns; the read path uses `new JsonReader({ rootProperty: 'rows', totalProperty: 'totalCount' })` — no custom reader. Verify: a unit test strips generated columns from a write body. (No app reader test — the configured `JsonReader` is library code.)
5. **Build `Model` + `ColumnSpec` from `ColumnMeta`** `[external app]` (`buildModel`, `buildColumnSpec`). Verify: unit test maps a column list to a `Model` with correct field types and a spec marking PK/generated read-only.
6. **Render one table** end-to-end `[external app]`: a minimal `SqlAdminApp.ts` bootstrap that hard-codes one `DbObjectRef`, builds the store, and mounts a single `Table` inside a `Dock` on `Body`. **Phase-0 success criterion met:** a real PostgreSQL table's rows render in a `Dock` panel data grid with working pagination/sort.

**Phase 1 — the app shell** *(all `[external app]`)*

6a. **`SqlAdminController`** `[external app]`: the mediator owning the `Dock`, the `openPanels` registry, the current connection, and `notifyError`. Built by `SqlAdminApp` and handed to the shell/navigator so components only emit. Verify (later steps exercise it): `notifyError` routes to the StatusBar; the registry dedups by `panelId`.
7. **`SqlAdminShell`** `[external app]` (`Border`: MenuBar NORTH, ActivityBar WEST, Dock CENTER, StatusBar SOUTH; `WEST` `collapsible:true`). Verify: shell renders with all four regions; WEST collapsible.
7a. **`ActivityBar`** `[external app]`: Border with a vertical `ToolBar` rail (`orientation:"vertical"`) of icon-only `ToggleButton`s in `WEST` and a `Card` deck in `CENTER`; rail handler does mutual-exclusion + `card.setVisibleComponentId` + already-selected→`shellBorder.setRegionCollapsed(Placement.WEST, …)`. Phase 1 ships **one** "Database" button. Verify: clicking the active button collapses/expands the sidebar; the rail is the documented Phase-2 seam.
8. **`NavigatorTree`** `[external app]`: lazy `Tree` with `hasChildren`/`loadChildren` per level, `node.data = dbObjectRef`, `loaderror`→StatusBar. Verify: expanding lazily fetches each level; a forced backend 500 leaves the node collapsed and shows the error.
8a. **`DatabaseExplorerView`** `[external app]`: an `Accordion` (`singleOpen:false`, `fillHeight:true`) with a "Navigator" section (the lazy `Tree` from step 8) and a read-only "Properties" key/value section bound to the Tree `selection` (`node.data`); mount it as the first `Card` page. Verify: both sections stay open and share height; selecting a navigator object updates Properties; no `Form` class is introduced.
9. **Open-to-Dock** `[external app]` (uses the merged `dock-panel-lifecycle` surface): `selection`/activation on a leaf → `SqlAdminController.openTable(node.data as DbObjectRef)` → `Dock.addPanel` with a stable id; the controller registers the store's `'exception'`/`'sync'` listeners to `notifyError`, short-circuits re-opens with `dock.focusPanel(id)`, and disposes stores from the single constructor-wired `dock.on("close", ({ id }) => this.disposePanel(id))` subscription. Verify: opening two tables yields two dock tabs; re-opening one is short-circuited by `focusPanel` (no duplicate, the existing tab activates); closing a panel fires `"close"` and disposes its store (no leaked load); a tear-off to a float fires `"detach"` and does **not** dispose (the panel survives); a backend row error reaches the StatusBar via `notifyError`.
10. **`TableWorkPanel`** `[external app]`: inline `ToolBar` (NORTH) + `Card` body toggling data grid / structure view (CENTER). Wire toolbar to `store.load/add/remove/sync`. Verify: Refresh/Add/Delete/Save round-trip to the backend; a failed Save surfaces its `AjaxError.body.detail` via the controller's `notifyError`; Data↔Structure toggle switches the card.
11. **StatusBar wiring** `[external app]`: connection name + current table row count via `store.getTotalCount()` ([`AbstractStore.ts:470`](../src/typescript/lib/data/AbstractStore.ts#L470)). Verify: status updates on load and on table switch.
12. **Regression checkpoint (app workspace):** `grep -rn '@jimka/typescript-ui/' src` — **every** library import goes through a published subpath; **zero** `~/` or `dist/lib/` deep imports into library internals.

---

## Files to Create / Modify / Delete

**In THIS library repo:** none for *this* plan directly. The SQLAdmin effort's in-repo library changes are owned by three sibling plans, **all three implemented & merged** — `TreeNode.data` ([`tree-node-data.md`](./implemented/tree-node-data.md)), `AjaxError` ([`ajax-proxy-error-detail.md`](./implemented/ajax-proxy-error-detail.md)), and the Dock `"close"` event + `focusPanel`/`removePanel` from [`dock-panel-lifecycle.md`](./implemented/dock-panel-lifecycle.md). **No in-repo library work remains.** Should app development surface a needed symbol missing from its bucket barrel, the fix would be a one-line re-export in the relevant `src/typescript/lib/<group>/index.ts` (plus its doc) — but no such gap is currently known (see *Imports*), so this plan lists no in-repo files of its own.

**In the EXTERNAL app workspace (out of this repo's scope — listed for the app's own implementation):**

| Action | File (app workspace) |
|---|---|
| Create | `package.json` — declares `@jimka/typescript-ui` dependency (`npm link` in dev) |
| Create | `vite.config.ts`, `index.html` — the app's own dev server + HTML entry |
| Create | `src/SqlAdminApp.ts` — app bootstrap (builds shell + controller, mounts on `Body`) |
| Create | `src/SqlAdminController.ts` — the mediator: owns Dock + open-panel registry + connection; `openTable`/`disposePanel`/`notifyError` |
| Create | `src/shell/SqlAdminShell.ts` — Border shell |
| Create | `src/shell/ActivityBar.ts` — vertical ToolBar rail of ToggleButtons + Card deck; collapse-on-active |
| Create | `src/shell/DatabaseExplorerView.ts` — Accordion (Navigator + Properties); the first Card page |
| Create | `src/shell/PropertiesPanel.ts` — read-only key/value panel bound to Tree selection |
| Create | `src/navigator/NavigatorTree.ts` — lazy Tree; `node.data = DbObjectRef` |
| Create | `src/dock/TableWorkPanel.ts` — toolbar + data grid + structure |
| Create | `src/data/api.ts` — typed fetch client for introspection (reads error bodies directly) |
| Create | `src/data/SqlAdminWriter.ts` — custom `Writer` (strips server-managed columns on insert) |
| Create | `src/data/buildModel.ts` — `ColumnMeta[]` → `Model` + `ColumnSpec` |
| Create | `src/data/stores.ts` — builds an `AjaxStore` per table (configured `JsonReader` + `SqlAdminWriter`) |
| Create | `src/contract.ts` — `DbObjectRef`, `ColumnMeta`, `WireType`, `TableListEnvelope` |
| Create | `backend/app/main.py` — FastAPI app + `lifespan` (open/close pools) + exception handler (typed exception → status + `{detail}`) + thin routes (acquire → construct op → `apply` → `get_result`) |
| Create | `backend/app/operations/base.py` — `Operation`/`Query`/`Command` base contract |
| Create | `backend/app/operations/introspect.py` — `ListDatabasesQuery`/`ListSchemasQuery`/`ListObjectsQuery`/`ListColumnsQuery` |
| Create | `backend/app/operations/rows.py` — `ListRowsQuery` + `Insert`/`Update`/`DeleteRowCommand`; `to_wire` value mapping in `get_result()` |
| Create | `backend/app/sql/compiler.py` — pure `FilterCompiler`/`OrderCompiler` + `quote_ident` |
| Create | `backend/app/errors.py` — exception taxonomy (`ValidationError`→422, `NotFound`→404, integrity/unique→409) |
| Create | `backend/app/connections.py` — `connectionId` → `asyncpg.Pool` registry (seeded from `DATABASE_URL`); opened/closed by the `lifespan` |
| Create | `backend/pyproject.toml` (or `requirements.txt`) — `asyncpg`, `fastapi`, `uvicorn` |

**No files under `src/typescript/lib/` are created or modified by this plan.**

---

## Expected Behaviour

**Writer (unit-testable offline):**
- `SqlAdminWriter.writeRecord` emits JSON of `record.getData()` **minus** every name in `generatedColumns`; `writeRecords` emits an array of the same.
- (No app reader test: the read path is the library's configured `JsonReader({ rootProperty:'rows', totalProperty:'totalCount' })`, exercised by the library's own tests — `JsonReader` parses the `{rows, totalCount}` envelope to `{records, total}`. Read errors never reach the reader; they surface as the store's `'exception'` event carrying an `AjaxError` — see *Error handling*.)

**buildModel / buildColumnSpec (unit-testable offline):**
- Maps each `ColumnMeta` to a `Field` with a `FieldType` derived from `dataType` (integer→number, text→string, bool→boolean, timestamp→datetime, etc.); unknown types fall back to `'auto'`.
- Marks PK and generated columns `readOnly:true` in the `ColumnSpec`.
- Sets the `Model` primary key to the introspected PK column so `record.getId()` resolves for `PUT`/`DELETE` URLs.

**Activity bar (needs live verification — DOM events + layout):**
- Clicking a rail `ToggleButton` whose view is not active selects it (deselecting the others), shows that `Card` page, and expands the `WEST` region if collapsed.
- Clicking the **already-active** rail button collapses the `WEST` region; clicking it again expands it (VSCode signature).
- In Phase 1 the rail has one button; both Accordion sections (Navigator, Properties) stay open and share height (`singleOpen:false`, `fillHeight:true`).

**Navigator (needs live verification — DOM events + async expand):**
- Expanding a database node fetches its schemas exactly once; collapse/re-expand does not refetch.
- A backend error during expand leaves the node collapsed and fires `loaderror`.
- Selecting/activating a table leaf opens it in the Dock; selecting a database/schema does not.
- Selecting any navigator object updates the read-only Properties section from `node.data` (no DDL/edit in Phase 1).

**Dock / TableWorkPanel (needs live verification — drag, focus, layout):**
- `addPanel` with a new id adds a tab; re-opening a known id is short-circuited by `dock.focusPanel(id)` returning `true` (it activates the existing tab) — no duplicate panel, and `addPanel` is never reached.
- Closing a panel (user ✕ or `dock.removePanel(id)`) fires the controller's single `dock.on("close")` subscription, which disposes that table's store; tearing a panel off to a float fires `"detach"`, not `"close"`, so the store is **not** disposed (the panel survives).
- Toolbar Refresh/Add/Delete/Save round-trip to the backend and the grid reflects the result.
- Data↔Structure toggle switches the visible card without re-fetching the data grid.
- Sorting a column (with `remoteSort`) issues a read whose URL carries `sort=[{"field":…,"dir":…}]`.

**Backend operation handlers — pure logic (unit-testable offline, no DB):**
- `FilterCompiler.compile()` maps each `FilterDescriptor` variant to the correct SQL fragment with positional `$n` binds; composites (`and`/`or`/`not`) nest correctly; an identifier not in the validated column set raises in the constructor.
- `OrderCompiler.compile()` maps `SortDescriptor[]` to an `ORDER BY` clause with quoted identifiers and `asc`/`desc`; empty input yields no clause.
- `quote_ident()` double-quotes and escapes embedded `"`.
- An operation's `get_result()` transforms a hand-fed raw result into the response payload (`ListRowsQuery` → `{rows, totalCount}`, lifting `__total` off the first row) and raises if called before `apply()` (the temporal-coupling guard) — testable with the raw-result instance var set directly, no connection.
- An operation constructor with an out-of-set identifier or missing required param raises before any I/O.

**Backend integration (verify with `pytest`/`curl` against a test DB):**
- Introspection operations return the documented shapes.
- Row list honors `page`/`pageSize`/`sort`/`filter`; identifiers outside the introspected column set are rejected (no SQL injection surface).
- `Insert`/`Update`/`DeleteRowCommand` run in a transaction; `Update`/`Delete` target the introspected PK.

---

## Verification

**This library repo (the only `/implement`-able surface here):**
- `tree-node-data` has already landed; `npm run build:lib` emits a `dist/lib` carrying `TreeNode.data` in the `component/tree` types.
- `dock-panel-lifecycle` ([`dock-panel-lifecycle.md`](./implemented/dock-panel-lifecycle.md)) has already landed; `npm run build:lib` carries the Dock `"close"`/`focusPanel`/`removePanel` surface into `dist/lib`.
- No library/public-API change remains for this plan, so `npm run docs:build` is unaffected — but run it to confirm 0 errors / 0 link warnings remain (only the typedoc "unsupported TypeScript version" notice acceptable).

**External app workspace (run there, against the linked library):**
- The app's `npm run typecheck` / `tsc` — passes resolving `@jimka/typescript-ui/*` types from the linked `dist/lib`.
- The app's `npm run dev` — the app page serves and mounts the shell.
- App unit tests (Vitest) cover the `SqlAdminWriter` and `buildModel` behaviours above (no app reader test — the read path is the library's configured `JsonReader`).
- Backend pure unit tests (`pytest`, no DB): `FilterCompiler`/`OrderCompiler`/`quote_ident`, the `to_wire` value mapping, and each operation's `get_result()` + constructor validation (per *Expected Behaviour*).
- Backend integration (`pytest`/`curl` against a disposable PostgreSQL): introspection + CRUD + sort/filter, transactional commands, PK-targeted update/delete.
- Manual smoke (the DOM/async/drag paths the offline harness can't exercise): activity-rail select + click-active-to-collapse, Accordion both-sections-open, Properties updates on selection, lazy expand, open-to-dock, toolbar CRUD, Data/Structure toggle, theme toggle on the shell.
- `grep -rn '@jimka/typescript-ui/' src` in the app — every library import is a published subpath; **zero** `~/` or `dist/lib/` deep imports (decoupling invariant).

---

## Potential Challenges

- **`TreeNode.data` (already shipped).** [`tree-node-data.md`](./implemented/tree-node-data.md) is merged ([`TreeNode.ts:58`](../src/typescript/lib/component/tree/TreeNode.ts#L58)), so this `depends-on` is satisfied; the navigator sets/reads `node.data` (opaque to the tree, keyed by object reference — identity never relies on `label`), available after a `build:lib`.
- **Dock disposal/dedup (already shipped).** The controller's disposal (`dock.on("close", …)`) and re-open dedup (`dock.focusPanel(id)`) both rely on the Dock `"close"` event + `focusPanel`/`removePanel` from [`dock-panel-lifecycle.md`](./implemented/dock-panel-lifecycle.md), **now merged**, so this `depends-on` is satisfied. `DockPanelSpec` deliberately has no `onClose` — disposal is wired once via the Dock-level `"close"` event; a tear-off to a float fires `"detach"` (the panel survives, so its store is not disposed). The published `dist/lib` carries the new Dock surface after a `build:lib`.
- **Update/delete URL shape is `{url}/{id}`.** Mitigation: store `url` is the collection (`…/rows`); FastAPI mounts `…/rows/{id}`; `Model` PK set so `record.getId()` is correct.
- **`create`/`update` bypass the `Reader`** (parse `json[root]` directly — `create` at [`AjaxProxy.ts:196`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L196), `update` at [`AjaxProxy.ts:220`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L220)). Mitigation: FastAPI's create/update returns the bare row object (optionally under the configured `root`), not the list envelope.
- **Postgres scalar coercion** (numeric, timestamptz, uuid, bytea, arrays). Mitigation: the **backend** maps every asyncpg native value to the fixed `WireType` contract inside each operation's pure `get_result()` (`to_wire`; see *Backend data access* and *Postgres types → contract*) — so the wire never carries raw Postgres values and the frontend `Model`/`Field` mirror the contract. No app-side reader coercion is needed.
- **Row errors never reach the Reader.** `AjaxProxy.read` throws on `!response.ok` before `reader.read` runs, so a non-2xx body cannot be surfaced through a reader. Mitigation: row errors flow through the store's `'exception'`/`'sync'` events carrying an `AjaxError` (from the implemented [`ajax-proxy-error-detail.md`](./implemented/ajax-proxy-error-detail.md)) to the single `SqlAdminController.notifyError` sink; introspection errors flow through `data/api.ts` catches to the same sink (see *Error handling*).
- **SQL injection via sort/filter identifiers.** Mitigation: validate every field name against the introspected column set; bind all values as parameters; never interpolate identifiers.
- **`npm link` serves a stale `dist/lib`.** The app consumes the built bundle, so a library source change is invisible until rebuilt. Mitigation: re-run `npm run build:lib` after each library change (or a watch loop) during co-development; use the `npm pack` tarball for a byte-exact publish preview.
- **Symlinked duplicate instances.** Vite `optimizeDeps` / multiple `node_modules` copies of a linked package can produce two module instances. Mitigation: dedupe `@jimka/typescript-ui` in the app's Vite config, or fall back to the `file:`/tarball install if symlink resolution misbehaves.
- **`Border` name clash** with the primitive `Border`. Mitigation: import the layout aliased (`Border as BorderLayout` from `@jimka/typescript-ui/layout`), as the demo panels and [`Border.ts:49`](../src/typescript/lib/layout/Border.ts#L49) prescribe.
- **Rail mutual exclusion is app-managed.** `ToggleButton` has no built-in radio-group; the rail handler must deselect siblings (`setSelected(false)`) when a new view is chosen. Mitigation: a small group helper in `ActivityBar`. (`Card`'s selector is `setVisibleComponentId`, not `setActive` — name it correctly.)
- **Properties panel has no confirmed `Form` component.** Verification item: build the read-only key/value panel as a `VBox`/`Grid` of label+value rows; only drive it through a read-only binding via `Binding`/`Bindable` (in `@jimka/typescript-ui/core`, **not** `data` — [`core/index.ts:36`](../src/typescript/lib/core/index.ts#L36)) over a `Model` (in `@jimka/typescript-ui/data`) at implementation time. Do **not** invent a `Form` class.
- **`ToggleButton` bucket.** It is re-exported from `@jimka/typescript-ui/component/button` ([`component/button/index.ts:5`](../src/typescript/lib/component/button/index.ts#L5)), **not** `component/menubar`; `./component/button` is in the `exports` map ([`package.json:36`](../package.json#L36)).

---

## Critical Files

- [`data/proxy/AjaxProxy.ts`](../src/typescript/lib/data/proxy/AjaxProxy.ts) — exact request/response contract (read URL params, create/update/destroy URLs); throws on `!response.ok` before the Reader runs ([`:109`](../src/typescript/lib/data/proxy/AjaxProxy.ts#L109)) — the reason errors flow via store events, not the Reader.
- [`data/proxy/Reader.ts`](../src/typescript/lib/data/proxy/Reader.ts) / [`Writer.ts`](../src/typescript/lib/data/proxy/Writer.ts) — `JsonReader`/`JsonReaderOptions` for the read path ([`Reader.ts:50`](../src/typescript/lib/data/proxy/Reader.ts#L50)); `Writer` interface the custom `SqlAdminWriter` implements.
- [`data/AbstractStore.ts`](../src/typescript/lib/data/AbstractStore.ts) — `SortDescriptor`, `pageSize`/`remoteSort`/`remoteFilter`, `load`/`sync`/mutation methods; the first-class error reporting the app relies on: `StoreOperation` ([`:37`](../src/typescript/lib/data/AbstractStore.ts#L37)), `'exception'` `StoreExceptionEvent` ([`:50`](../src/typescript/lib/data/AbstractStore.ts#L50), emitted by `load` at [`:346`](../src/typescript/lib/data/AbstractStore.ts#L346)), `'sync'` `StoreSyncEvent` ([`:96`](../src/typescript/lib/data/AbstractStore.ts#L96), emitted at [`:1097`](../src/typescript/lib/data/AbstractStore.ts#L1097)).
- [`data/proxy/AjaxError.ts`](../src/typescript/lib/data/proxy/AjaxError.ts) — `AjaxError` (the store's `error` payload for row CRUD), re-exported at [`data/index.ts:31`](../src/typescript/lib/data/index.ts#L31); from the implemented sibling plan [`ajax-proxy-error-detail.md`](./implemented/ajax-proxy-error-detail.md), a now-satisfied `depends-on`.
- [`data/AjaxStore.ts`](../src/typescript/lib/data/AjaxStore.ts) — store + proxy wiring (`reader`/`writer` forwarded).
- [`data/FilterDescriptor.ts`](../src/typescript/lib/data/FilterDescriptor.ts) — filter union the backend must translate.
- [`data/Model.ts`](../src/typescript/lib/data/Model.ts) / [`data/Field.ts`](../src/typescript/lib/data/Field.ts) — dynamic model construction from introspection.
- [`component/tree/Tree.ts`](../src/typescript/lib/component/tree/Tree.ts) / [`component/tree/TreeNode.ts`](../src/typescript/lib/component/tree/TreeNode.ts) — lazy navigator API + the `data` payload slot (added by [`tree-node-data.md`](./implemented/tree-node-data.md)).
- [`overlay/Dock.ts`](../src/typescript/lib/overlay/Dock.ts) — `addPanel` ([`:262`](../src/typescript/lib/overlay/Dock.ts#L262))/`DockPanelSpec`/`getLayoutState` ([`:302`](../src/typescript/lib/overlay/Dock.ts#L302))/`setLayoutState`. The `focusPanel` ([`:1196`](../src/typescript/lib/overlay/Dock.ts#L1196))/`removePanel` ([`:1230`](../src/typescript/lib/overlay/Dock.ts#L1230)) methods and the `"close"` event (payload `DockPanelEvent { id, content, window }` — [`:98`](../src/typescript/lib/overlay/Dock.ts#L98), one of the `DockEvent`s `"attach" | "detach" | "moved" | "focus" | "close"` — [`:89`](../src/typescript/lib/overlay/Dock.ts#L89)) the app's dock dedup/disposal relies on come from the **implemented** [`dock-panel-lifecycle.md`](./implemented/dock-panel-lifecycle.md) plan — `DockPanelSpec` has **no** `onClose` field.
- [`layout/Border.ts`](../src/typescript/lib/layout/Border.ts) — shell regions; `Placement` constraint usage; `setRegionCollapsed`/`isRegionCollapsed`/`setRegionCollapsible` for the activity-rail collapse.
- [`layout/Card.ts`](../src/typescript/lib/layout/Card.ts) — the activity-bar view-container deck; `setVisibleComponentId` selects the active view.
- [`layout/Accordion.ts`](../src/typescript/lib/layout/Accordion.ts) / [`layout/AccordionConstraints.ts`](../src/typescript/lib/layout/AccordionConstraints.ts) — the Database explorer view (`singleOpen:false`, `fillHeight:true`); per-section label.
- [`component/menubar/ToolBar.ts`](../src/typescript/lib/component/menubar/ToolBar.ts) — the vertical activity rail (`orientation:"vertical"`, flat, roving-tabindex).
- [`component/button/ToggleButton.ts`](../src/typescript/lib/component/button/ToggleButton.ts) — the rail's icon-only view-selector buttons (`setSelected`/`isSelected`, `"action"`).
- [`component/table/Table.ts`](../src/typescript/lib/component/table/Table.ts) / [`component/table/ColumnConfig.ts`](../src/typescript/lib/component/table/ColumnConfig.ts) — data grid + `ColumnSpec`/`values` combo editor.
- [`BorderPanel.ts`](../src/typescript/BorderPanel.ts), [`MenuBarPanel.ts`](../src/typescript/MenuBarPanel.ts), [`MiscPanel.ts`](../src/typescript/MiscPanel.ts) — reference compositions for Border, MenuBar, Table+Store (the gallery; the app mirrors these patterns against the published subpaths).
- [`package.json`](../package.json) — the `exports` subpath map the app imports through; `build:lib`, `files`, `sideEffects`.
- [`tree-node-data.md`](./implemented/tree-node-data.md) — the library plan this one depends on (`TreeNode.data`); **already implemented**.
- [`dock-panel-lifecycle.md`](./implemented/dock-panel-lifecycle.md) — the library plan this one depends on for the Dock `"close"` event + `focusPanel`/`removePanel` (the app's dock disposal/dedup); **already implemented**.

---

## Non-Goals

- **User/group/permissions browser** — Phase 2; entirely out of scope. The activity bar reserves the seam (one more rail `ToggleButton` + one more `Card` page), but no Phase-2 view is built now.
- **Editing object properties (DDL via the Properties panel)** — the Properties section is read-only in Phase 1; editing table/column metadata is out of scope.
- **Arbitrary-SQL query panels / result grids** — Phase 1.5; only the Dock+panel *seam* must not preclude them. No query UI built now.
- **SQL syntax editor** — consciously deferred; no code editor component.
- **Charting / data visualization** — consciously deferred.
- **Multi-database fan-out** — only the `connectionId` route/registry seam exists; Phase 0–1 ship one `"default"` connection. No dialect-translation layer, plugin system, or per-DB feature flags.
- **Focus-driven toolbar show/hide** — panels own their toolbar inline; the focus experiment is explicitly later.
- **Scaffolding the app inside this library repo** — the app is a standalone external workspace consuming `@jimka/typescript-ui` as a published dependency. No `src/app/` tree, no second Vite entry, no `backend/`, no app files land in this repo; the only in-repo work the effort ever needed was the three sibling library plans — `tree-node-data`, `ajax-proxy-error-detail`, and `dock-panel-lifecycle`, all implemented & merged — plus any barrel re-export gap app development uncovers.
- **The `TreeNode.data` library change itself** — owned by [`tree-node-data.md`](./implemented/tree-node-data.md), a separate plan this one depends on (**already implemented**); not re-specified here.
- **DDL operations** (create/alter/drop table, index management) — not in Phase 0–1.
- **App-level auth / sessions** — there is no authentication or session layer in Phase 0–1; the backend trusts its caller. Auth is a later concern.
- **`count(*) OVER()` cost on very large tables** — the paginated total is computed per request via `count(*) OVER()`, which is acceptable for a demo. Noted, not optimized (no approximate-count/estimate path, no caching of the total).
- **Optimistic concurrency, retry/backoff, client-side request caching** — writes are last-write-wins (no version/ETag check); a failed request surfaces immediately with no retry policy; reads are not cached on the client. All out of scope.
