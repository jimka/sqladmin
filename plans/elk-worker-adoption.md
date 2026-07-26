# ELK Web-Worker Adoption in sqladmin Diagrams — Implementation Plan

## Overview

Every schema/relation/database/role/explain diagram in sqladmin runs its ELK layout on the main thread today. Opening the 154-table "hub" schema diagram freezes the UI for roughly 14 seconds while ELK computes positions. This plan moves that compute off the main thread by passing the typescript-ui library's new `elkWorkerFactory` option to every `DiagramView` the app builds, so ELK runs in a Web Worker and the UI stays responsive during layout.

The app builds `DiagramView` in six places under [`frontend/src/dock/`](frontend/src/dock/): three panels **extend** `DiagramView` and forward options through `super(...)` — [`SchemaDiagramPanel.ts:29`](frontend/src/dock/SchemaDiagramPanel.ts#L29), [`RelationGraphPanel.ts:49`](frontend/src/dock/RelationGraphPanel.ts#L49), [`RoleGrantsDiagramPanel.ts:40`](frontend/src/dock/RoleGrantsDiagramPanel.ts#L40) — and three panels **construct** `DiagramView` internally as a child component — [`DatabaseDiagramPanel.ts:96`](frontend/src/dock/DatabaseDiagramPanel.ts#L96), [`RelationDiagramPanel.ts:92`](frontend/src/dock/RelationDiagramPanel.ts#L92), [`ExplainDiagramPanel.ts:163`](frontend/src/dock/ExplainDiagramPanel.ts#L163). The change adds one shared factory module and threads its export into all six option bags. No layout logic, no rendering, and no controller code changes.

**This plan cannot be implemented or verified yet — it has a hard dependency on an unreleased library change.** The `DiagramViewOptions.elkWorkerFactory?: () => Worker` option is planned in [`typescript-ui/plans/elk-layout-web-worker.md`](../../typescript-ui/plans/elk-layout-web-worker.md) and does not exist in the built library yet. sqladmin consumes the library's **built, symlinked** `dist/lib` ([`frontend/node_modules/@jimka/typescript-ui` → `typescript-ui/packages/lib`](frontend/node_modules/@jimka/typescript-ui)), so this feature typechecks and runs only after that library plan is implemented **and** `npm run build:lib` has been run in typescript-ui. See [Non-Goals](#non-goals) for the ordering constraint.

---

## Architecture Decisions

### elkjs is already a direct dependency — no `package.json` change

`elkjs` is already a committed direct dependency of the app at [`frontend/package.json:21`](frontend/package.json#L21) (`"elkjs": "^0.10.0"`, installed 0.10.2), matching exactly the version the library declares as an optional peer.[^direct-dep] The bundler can therefore resolve `new URL("elkjs/lib/elk-worker.min.js", import.meta.url)` from the app's own `node_modules`. **No dependency needs to be added.** The implementer verifies the entry is present rather than adding it.

### One shared factory module in `dock/`

Define the `() => Worker` factory once in a new lowercase helper module, [`frontend/src/dock/elkWorkerFactory.ts`](frontend/src/dock/elkWorkerFactory.ts), and import it into all six panels.[^shared-module] This mirrors the app's existing dock-helper convention — small, lowercase-named, single-purpose modules shared across the dock panels, such as [`glyphButton.ts`](frontend/src/dock/glyphButton.ts), [`tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts), and [`exportButton.ts`](frontend/src/dock/exportButton.ts). Panels already import sibling helpers by relative path (e.g. `RelationDiagramPanel` imports [`./TableCardNode`](frontend/src/dock/RelationDiagramPanel.ts#L35)).

### The worker is `{ type: "classic" }`

The factory constructs the worker as `{ type: "classic" }`. `elkjs/lib/elk-worker.min.js` is a classic browserify script that references `module.exports` at top level; a module worker would fail to load. This is the library plan's documented consumer contract — see its `type: "classic"` decision and recipe.[^classic]

### Apply the worker uniformly, including Explain

Thread the factory into all six panels, including `ExplainDiagramPanel`, even though explain plans are usually small.[^uniform] When a factory is set the library always attempts the worker and falls back to the main thread on any failure, so there is no downside to a small graph and one rule ("every DiagramView gets the factory") is simpler to hold and to grep than a per-panel exception.

### Fallback is the library's responsibility

The app passes the factory and does nothing else. If the worker cannot be constructed or its first layout fails, the library transparently rebuilds on the main thread and the diagram still renders. The app has no fallback code to write; the contract lives in the library plan.[^fallback]

---

## Public API

No new app exports beyond the shared factory module. The library option consumed is:

```typescript
// From typescript-ui DiagramViewOptions (unreleased — see the library plan):
elkWorkerFactory?: () => Worker;
```

New app module:

```typescript
// frontend/src/dock/elkWorkerFactory.ts
/**
 * Shared ELK Web-Worker factory for every diagram panel. Passed to
 * DiagramView's `elkWorkerFactory` option so ELK layout runs off the main
 * thread. `type: "classic"` is required — elk-worker.min.js is a classic
 * browserify script; a module worker would fail to load. Vite statically
 * resolves the `new URL(..., import.meta.url)` specifier and emits the worker
 * asset from the app's own elkjs install.
 */
export const elkWorkerFactory = (): Worker =>
    new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url), { type: "classic" });
```

The export name `elkWorkerFactory` deliberately matches the library option name, so each panel forwards it with object-property shorthand: `{ data, elkWorkerFactory }`.

---

## Ordered Implementation Steps

Do these **after** the library plan is implemented and `npm run build:lib` has been run in typescript-ui (see [Verification](#verification)). Until then the option is absent and `npm run typecheck` will fail on it.

1. **Verify elkjs is a direct dep.** `grep -n '"elkjs"' frontend/package.json` — expect one hit (`"elkjs": "^0.10.0"`). It is already present; if for any reason it is missing, add `"elkjs": "^0.10.0"` to `dependencies` and run `npm install` in `frontend/`.

2. **Create `frontend/src/dock/elkWorkerFactory.ts`** with the module shown in [Public API](#public-api). No side effects at module scope — the arrow is defined but never called at import time.
   - Check: `grep -n 'type: "classic"' frontend/src/dock/elkWorkerFactory.ts` — one hit.

3. **`SchemaDiagramPanel.ts`** — add the import `import { elkWorkerFactory } from "./elkWorkerFactory";` and change the `super({ data })` at [L29](frontend/src/dock/SchemaDiagramPanel.ts#L29) to `super({ data, elkWorkerFactory })`.

4. **`RelationGraphPanel.ts`** — add the import and change `super({ data, nodeRenderer })` at [L49](frontend/src/dock/RelationGraphPanel.ts#L49) to `super({ data, nodeRenderer, elkWorkerFactory })`.

5. **`RoleGrantsDiagramPanel.ts`** — add the import and change `super({ data })` at [L40](frontend/src/dock/RoleGrantsDiagramPanel.ts#L40) to `super({ data, elkWorkerFactory })`.

6. **`DatabaseDiagramPanel.ts`** — add the import and change `DiagramView({ data: overviewGraph })` at [L96](frontend/src/dock/DatabaseDiagramPanel.ts#L96) to `DiagramView({ data: overviewGraph, elkWorkerFactory })`.

7. **`RelationDiagramPanel.ts`** — add the import and change `DiagramView({ data: base, nodeRenderer })` at [L92](frontend/src/dock/RelationDiagramPanel.ts#L92) to `DiagramView({ data: base, nodeRenderer, elkWorkerFactory })`.

8. **`ExplainDiagramPanel.ts`** — add the import and change `new DiagramView({ data, nodeRenderer: (n: DiagramNodeData) => ExplainNode(n) })` at [L163](frontend/src/dock/ExplainDiagramPanel.ts#L163) to `new DiagramView({ data, nodeRenderer: (n: DiagramNodeData) => ExplainNode(n), elkWorkerFactory })`.

9. **Grep invariant — every DiagramView construction forwards the factory.** Both commands below must agree on the same six sites:
   - `grep -rn 'DiagramView(' frontend/src/dock/*.ts | grep -v '\.test\.'` — the three internal constructions (`DatabaseDiagramPanel`, `RelationDiagramPanel`, `ExplainDiagramPanel`).
   - `grep -rn 'super({ data' frontend/src/dock/*.ts` — the three extending panels (`SchemaDiagramPanel`, `RelationGraphPanel`, `RoleGrantsDiagramPanel`).
   - `grep -rLn elkWorkerFactory frontend/src/dock/SchemaDiagramPanel.ts frontend/src/dock/RelationGraphPanel.ts frontend/src/dock/RoleGrantsDiagramPanel.ts frontend/src/dock/DatabaseDiagramPanel.ts frontend/src/dock/RelationDiagramPanel.ts frontend/src/dock/ExplainDiagramPanel.ts` — expect **zero** files listed (every panel references the factory).

10. **Typecheck.** `cd frontend && npm run typecheck` clean. (In a worktree, symlink `frontend/node_modules` to the main tree first per repo memory.)

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/elkWorkerFactory.ts` |
| Modify | `frontend/src/dock/SchemaDiagramPanel.ts` |
| Modify | `frontend/src/dock/RelationGraphPanel.ts` |
| Modify | `frontend/src/dock/RoleGrantsDiagramPanel.ts` |
| Modify | `frontend/src/dock/DatabaseDiagramPanel.ts` |
| Modify | `frontend/src/dock/RelationDiagramPanel.ts` |
| Modify | `frontend/src/dock/ExplainDiagramPanel.ts` |

`frontend/package.json` is **not** modified — elkjs is already a direct dependency. `frontend/vite.config.ts` is **not** modified unless the dev-build check in [Verification](#verification) shows the worker asset failing to emit (see [Potential Challenges](#potential-challenges)).

---

## Expected Behaviour

The app change is pure wiring: a one-line factory module plus six identical option additions. There is no branching or data logic to unit-test, and the app's test harness cannot exercise it (see below). The behaviours split into static checks and manual checks.

**Statically verifiable (typecheck + grep, not runtime tests):**

1. `frontend/src/dock/elkWorkerFactory.ts` exists and exports `elkWorkerFactory` as a `() => Worker`.
2. Each of the six panels imports `elkWorkerFactory` and passes it in its `DiagramView` option bag (the grep invariant in step 9).
3. `npm run typecheck` passes — the option name and `() => Worker` type match the library's `DiagramViewOptions.elkWorkerFactory`. This is what proves the library change actually shipped: before `build:lib`, the option is absent and the typecheck fails.

**Manual verification only (browser — the harness can't do these):**[^no-unit]

4. **Off-thread layout, no freeze.** Open the 154-table hub schema diagram. The UI stays responsive during layout (a spinner keeps animating, the tab strip stays interactive) instead of freezing for ~14 s. The diagram renders the same node/edge layout as before.
5. **Worker asset resolves.** In the dev build, the browser Network panel shows `elk-worker` (a hashed worker asset) loading, and the diagram populates. This confirms Vite resolved `elkjs/lib/elk-worker.min.js` from the app's own elkjs and emitted the worker.
6. **Fallback still renders.** If the worker cannot construct or errors (e.g. a strict `worker-src 'none'` CSP), the diagram still renders via the library's main-thread fallback with no diagram error surfaced. This is the library's contract, exercised here only to confirm the app surfaces it correctly.
7. **Other diagrams unaffected.** The relation, database, role-grants, role-membership (which reuses `RelationDiagramPanel`), and explain diagrams open and render as before.

---

## Verification

**Ordering gate (must happen first):** In `typescript-ui`, implement [`plans/elk-layout-web-worker.md`](../../typescript-ui/plans/elk-layout-web-worker.md), then run `npm run build:lib` there so the symlinked `dist/lib` sqladmin consumes actually exposes `elkWorkerFactory`. Confirm with `grep -rn elkWorkerFactory frontend/node_modules/@jimka/typescript-ui/dist/lib/` — expect hits before proceeding. Skipping this makes every step below fail on the missing option.

- **Typecheck:** `cd frontend && npm run typecheck` clean.
- **Grep invariants:** the three greps in step 9 — six construction sites, all referencing `elkWorkerFactory`.
- **Tests:** `cd frontend && npm test`. No new tests; existing pure-data-helper tests stay green (they don't touch the panels).
- **Dev build / worker asset:** run `npm run dev`, open the app (log in with Host `sqladmin-db` per project notes), open the hub schema diagram, and confirm checks 4–5 in [Expected Behaviour](#expected-behaviour) via the `verify` skill / chrome-devtools flow (scope DevTools to `.DiagramView`).
- **Fallback smoke:** check 6, optional but recommended once, to confirm the app degrades cleanly.

---

## Potential Challenges

- **Library not built yet.** The whole change fails to typecheck until the library option ships and `build:lib` runs. Mitigation: the ordering gate above is the first verification step; treat a typecheck failure on `elkWorkerFactory` as "library not rebuilt," not an app bug.
- **Vite worker emission for a bare specifier.** `new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url), { type: "classic" })` relies on Vite statically resolving a bare package specifier inside `new URL(..., import.meta.url)` and emitting a classic worker. Vite supports this idiom and the library plan verified a downstream Vite build resolves and emits the worker from the consumer's elkjs. Mitigation: check 5 confirms the asset at implement time; if the worker fails to emit in dev, the library's main-thread fallback keeps the diagram rendering while the config is sorted.
- **Existing `optimizeDeps.include` is about a different file.** [`vite.config.ts`](frontend/vite.config.ts) pre-bundles `elkjs/lib/elk.bundled.js` (the main-thread module the library lazily imports). The worker file `elk-worker.min.js` is a separate asset handled by Vite's worker pipeline, not by `optimizeDeps`, so no new `optimizeDeps` entry is expected. Mitigation: only touch `vite.config.ts` if check 5 shows the worker asset failing; do not add config speculatively.
- **Classic-vs-module worker.** Using `{ type: "module" }` by mistake yields a worker that fails to load and silently falls back to the main thread — no error, but no off-thread benefit and the freeze returns. Mitigation: the single shared module hard-codes `{ type: "classic" }`, so there is one place to get it right.

---

## Critical Files

- [`typescript-ui/plans/elk-layout-web-worker.md`](../../typescript-ui/plans/elk-layout-web-worker.md) — the unreleased library change this depends on: the exact `elkWorkerFactory` API, the precedence and fallback contract, and the `type: "classic"` rationale.
- [`frontend/src/dock/SchemaDiagramPanel.ts`](frontend/src/dock/SchemaDiagramPanel.ts), [`RelationGraphPanel.ts`](frontend/src/dock/RelationGraphPanel.ts), [`RoleGrantsDiagramPanel.ts`](frontend/src/dock/RoleGrantsDiagramPanel.ts) — the three panels that extend `DiagramView` and forward via `super(...)`.
- [`frontend/src/dock/DatabaseDiagramPanel.ts`](frontend/src/dock/DatabaseDiagramPanel.ts), [`RelationDiagramPanel.ts`](frontend/src/dock/RelationDiagramPanel.ts), [`ExplainDiagramPanel.ts`](frontend/src/dock/ExplainDiagramPanel.ts) — the three panels that construct `DiagramView` internally.
- [`frontend/src/dock/glyphButton.ts`](frontend/src/dock/glyphButton.ts) — the dock-helper-module precedent the new factory module mirrors (lowercase, single-purpose, shared across panels).
- [`frontend/vite.config.ts`](frontend/vite.config.ts) — the existing elkjs `optimizeDeps.include`; read it to understand why the worker asset is a separate, config-free concern.
- [`frontend/package.json`](frontend/package.json) — confirms elkjs is already a direct dependency at the peer-matching version.

---

## Non-Goals

- **Implementing before the library ships.** This plan is blocked on [`typescript-ui/plans/elk-layout-web-worker.md`](../../typescript-ui/plans/elk-layout-web-worker.md) and a `build:lib`. It is not a workaround-around-the-library task; do not add the option or a worker shim to the app.
- **Moving post-layout DOM off the main thread.** Only ELK's position compute moves to the worker. Building and placing the node elements after layout returns stays on the main thread, by the framework's design.
- **Any fallback, pooling, or termination logic in the app.** The library owns worker construction, the transparent main-thread fallback, and the worker lifecycle. The app only supplies the factory.
- **Changing `vite.config.ts` preemptively.** Config is touched only if the implement-time dev-build check shows the worker asset failing to emit.
- **Per-panel opt-out.** All six diagrams get the factory uniformly; there is no small-graph exception.

---

## Notes

[^direct-dep]: The task brief assumed elkjs was only a transitive/hoisted dependency and needed adding. It is not: [`frontend/package.json:21`](frontend/package.json#L21) already lists `"elkjs": "^0.10.0"` (committed; `git show HEAD:frontend/package.json` confirms it), installed at 0.10.2, and the library declares elkjs as an **optional peer** at the same `^0.10.0` ([`typescript-ui/packages/lib/package.json`](../../typescript-ui/packages/lib/package.json) `peerDependencies` + `peerDependenciesMeta.elkjs.optional`). Version alignment matters because the `new URL("elkjs/lib/elk-worker.min.js", …)` specifier resolves against the app's own install; the app and library agreeing on `^0.10.0` means the worker script and the library's `elk.bundled.js` come from a matching elkjs. So the step is a one-line `grep` verification, not a package change.

[^shared-module]: Repeating `() => new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url), { type: "classic" })` inline in six panels would be six chances to drift on the worker type or the specifier. One module is one place to get `type: "classic"` right and one symbol to grep for when auditing that every diagram is worker-backed. `dock/` is the right home because all six consumers live there and the app already keeps shared dock helpers as lowercase single-purpose modules beside the panels ([`glyphButton.ts`](frontend/src/dock/glyphButton.ts), [`exportButton.ts`](frontend/src/dock/exportButton.ts), [`tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts)). Putting it higher (e.g. a top-level `src/` util) would break that locality for a helper only the dock diagrams use.

[^classic]: `elk-worker.min.js` opens as a classic browserify script referencing `module.exports` at top level, with no `import`/`export`. A `{ type: "module" }` worker runs in module scope where top-level `module` is undefined, so it fails to load. elkjs's own `workerUrl` path builds `new Worker(url)` with no `type` (classic) for the same reason. The library plan documents this as the consumer recipe's `type: "classic"` requirement; the app's shared module encodes it once.

[^uniform]: When a factory is set, the library always attempts worker layout and falls back to the main thread on any failure, with negligible worker-construction overhead on small graphs. Explain plans are usually small, so the worker rarely changes their perceived speed — but excluding `ExplainDiagramPanel` would mean one panel constructs `DiagramView` differently from the other five, a divergence a future reader has to explain. Uniform application keeps the rule "every DiagramView gets `elkWorkerFactory`" true, which is also what the step-9 grep enforces.

[^fallback]: Per the library plan's fallback decision, any worker failure — factory throws, `Worker` undefined, CSP block, the bundler never emitting the worker so the URL 404s, or the worker erroring at compute — makes the library rebuild with main-thread `new ELK()` and retry the layout once, rendering the diagram normally. Only a genuinely-absent elkjs reaches the existing empty-view path. The app writes none of this; it is the reason the app can pass the factory unconditionally.

[^no-unit]: The app's vitest runs in the **node** environment and, by explicit design ([`frontend/vitest.config.ts`](frontend/vitest.config.ts) comment), covers only the pure data helpers — "component/DOM behaviour is verified live, not here." The panels import `DiagramView`, whose module touches `document` at import scope, so constructing a panel under node throws. There is therefore no in-harness way to assert "the panel forwards the factory," and the factory itself is a one-line `() => Worker` with no branching to test (calling it under node would just throw on the undefined `Worker`). The wiring is instead pinned by typecheck (the option type must match) and the step-9 grep (every construction site references the symbol); the runtime effect is browser-only.
