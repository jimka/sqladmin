---
depends-on:
  - query-workspace
touches-shared:
  - frontend/src/dock/QueryPanel.ts
  - frontend/src/SqlAdminController.ts
  - frontend/src/contract.ts
  - backend/app/main.py
  - backend/app/operations/run_query.py
---

# EXPLAIN / EXPLAIN ANALYZE + Plan View — Implementation Plan

## Overview

Add **EXPLAIN** and **EXPLAIN ANALYZE** to a QueryPanel: the user writes SQL, presses an Explain (or Explain Analyze) affordance, and the resulting query plan renders in the panel's result area as a **read-only monospace text plan** (the first cut) — separately from the normal rows-result path, which stays untouched.

The feature is a thin composition over the *existing* arbitrary-SQL run path. A QueryPanel already runs SQL via an injected `runQuery(sql)` closure ([`QueryPanel.ts:45`](frontend/src/dock/QueryPanel.ts#L45), [`QueryPanel.ts:166`](frontend/src/dock/QueryPanel.ts#L166)); the controller wires that closure to `api.runQuery(connectionId, sql)` ([`SqlAdminController.ts:183`](frontend/src/SqlAdminController.ts#L183)); `api.runQuery` POSTs to `/api/{conn}/query` ([`data/api.ts:86`](frontend/src/data/api.ts#L86)); and the backend `RunQueryCommand` prepares one statement in a transaction and classifies the result ([`backend/app/operations/run_query.py:110`](backend/app/operations/run_query.py#L110)). EXPLAIN is that same SQL, prefixed with `EXPLAIN [ANALYZE] [FORMAT TEXT]` — so the invocation is a **client-side prefix** plus a **new result mode** in the panel, not a new backend operation for the text-first cut.

The one genuinely hard problem is the **EXPLAIN ANALYZE side-effect hazard**: `ANALYZE` *executes* the statement, so `EXPLAIN ANALYZE UPDATE …` really performs the write. The current `RunQueryCommand.apply()` wraps its statement in a transaction that **commits on success** ([`run_query.py:140`](backend/app/operations/run_query.py#L140)) — reusing it verbatim for ANALYZE would silently commit a DML/DDL side-effect. This plan resolves that with a **two-layer guard**: (1) a pure, offline-tested **statement classifier** that lets ANALYZE through only for read-only (`SELECT`/`WITH … SELECT`/`VALUES`/`TABLE`/`SHOW`) statements, blocking it with a clear message otherwise; and (2) a **backend safety net** — a dedicated `ExplainQueryCommand` whose ANALYZE path runs inside an **explicitly rolled-back transaction**, so even a mis-classified write leaves no committed change. Both layers are justified below.

The pure pieces — EXPLAIN SQL construction (prefix, ANALYZE guard, FORMAT choice) and the future JSON-plan→tree parse — are factored into DOM-free modules the app's node-only vitest ([`frontend/vitest.config.ts`](frontend/vitest.config.ts)) red-greens; the buttons, run, and plan rendering are manual-verify.

---

## Architecture Decisions

### Coordinate with query-workspace.md — it owns the Query menu and the run path

The sibling [`query-workspace.md`](query-workspace.md) plan **restructures the menubar** from the current `File / View / Tools` ([`SqlAdminShell.ts:141`](frontend/src/shell/SqlAdminShell.ts#L141)) to a **Query** menu (New Query / Open Saved… / Query History…) then **View**, changing `buildMenuBar`'s signature to `buildMenuBar(onNewQuery, onOpenSaved, onShowHistory, onToggleSidebar)`. That plan **owns** the run path and the Query menu; this plan **builds on it**, not around it.

**Decision:** the Explain affordances live primarily on the **QueryPanel toolbar** (two glyph buttons beside Run/Clear), which is self-contained and does not fight the menu restructure. The Query-menu integration is deferred to `query-workspace`'s ownership: this plan does **not** rewrite `buildMenuBar`, and it does **not** add global-menu Explain items in the first cut (a menu item would need a *focused-panel* handle to know which editor's SQL to explain, which the menu wiring does not currently thread). If, after query-workspace lands, an "Explain current query" Query-menu item is wanted, it is a small follow-on that routes to the focused panel — flagged as a Non-Goal here, not built. This keeps `SqlAdminShell.ts` **out of this plan's touched files** and avoids a merge collision on `buildMenuBar` with query-workspace.

### Two toolbar buttons: Explain and Explain Analyze — no keyboard shortcut in the first cut

The QueryPanel toolbar (`ToolBar` at NORTH, [`QueryPanel.ts:84`](frontend/src/dock/QueryPanel.ts#L84)) already holds glyph-only buttons built by the module-private `glyphButton` helper ([`QueryPanel.ts:226`](frontend/src/dock/QueryPanel.ts#L226)). Add two more, after Run/Clear:

- **Explain** (glyph `diagram_project`, neutral color) — runs `EXPLAIN [FORMAT TEXT] <sql>`.
- **Explain Analyze** (glyph `flask`, amber `CLEAR_COLOR` to signal "this executes") — runs `EXPLAIN ANALYZE [FORMAT TEXT] <sql>` **after** the read-only guard.

Both glyphs exist in the published `glyphs/solid` bundle (verified: `diagram_project.es.js`, `flask.es.js`) and register the same way `play`/`eraser` already do ([`QueryPanel.ts:23`](frontend/src/dock/QueryPanel.ts#L23), [`:28`](frontend/src/dock/QueryPanel.ts#L28)).

**No keyboard shortcut** is added in the first cut. `Ctrl/Cmd+Enter` stays the plain Run ([`QueryPanel.ts:202`](frontend/src/dock/QueryPanel.ts#L202)); query-workspace also claims `Ctrl+↑/↓` and `Ctrl+Shift+Enter`. Adding an Explain accelerator now risks colliding with an unmerged sibling. The buttons carry hover-tooltip labels ("Explain", "Explain Analyze (executes the statement)"); an accelerator is a documented Non-Goal.

### The prefix is built client-side — a pure `buildExplainSql` helper

EXPLAIN is the user's SQL with a prefix. Building that prefix is a **pure string function**, so it goes in a new DOM-free module `frontend/src/data/explain.ts` (beside the existing pure `sql.ts`), unit-tested offline:

```
buildExplainSql(sql, { analyze, format }) -> "EXPLAIN [ANALYZE] [FORMAT TEXT|JSON] <sql>"
```

Prefixing in the **frontend** (not a new backend "explain mode" flag) is chosen because the backend already executes opaque SQL verbatim — an `EXPLAIN …` string is just more opaque SQL. This keeps the wire contract unchanged for the text cut and makes the prefix logic testable without a backend. The user's editor text is **not** mutated — the prefix is applied only to the copy sent to the run path, so the editor still shows their original statement.

### FORMAT TEXT is the first cut; FORMAT JSON → Tree is the follow-on

PostgreSQL's `EXPLAIN` supports `FORMAT TEXT` (the default, a human-readable indented plan) and `FORMAT JSON` (a structured nested object). **The first cut uses `FORMAT TEXT`** and renders the plan as a **read-only monospace text block**, for three reasons: (1) a text plan is a single string — no parsing, no tree model, no new component wiring, the lowest-risk path to a working feature; (2) it needs no backend result-shape change beyond returning the plan lines; (3) it is exactly what a DBA reads today in `psql`. **`FORMAT JSON` → a `Tree` view is the richer follow-on** (the library has a `Tree` taking `TreeNode[]` of `{label, children}` — [`Tree.setNodes`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts#L130)); a pure `parseJsonPlan(json) -> TreeNode[]` mapper would be offline-testable, and the plan tree would render node cost/rows/actual-time as labels. The follow-on is scoped in *Non-Goals* with its seam (a `format` field already carried end-to-end) so it slots in without re-architecting.

**Result shape for the text plan.** An `EXPLAIN … FORMAT TEXT` executed as a normal query returns a **single-column rows result** (column `QUERY PLAN`, one row per plan line) — i.e. it already flows back through the existing `QueryRowsResult` path ([`contract.ts:52`](frontend/src/contract.ts#L52)) with no contract change. But rendering plan lines in a *data grid* is poor UX (one narrow scrolling column, no monospace). So the panel **recognizes an explain run** (it initiated it) and joins that single column's rows into one monospace text block rather than a `Table`. To make this robust and typed, the backend `ExplainQueryCommand` returns a **dedicated envelope** (see next) rather than relying on the panel to reshape a generic rows result.

### A dedicated backend `ExplainQueryCommand` — required by the ANALYZE hazard, not just tidiness

The text plan *could* be produced by prefixing and reusing `RunQueryCommand`. **It must not be, because of the ANALYZE side-effect.** `RunQueryCommand.apply()` runs its statement in `async with self._conn.transaction():` which **commits on normal exit** ([`run_query.py:140`](backend/app/operations/run_query.py#L140)). `EXPLAIN ANALYZE UPDATE t SET …` under that path **executes and commits the UPDATE**. That is unacceptable as a silent behaviour of an "explain" button.

**Decision:** add a new CQRS operation `ExplainQueryCommand(conn, sql, analyze: bool, format: "text"|"json")` in `backend/app/operations/explain_query.py`, and a route `POST /api/{conn}/explain` (body `{ sql, analyze, format }`). Its `apply()`:

- **ANALYZE runs inside an explicitly rolled-back transaction.** Open a transaction, run `EXPLAIN (ANALYZE, FORMAT …) <sql>`, capture the plan, then **raise/rollback** so the analyzed statement's side-effects are discarded. asyncpg's `conn.transaction()` context rolls back if the body raises; the operation captures the plan into an instance var *before* forcing the rollback (a sentinel exception caught at the boundary), so the plan survives but the writes do not. This is the **safety net**: even if the frontend guard is bypassed, an ANALYZE'd DML/DDL leaves no committed change.
- **Plain EXPLAIN (no ANALYZE) does not execute the statement** — it only plans — so it runs without the rollback dance (it is inherently side-effect-free).

`get_result()` returns `{ "kind": "explain", "format": "text", "plan": "<joined plan text>" }` (text cut) — a **new `QueryExplainResult` contract variant** — so the frontend gets a typed, unambiguous explain payload separate from `QueryRowsResult`/`QueryStatusResult`.

*Rejected — frontend-only prefix into the existing `/query` route:* it would either commit ANALYZE side-effects (unsafe) or require teaching `RunQueryCommand` to conditionally roll back (entangling the two ops). A dedicated op keeps `RunQueryCommand` single-responsibility and puts the rollback where the hazard lives.

### The ANALYZE read-only guard is a pure, offline-tested classifier

Even with the backend rollback net, the frontend **warns before** running ANALYZE on anything that isn't plainly a read. `frontend/src/data/explain.ts` exports a pure `isReadOnlyStatement(sql): boolean` — true when the statement's first significant keyword is `SELECT`, `TABLE`, `VALUES`, `SHOW`, or a `WITH …` whose top-level body is a `SELECT`/`VALUES` (a conservative, best-effort lexical check; comments and leading whitespace stripped). The Explain Analyze button calls it:

- **read-only** → run `EXPLAIN ANALYZE` directly.
- **not read-only** (or ambiguous) → do **not** run silently; surface a confirming warning via the panel's `notify`: `"EXPLAIN ANALYZE will EXECUTE this statement (changes are rolled back). Statement does not look read-only — use Explain (without Analyze) to see the plan without running it."` and **abort** the analyze run. Plain **Explain** always works (it never executes), so the user has a safe path.

This is defense-in-depth, not the sole guard — the backend rollback is authoritative — but it stops a user from *intending* to inspect a plan and accidentally firing a write's real execution against live rows (even rolled back, ANALYZE can be expensive and can fire triggers). The classifier is a pure function → **fully offline-testable**, the linchpin of the *Expected Behaviour* section. Because it is conservative (unknown → not read-only), a false "not read-only" only pushes the user to plain Explain; a false "read-only" is caught by the backend rollback. The plan deliberately does **not** try to fully parse SQL — a lexical first-keyword check plus the backend net is the right risk balance for a demo admin tool.

### Rendering: a read-only monospace TextArea in a swapped result pane, reusing the panel's Split

The panel body is a vertical `Split` that shows the editor alone until a result appears, then adds a result pane ([`QueryPanel.ts:71`](frontend/src/dock/QueryPanel.ts#L71), [`:90`](frontend/src/dock/QueryPanel.ts#L90)). The explain plan reuses that **same result pane and gutter** — it is just a different *content* in `resultHost` ([`QueryPanel.ts:67`](frontend/src/dock/QueryPanel.ts#L67)): instead of a `Table`, the pane holds a **read-only monospace `TextArea`** seeded with the plan text. This means:

- **No new layout** — `showResultPane(component)` already takes any `Component` ([`QueryPanel.ts:90`](frontend/src/dock/QueryPanel.ts#L90)); the plan passes a `TextArea` instead of a `Table`. The editor→result gutter, the `EDITOR_HEIGHT` seeding, and the reuse-on-subsequent-runs all work unchanged.
- **Monospace + read-only** — a `new TextArea(planText)` with `setEnabled(false)`/read-only and a monospace CSS class (the app already sets component CSS via setters; use `addClass("explain-plan")` + an app stylesheet rule `font-family: monospace; white-space: pre;`). A `TextArea` is chosen over a raw `<pre>` because it is a published component the panel already imports ([`QueryPanel.ts:20`](frontend/src/dock/QueryPanel.ts#L20)) and gives scroll + selection for free.
- **The normal rows path is untouched** — a non-explain `SELECT` still renders a `Table` exactly as today; only an explain run swaps in the text pane. The panel routes on `result.kind`: `"rows"` → Table, `"status"` → hide pane, **`"explain"` → monospace TextArea**.

The Clear button ([`QueryPanel.ts:81`](frontend/src/dock/QueryPanel.ts#L81)) resets both — its `syncClearEnabled` already keys on "a result on screen", so it enables for an explain plan too.

### No new library API

Everything composes published pieces: `TextArea` (already imported), `ToolBar`/`Button`/`glyphButton` (already used), the two glyphs from `glyphs/solid`, and the existing CQRS `Command` base ([`backend/app/operations/base.py`](backend/app/operations/base.py)). The follow-on JSON→Tree cut would use the already-published `Tree` ([`component/tree`](../../typescript-ui/src/typescript/lib/component/tree/index.ts)). No `@jimka/typescript-ui` source change.

---

## Public API

App-level additions (external workspace; nothing exported from a library barrel).

```typescript
// frontend/src/contract.ts — new result variant + the run request shape

/** EXPLAIN output format. TEXT is the first cut; JSON is the follow-on tree source. */
export type ExplainFormat = "text" | "json";

/** The result of an EXPLAIN / EXPLAIN ANALYZE run. */
export interface QueryExplainResult {
    kind:    "explain";
    format:  ExplainFormat;
    analyze: boolean;
    /** FORMAT TEXT: the joined plan text (one plan line per source row). */
    plan:    string;
    /** FORMAT JSON: the raw parsed plan tree (follow-on; omitted in the text cut). */
    planJson?: unknown;
}

// Extend the run-result union so the panel routes explain results distinctly.
export type QueryResult = QueryRowsResult | QueryStatusResult | QueryExplainResult;
```

```typescript
// frontend/src/data/explain.ts — new module (pure, DOM-free, offline-tested)

export interface ExplainOptions { analyze: boolean; format: ExplainFormat; }

/** Prefix `sql` with EXPLAIN [ANALYZE] [FORMAT …]; does NOT mutate the editor text. */
export function buildExplainSql(sql: string, opts: ExplainOptions): string;

/**
 * Best-effort lexical check: is `sql`'s first significant statement a read
 * (SELECT / TABLE / VALUES / SHOW / WITH…SELECT)? Conservative — unknown/ambiguous
 * returns false. Gates the frontend EXPLAIN ANALYZE warning (backend rollback is
 * the authoritative net).
 */
export function isReadOnlyStatement(sql: string): boolean;
```

```typescript
// frontend/src/data/api.ts — new typed-fetch entry (POST /api/{conn}/explain)
export function runExplain(
    connectionId: string,
    sql:          string,
    opts:         ExplainOptions,
): Promise<QueryExplainResult>;
```

```typescript
// frontend/src/dock/QueryPanel.ts — QueryPanelOptions gains one injected closure
export interface QueryPanelOptions {
    runQuery: RunQuery;                          // (existing)
    notify:   Notify;                            // (existing)
    onError:  (error: unknown) => void;          // (existing)
    initialSql?: string;                         // (existing)
    autoRun?:    boolean;                         // (existing)
    // NEW: run an EXPLAIN / EXPLAIN ANALYZE (controller binds it to the connection).
    runExplain: (sql: string, opts: ExplainOptions) => Promise<QueryExplainResult>;
}
```

```typescript
// frontend/src/SqlAdminController.ts — openQuery injects runExplain
// QueryPanel({ ..., runExplain: (sql, opts) => runExplain(this._connectionId, sql, opts) })
```

```python
# backend/app/operations/explain_query.py — new CQRS Command
class ExplainQueryCommand(Command):
    def __init__(self, conn, sql: str, analyze: bool, fmt: str) -> None: ...
    async def apply(self) -> None: ...   # ANALYZE -> run in a ROLLED-BACK transaction
    def get_result(self) -> dict: ...    # -> {"kind":"explain","format","analyze","plan"} (pure)

# backend/app/main.py — new thin route
@app.post("/api/{connection_id}/explain")
async def explain_query(connection_id: str, body: dict = Body(...)) -> dict: ...
#   body = {"sql": str, "analyze": bool, "format": "text"|"json"}
```

---

## Internal Structure

### `explain.ts` (frontend, pure)

```typescript
export function buildExplainSql(sql, { analyze, format }) {
    const parts = ["EXPLAIN"];
    if (analyze) parts.push("ANALYZE");
    parts.push(`FORMAT ${format === "json" ? "JSON" : "TEXT"}`);
    // PostgreSQL accepts "EXPLAIN (ANALYZE, FORMAT JSON) <sql>" or the legacy
    // "EXPLAIN ANALYZE <sql>"; use the parenthesized option list for clarity:
    const options = analyze ? `(ANALYZE, FORMAT ${format === "json" ? "JSON" : "TEXT"})`
                            : `(FORMAT ${format === "json" ? "JSON" : "TEXT"})`;
    return `EXPLAIN ${options} ${sql.trim()}`;
}
```

`isReadOnlyStatement`: strip leading `--`/`/* */` comments and whitespace, uppercase the first token; return `true` iff it is one of `SELECT|TABLE|VALUES|SHOW`, or `WITH` whose first top-level statement keyword after the CTE list is `SELECT|VALUES` (best-effort: if the `WITH` body cannot be cheaply resolved, return `false`). Everything else (`INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|…`, empty, unknown) → `false`.

### `ExplainQueryCommand` (backend) — the rollback net

```python
class _ExplainDone(Exception):
    """Sentinel: plan captured, force the ANALYZE transaction to roll back."""

class ExplainQueryCommand(Command):
    def __init__(self, conn, sql, analyze, fmt):
        if not sql or not sql.strip():
            raise ValidationError("Empty SQL statement")
        if fmt not in ("text", "json"):
            raise ValidationError(f"Unsupported EXPLAIN format: {fmt}")
        self._conn, self._sql, self._analyze, self._fmt = conn, sql, analyze, fmt
        self._plan = None

    async def apply(self):
        opts = ("ANALYZE, " if self._analyze else "") + f"FORMAT {self._fmt.upper()}"
        stmt = f"EXPLAIN ({opts}) {self._sql}"
        if self._analyze:
            # ANALYZE executes the statement — run it, capture the plan, then FORCE
            # ROLLBACK so any DML/DDL side-effect is discarded (safety net even if
            # the frontend guard is bypassed).
            try:
                async with self._conn.transaction():
                    self._plan = await self._conn.fetch(stmt)
                    raise _ExplainDone()
            except _ExplainDone:
                pass
        else:
            # Plain EXPLAIN only plans — no execution, no side-effect, no rollback.
            self._plan = await self._conn.fetch(stmt)

    def get_result(self):
        if self._plan is None:
            raise RuntimeError("get_result() called before apply()")
        if self._fmt == "json":
            # FORMAT JSON returns a single row whose one column is the plan array.
            return {"kind": "explain", "format": "json", "analyze": self._analyze,
                    "plan": "", "planJson": self._plan[0][0] if self._plan else None}
        # FORMAT TEXT: one row per plan line; join into a single text block.
        text = "\n".join(r[0] for r in self._plan)
        return {"kind": "explain", "format": "text", "analyze": self._analyze, "plan": text}
```

The `_ExplainDone` sentinel is caught immediately outside the `transaction()` block, so asyncpg rolls the transaction back (body raised) while the captured `self._plan` survives — the plan is read, the writes are not committed. Mirrors the existing op's temporal-coupling guard style ([`run_query.py:159`](backend/app/operations/run_query.py#L159)).

### Route (backend `main.py`)

```python
@app.post("/api/{connection_id}/explain")
async def explain_query(connection_id: str, body: dict = Body(...)) -> dict:
    async with get_pool(connection_id).acquire() as c:
        op = ExplainQueryCommand(c, body.get("sql", ""),
                                 bool(body.get("analyze", False)),
                                 str(body.get("format", "text")))
        await op.apply()
        return op.get_result()
```

Thin, mirroring the `/query` route ([`main.py:382`](backend/app/main.py#L382)); a SQL error is an `asyncpg.PostgresError` already mapped to `(400|409, {detail})` by the existing handler ([`main.py:80`](backend/app/main.py#L80)) — no new error wiring.

### QueryPanel wiring

Two new toolbar buttons and an explain-run function; `showResult` gains an `"explain"` branch:

```typescript
const explainButton = glyphButton("diagram_project", NEUTRAL_COLOR, "Explain", () => void runExplainRun(false));
const analyzeButton = glyphButton("flask", CLEAR_COLOR, "Explain Analyze (executes the statement)",
                                  () => void runExplainRun(true));

async function runExplainRun(analyze: boolean): Promise<void> {
    const sql = editor.getValue().trim();
    if (!sql) { notify("Enter a SQL statement"); return; }
    if (analyze && !isReadOnlyStatement(sql)) {
        notify("EXPLAIN ANALYZE will EXECUTE this statement (rolled back). "
             + "It does not look read-only — use Explain to see the plan without running it.");
        return;                                   // frontend guard: do NOT run ANALYZE
    }
    // reuse the run-seq guard + button disabling that run() already has
    const result = await runExplain(sql, { analyze, format: "text" });
    showResult(result);                            // routes on kind: "explain"
}

// in showResult:
if (result.kind === "explain") {
    const view = new TextArea(result.plan);
    view.setEnabled(false);
    view.addClass("explain-plan");                 // app CSS: monospace + pre
    showResultPane(view);
    notify(result.analyze ? "EXPLAIN ANALYZE plan (side-effects rolled back)" : "EXPLAIN plan");
    return;
}
```

`runExplainRun` shares the monotonic `runSeq` guard and Run-disabled behaviour with `run()` ([`QueryPanel.ts:150`](frontend/src/dock/QueryPanel.ts#L150)) — disable all action buttons while an explain is in flight so a slow explain cannot clobber a newer run, and vice versa.

---

## Ordered Implementation Steps

**Backend**

1. `backend/app/operations/explain_query.py` (new): `ExplainQueryCommand` + `_ExplainDone` per *Internal Structure*. Verify: imports cleanly.
2. `backend/app/operations/__init__.py`: export `ExplainQueryCommand`. Verify: `python -c "from app.operations import ExplainQueryCommand"`.
3. `backend/app/main.py`: add `POST /api/{connection_id}/explain`. Verify: route in the OpenAPI schema.
4. `backend/tests/test_explain_query.py` (new): pure `get_result()` — text join, json passthrough, the `analyze` flag, empty-SQL/bad-format `ValidationError`, the temporal-coupling guard — following the offline `NO_CONN` style of [`backend/tests/test_run_query.py`](backend/tests/test_run_query.py). Verify: `pytest tests/test_explain_query.py` green.
5. Integration (disposable Postgres): `EXPLAIN (FORMAT TEXT) SELECT 1` returns `kind:"explain"` text; `EXPLAIN (ANALYZE, FORMAT TEXT) INSERT INTO t …` returns a plan **and leaves `t` unchanged** (rollback net — assert the row count before/after is equal); a syntax error returns `(400, {detail})`.

**Frontend**

6. `frontend/src/contract.ts`: add `ExplainFormat`, `QueryExplainResult`; extend `QueryResult`. Verify: `tsc` clean.
7. `frontend/src/data/explain.ts` (new): `buildExplainSql`, `isReadOnlyStatement`, `ExplainOptions`. Verify: `tsc` clean.
8. `frontend/src/data/explain.test.ts` (new): prefix construction (analyze on/off, format text/json, trailing whitespace trimmed); `isReadOnlyStatement` truth table (SELECT/WITH-SELECT/VALUES/TABLE/SHOW → true; INSERT/UPDATE/DELETE/CREATE/DROP/comment-led/empty/unknown → false). Red-green. Verify: `vitest run explain` green.
9. `frontend/src/data/api.ts`: add `runExplain(connectionId, sql, opts)` — POST `/api/${conn}/explain`, body `{ sql, analyze, format }`, reuse `postJson`/`readDetail` ([`api.ts:41`](frontend/src/data/api.ts#L41)). Verify: `tsc` clean; a `runExplain` unit test with mocked `fetch` (mirrors `api.test.ts`).
10. `frontend/src/dock/QueryPanel.ts`: add the `runExplain` option; the two glyph buttons; `runExplainRun(analyze)` with the frontend guard + shared run-seq/disable; the `"explain"` branch in `showResult` rendering a read-only monospace `TextArea`. Register the `diagram_project`/`flask` glyphs. Verify: `tsc` clean; existing Run/Clear/rows/status behaviour unchanged.
11. `frontend/src/SqlAdminController.ts`: inject `runExplain: (sql, opts) => runExplain(this._connectionId, sql, opts)` into `QueryPanel({...})` ([`SqlAdminController.ts:182`](frontend/src/SqlAdminController.ts#L182)). Verify: `tsc` clean.
12. App CSS (wherever the app's global stylesheet lives): `.explain-plan { font-family: monospace; white-space: pre; }`. Verify: the plan renders monospace with preserved indentation.

**Regression**

13. `grep -rn "@jimka/typescript-ui/" frontend/src` — every import a published subpath. App `tsc` + `vitest run` green; backend `pytest` green.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/data/explain.ts` — `buildExplainSql` + `isReadOnlyStatement` |
| Create | `frontend/src/data/explain.test.ts` — prefix + read-only-guard tests |
| Modify | `frontend/src/contract.ts` — `QueryExplainResult` + `QueryResult` union |
| Modify | `frontend/src/data/api.ts` — `runExplain` |
| Modify | `frontend/src/dock/QueryPanel.ts` — Explain/Analyze buttons, explain run, plan render *(shared: query-workspace, result-export)* |
| Modify | `frontend/src/SqlAdminController.ts` — inject `runExplain` *(shared: query-workspace, result-export)* |
| Create | `backend/app/operations/explain_query.py` — `ExplainQueryCommand` (rollback net) |
| Modify | `backend/app/operations/__init__.py` — export `ExplainQueryCommand` |
| Modify | `backend/app/main.py` — `POST /api/{conn}/explain` route |
| Create | `backend/tests/test_explain_query.py` — pure-logic tests |
| Modify | app global stylesheet — `.explain-plan` monospace rule |

**No `@jimka/typescript-ui` source is created or modified.**

---

## Expected Behaviour

### `buildExplainSql` — unit-testable offline
- `buildExplainSql("SELECT 1", {analyze:false, format:"text"})` → `EXPLAIN (FORMAT TEXT) SELECT 1`.
- `analyze:true` → `EXPLAIN (ANALYZE, FORMAT TEXT) SELECT 1`.
- `format:"json"` → `EXPLAIN (FORMAT JSON) …`.
- Trailing/leading whitespace in `sql` is trimmed; the editor's original text is not mutated (the helper returns a new string).

### `isReadOnlyStatement` — unit-testable offline (the ANALYZE guard)
- `SELECT …`, `  select …`, `WITH x AS (…) SELECT …`, `VALUES (1)`, `TABLE t`, `SHOW all` → `true`.
- `INSERT …`, `UPDATE …`, `DELETE …`, `CREATE …`, `DROP …`, `ALTER …`, `TRUNCATE …`, `GRANT …` → `false`.
- A comment-led read (`-- c\nSELECT 1`, `/* c */ SELECT 1`) → `true` (comments stripped); a comment-led write → `false`.
- Empty / whitespace-only / unrecognized first token → `false` (conservative).

### Backend `ExplainQueryCommand.get_result()` / `apply()` — unit-testable offline (no DB) + integration
- **Pure:** `get_result()` joins FORMAT TEXT plan rows into one `plan` string; FORMAT JSON passes the parsed plan through `planJson`; `analyze` flag echoed; `get_result()` before `apply()` raises `RuntimeError`; empty SQL / bad format raise `ValidationError`.
- **Integration (needs a DB):** plain `EXPLAIN` does not execute the statement; `EXPLAIN ANALYZE INSERT/UPDATE/DELETE` returns a real plan **and the target table is unchanged afterward** (the rollback net — assert row counts equal before/after); a syntax error surfaces `(400, {detail})`.

### `runExplain` (frontend api) — unit-testable offline (mocked `fetch`)
- POSTs `{ sql, analyze, format }` to `/api/${conn}/explain`; on non-OK throws the backend `{detail}` (reuses `readDetail`).

### QueryPanel + toolbar + rendering — manual-verify (DOM events, layout, focus; node-only vitest has no DOM)
- The toolbar shows **Explain** and **Explain Analyze** buttons beside Run/Clear.
- **Explain** on a `SELECT` renders the text plan in the result pane as read-only monospace (preserved indentation), status "EXPLAIN plan"; the normal rows path is unaffected (a plain Run still shows a `Table`).
- **Explain** on an `INSERT`/`UPDATE`/DDL renders its plan and does **not** execute it (plain EXPLAIN never runs the statement).
- **Explain Analyze** on a read-only statement renders the actual-time plan, status noting side-effects rolled back.
- **Explain Analyze** on a non-read-only statement is **blocked in the frontend** with the warning message and does **not** round-trip (the guard); the user can still press plain **Explain**.
- A blank editor Explain/Analyze is a no-op with "Enter a SQL statement".
- After an explain, **Clear** resets the pane (editor back to full height); a subsequent normal `SELECT` Run shows a `Table` again (no bleed from the explain text pane).
- A slow explain whose result arrives after a newer run started is discarded (shared run-seq guard); action buttons disable during an in-flight explain.
- A SQL error in an explained statement surfaces its `{detail}` via `notifyError`; buttons re-enable.

---

## Verification

- **Offline (`vitest run`):** `explain` (prefix + read-only guard), `runExplain` (mocked fetch) green — every unit-testable behaviour above.
- **Offline (`pytest`):** `test_explain_query.py` (pure `get_result`, empty/bad-format validation, temporal-coupling guard) green.
- **Typecheck:** app `tsc` clean; `TextArea`/`ToolBar`/`Button` resolve from their published buckets.
- **Grep invariants:** `grep -rn "@jimka/typescript-ui/" frontend/src` — every import a published subpath; `grep -n "kind === \"explain\"" frontend/src/dock/QueryPanel.ts` — the explain branch present and the rows/status branches intact.
- **Backend integration (disposable Postgres):** `EXPLAIN (FORMAT TEXT) SELECT 1` → text plan; `EXPLAIN (ANALYZE, FORMAT TEXT) INSERT INTO t VALUES (…)` → plan **with `t` unchanged after** (rollback net); syntax error → `(400, {detail})`.
- **Manual smoke (browser):** Explain a `SELECT` (monospace plan, rows path still works separately); Explain Analyze a `SELECT` (actual times); attempt Explain Analyze on an `UPDATE` (frontend blocks with warning, no round-trip); Explain an `UPDATE` (plan, no execution); Clear then run a normal `SELECT` (Table, no bleed).
- **Library repo:** unaffected — no `/home/jika/typescript/typescript-ui` source change.

---

## Documentation Impact

**None on the library** — no `@jimka/typescript-ui` public symbol is added or changed. The new symbols (`QueryExplainResult`/`ExplainFormat` in `contract.ts`, `buildExplainSql`/`isReadOnlyStatement` in `explain.ts`, `runExplain` in `api.ts`, `ExplainQueryCommand` backend) are **app-internal** to the `sqladmin` workspace, documented in-place by doc-comments per the app's conventions. If sqladmin keeps a user-facing feature list, add "EXPLAIN / EXPLAIN ANALYZE plan view".

---

## Potential Challenges

- **`EXPLAIN ANALYZE` side-effects** — the central hazard. Mitigation: two layers — the pure `isReadOnlyStatement` frontend guard (warns + aborts on a non-read) *and* the backend's rolled-back ANALYZE transaction (authoritative; discards any write even if the guard is bypassed). Documented and tested both ways.
- **Merge coordination with query-workspace / result-export** — all three touch `QueryPanel.ts` and `SqlAdminController.ts`. Mitigation: this plan adds a *new* toolbar button pair, a *new* `showResult` branch, and a *new* injected option — additive, no rewrite of the run path or `buildMenuBar` (which query-workspace owns). Implement after query-workspace lands, or rebase the additive hunks onto it.
- **Reshaping the FORMAT TEXT plan** — a text plan comes back as multiple single-column rows. Mitigation: the dedicated backend op joins them into one `plan` string, so the frontend never reshapes a generic rows result — the panel routes purely on `kind:"explain"`.
- **`isReadOnlyStatement` is lexical, not a parser** — a pathological `WITH` (CTE that writes via a data-modifying CTE, `WITH x AS (INSERT … RETURNING …) SELECT …`) could look read-only. Mitigation: the backend rollback net catches it; the frontend check is conservative and best-effort by design, and the risk is bounded to *rolled-back* execution.
- **Monospace styling** — a `TextArea` needs an app CSS class for monospace/pre. Mitigation: one stylesheet rule `.explain-plan`; if the app has no global sheet, add the rule where the app already registers CSS (the app sets component CSS via setters per its conventions).

---

## Critical Files

**App (read/modify — mirror existing patterns):**
- `frontend/src/dock/QueryPanel.ts` — the toolbar + `glyphButton` ([`:226`](frontend/src/dock/QueryPanel.ts#L226)), `run()`/`showResult`/`showResultPane` ([`:152`,`:182`,`:90`](frontend/src/dock/QueryPanel.ts#L152)), the run-seq guard ([`:150`](frontend/src/dock/QueryPanel.ts#L150)), the `TextArea` import ([`:20`](frontend/src/dock/QueryPanel.ts#L20)).
- `frontend/src/SqlAdminController.ts` — `openQuery` injecting the panel options ([`:172`,`:182`](frontend/src/SqlAdminController.ts#L172)), `notifyError`/`detailOf`.
- `frontend/src/contract.ts` — `QueryResult`/`QueryRowsResult`/`QueryStatusResult` ([`:45`–`67`](frontend/src/contract.ts#L45)).
- `frontend/src/data/api.ts` — `postJson`/`readDetail`/`runQuery` idiom ([`:41`,`:86`](frontend/src/data/api.ts#L41)).
- `frontend/src/data/sql.ts` + `sql.test.ts` — the pure-helper + offline-test placement precedent to mirror for `explain.ts`.
- `backend/app/operations/run_query.py` — the `Command` + transaction shape `ExplainQueryCommand` mirrors (and the commit behaviour it must NOT reuse for ANALYZE).
- `backend/app/main.py` — the thin `/query` route ([`:382`](backend/app/main.py#L382)) + the `asyncpg.PostgresError` handler ([`:80`](backend/app/main.py#L80)).
- `backend/tests/test_run_query.py` — the offline `NO_CONN` test style for `test_explain_query.py`.
- `plans/query-workspace.md` — the anchor plan owning the Query menu + run path this builds on.

**Library (read for the composed components — do not modify):**
- [`component/input/TextArea.ts`](../../typescript-ui/src/typescript/lib/component/input/TextArea.ts) — the read-only monospace plan view.
- [`component/tree/Tree.ts`](../../typescript-ui/src/typescript/lib/component/tree/Tree.ts) — `setNodes(TreeNode[])`, the JSON→tree follow-on source (not built now).

---

## Non-Goals

- **`FORMAT JSON` → `Tree` plan view** — the richer follow-on. The `format` field is carried end-to-end (contract, api, backend) so it slots in via a pure `parseJsonPlan(json) -> TreeNode[]` mapper + a `Tree` in the result pane; not built in the first cut (text is the low-risk start).
- **An "Explain current query" Query-menu item** — deferred to query-workspace's menu ownership; would need a focused-panel handle the menu wiring does not thread today.
- **A keyboard shortcut for Explain** — avoided to not collide with query-workspace's `Ctrl+↑/↓`/`Ctrl+Shift+Enter` claims; buttons only.
- **`EXPLAIN (BUFFERS/COSTS/VERBOSE/SETTINGS …)` option toggles** — only `ANALYZE` + `FORMAT` are exposed; the extra EXPLAIN options are a later enhancement.
- **Plan visualization / cost heatmaps** — the text (and future tree) plan is shown verbatim; no graphical plan diagram.
- **Multi-statement explain** — one statement per run, inheriting the extended-protocol single-statement constraint from the query path.
