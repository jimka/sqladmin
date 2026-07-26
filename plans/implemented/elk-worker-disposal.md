# Diagram Worker Disposal on Tab Close — Implementation Plan

## Overview

Every diagram sqladmin opens builds a `DiagramView`, and since the `elk-worker-adoption` branch each one constructs an ELK Web Worker through [`frontend/src/dock/elkWorkerFactory.ts`](frontend/src/dock/elkWorkerFactory.ts). Nothing in the app ever disposes a diagram panel, so each opened-and-closed diagram tab strands one Worker thread for the life of the page. The typescript-ui library has now grown the release path — `DiagramView` overrides `destructor()` to dispose its layout engine, which terminates the Worker — and this plan makes sqladmin call it.

The fix has two halves. First, the controller's teardown registry gains an entry for every diagram tab: the nine `openAsyncPanel` sites in [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) that return a diagram opt in with one flag, and `openAsyncPanel` itself does the registering. Second, `QueryPanel`'s Explain-diagram slot stops using its no-op disposer ([`frontend/src/dock/QueryPanel.ts:574`](frontend/src/dock/QueryPanel.ts#L574)) and disposes the `ExplainDiagramPanel` for real — that slot leaks one Worker *per Explain-diagram rebuild*, not just per tab.

Along the way the registry itself moves out of the controller into a small pure module so its rules can be unit-tested, and so it holds the panel **object** rather than a detached `dispose` function.[^object-not-function]

**This plan cannot be implemented or verified until the library's disposal path is built into the `dist/lib` sqladmin consumes.** See the ordering gate in [Verification](#verification).

---

## Architecture Decisions

### Disposing the outer panel is enough for both panel shapes

Five panel classes reach the dock as top-level tabs, in two shapes: `SchemaDiagramPanel`, `RelationGraphPanel`, and `RoleGrantsDiagramPanel` **extend** `DiagramView`; `DatabaseDiagramPanel` and `RelationDiagramPanel` **extend `Panel`** and hold a `DiagramView` as a child. **Both shapes need identical handling — call `dispose()` on the object the factory returned, and the Worker is released.**[^recursion] There is no second code path for the wrapper shape.

The same is true of `ExplainDiagramPanel`, which is a `Panel` wrapping a `DiagramView` and never a top-level tab.

### `openAsyncPanel` registers the disposer, not each call site

The nine diagram call sites gain exactly one line each: `disposeOnClose: true` in the spec object. [`openAsyncPanel`](frontend/src/SqlAdminController.ts#L2921) reads that flag and registers the built content itself.[^central-registration] No call site touches the registry, so no call site can get the registration wrong.

### The registry holds panels, and lives in its own module

`_panelDisposers` changes from `Map<string, () => void>` to a `PanelDisposers` instance in a new module, [`frontend/src/dock/panelDisposers.ts`](frontend/src/dock/panelDisposers.ts). It stores the panel object and calls `panel.dispose()` itself.

This is a new pattern relative to the raw `Map` it replaces, and it is introduced for two reasons the `Map` cannot carry: it makes it impossible to register a panel's `dispose` *detached from the panel* — which silently loses `this` for every library `Component`, see [Public API](#public-api) — and it puts the load/close ordering rule somewhere the node test runner can reach.[^why-module] The module's shape follows the codebase's existing "split the pure logic out of a DOM-touching component so vitest can pin it" precedent — [`frontend/src/dock/tableWriteRules.ts:1-5`](frontend/src/dock/tableWriteRules.ts#L1) and [`frontend/src/dock/filterModel.ts:1-3`](frontend/src/dock/filterModel.ts#L1) — including their habit of typing the collaborator as a minimal structural interface rather than importing the real class. A lowercase module exporting a class matches [`frontend/src/data/notesStore.ts`](frontend/src/data/notesStore.ts) and [`frontend/src/data/layoutStore.ts`](frontend/src/data/layoutStore.ts).

### A panel that finishes loading after its tab closed disposes itself

A diagram tab is closeable the moment it appears, while its data is still being fetched. The `"close"` event fires first and finds nothing registered; the build then resolves and constructs a `DiagramView`, which starts its ELK immediately.[^eager-elk] To stop that panel becoming an orphan, each open mints a token; when the build finishes, the registry compares tokens and either registers the panel or disposes it on the spot.

| Sequence for one panel id | What `settle` finds | Outcome |
|---|---|---|
| open → build resolves → close | the token it was given is still current | registered; disposed when the tab closes |
| open → close → build resolves | no token for the id (close cleared it) | disposed immediately inside `settle` |
| open **A** → close → open **B** → B resolves → A resolves | B: current; A: superseded by B's token | B registered; A disposed immediately |

### Disposal hangs off `"close"` only, never `"detach"`

The existing handler at [`SqlAdminController.ts:307`](frontend/src/SqlAdminController.ts#L307) subscribes to the Dock's `"close"` event, which fires only on genuine destruction — a tear-off into a floating window fires `"detach"` and the panel keeps living. That stays exactly as it is; disposal is added to the `"close"` path and nowhere else.

---

## Public API

All app-internal. The new module:

```typescript
// frontend/src/dock/panelDisposers.ts

/** The subset of a panel's API this registry calls on teardown. */
export interface DisposablePanel {
    dispose(): void;
}

export class PanelDisposers {
    register(id: string, panel: DisposablePanel): void;
    beginLoad(id: string): object;
    settle(id: string, token: object, panel: DisposablePanel): void;
    close(id: string): void;
}
```

`DisposablePanel` is satisfied by both panel families already in play: the library's `Component` (a prototype `dispose(): void`) and the app's composition wrappers `QueryPanel` / `DefinitionPanel` / `FunctionDefinitionPanel` / `DocumentationPanel` (a `readonly dispose: () => void` field).

**The registry takes the panel, never `panel.dispose`.** This is the one mistake the surrounding code invites: the four existing registrations pass `panel.dispose` unbound, which is safe *only* because those four panels declare `dispose` as an arrow-function field ([`QueryPanel.ts:150`](frontend/src/dock/QueryPanel.ts#L150), per convention (f) of [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md)). `Component.dispose` is a prototype method, so a detached `panel.dispose` loses `this` and throws — or worse, silently does nothing. Writing `this._panelDisposers.register(id, panel)` removes the choice.

The controller's field and `openAsyncPanel` spec change to:

```typescript
private readonly _panelDisposers: PanelDisposers = new PanelDisposers();

private openAsyncPanel(
    spec: { id: string; title: string; glyph: string; tooltip?: string; ref?: DbObjectRef; disposeOnClose?: boolean },
    build: () => Promise<Component>,
): void
```

---

## Internal Structure

`frontend/src/dock/panelDisposers.ts` in full — the plan's only non-obvious logic:

```typescript
export class PanelDisposers {
    // Panel id -> the panel to dispose when that tab closes.
    private readonly _panels: Map<string, DisposablePanel> = new Map();

    // Panel id -> the token minted for the build currently in flight for that
    // id. An id appears here only between beginLoad and settle/close.
    private readonly _loading: Map<string, object> = new Map();

    /**
     * Record a panel built synchronously, to dispose when its tab closes.
     *
     * @param id - The Dock panel id the panel is mounted under.
     * @param panel - The panel to dispose on close.
     */
    register(id: string, panel: DisposablePanel): void {
        this._panels.set(id, panel);
    }

    /**
     * Open a build window for a panel whose content is fetched asynchronously.
     *
     * @param id - The Dock panel id being opened.
     * @returns The token identifying this open; hand it back to `settle`.
     */
    beginLoad(id: string): object {
        const token = {};

        this._loading.set(id, token);

        return token;
    }

    /**
     * Finish an asynchronous build: register the panel when `token` is still
     * the current open for `id`, otherwise dispose it now — the tab it was
     * built for is gone, either closed or superseded by a newer open of the
     * same id.
     *
     * @param id - The Dock panel id the build was started for.
     * @param token - The token `beginLoad` returned for that build.
     * @param panel - The freshly built panel.
     */
    settle(id: string, token: object, panel: DisposablePanel): void {
        if (this._loading.get(id) !== token) {
            panel.dispose();

            return;
        }

        this._loading.delete(id);
        this.register(id, panel);
    }

    /**
     * A tab closed: dispose its registered panel (if any) and forget the id,
     * including any build still in flight for it.
     *
     * @param id - The closed Dock panel id.
     */
    close(id: string): void {
        const panel = this._panels.get(id);

        // Both entries are dropped before the dispose call, so a close
        // re-entered from teardown finds nothing left to dispose twice.
        this._loading.delete(id);
        this._panels.delete(id);

        panel?.dispose();
    }
}
```

The token-flow half of `openAsyncPanel`:

```typescript
// Identity token for THIS open of spec.id, so a build landing after its tab
// closed (or after the id was reopened) is disposed instead of registered.
const token = spec.disposeOnClose ? this._panelDisposers.beginLoad(spec.id) : null;

// ...inside the existing `content: async () => { try { ... } }`:
const content = await build();

if (token) {
    this._panelDisposers.settle(spec.id, token, content);
}

return content;
```

---

## Ordered Implementation Steps

1. **Library gate — do this first.** The disposal path is merged into typescript-ui's `master`, and the app's symlink already points at that checkout. Confirm the built bundle carries it:
   ```bash
   readlink -e frontend/node_modules/@jimka/typescript-ui
   # expect: /home/jika/typescript/typescript-ui/packages/lib
   grep -rl "ElkLayoutEngine has been disposed" frontend/node_modules/@jimka/typescript-ui/dist/lib/
   ```
   Expect the path above and at least one grep hit (`component/diagram.es.js`). If the symlink resolves somewhere else — in particular to anything under `.worktrees/`, which no longer exists — repoint it with `ln -sfn /home/jika/typescript/typescript-ui/packages/lib frontend/node_modules/@jimka/typescript-ui`. If the grep finds nothing, run `npm run build:lib` in that checkout — **not** `npm run build`. Without this the code below still typechecks and runs, but disposal reclaims no Worker and the manual checks all fail.

2. **Write the test first** — `frontend/tests/dock/panelDisposers.test.ts`, covering behaviours 1–8 in [Expected Behaviour](#expected-behaviour). Model the file on [`frontend/tests/dock/tableWriteRules.test.ts`](frontend/tests/dock/tableWriteRules.test.ts): plain `vitest` imports and hand-rolled stand-ins. Behaviour 8 needs a stand-in whose `dispose` is a **prototype method** reading `this`, not an arrow field. `npm test` fails here (the module does not exist yet) — that is the red step.

3. **Create `frontend/src/dock/panelDisposers.ts`** exactly as in [Internal Structure](#internal-structure), with a file header comment saying why it is split out (DOM-free so the node test runner can reach it) and that it holds panels rather than `dispose` references.
   - Check: `cd frontend && npm test` — the new test file passes.

4. **Rewire the controller's registry** in `frontend/src/SqlAdminController.ts`:
   - Import `PanelDisposers` from `./dock/panelDisposers`.
   - Change the field at [L209](frontend/src/SqlAdminController.ts#L209) to `private readonly _panelDisposers: PanelDisposers = new PanelDisposers();` and update the comment above it (L205–208) to say the registry now covers diagram panels too, and that it takes the panel object.
   - In the `"close"` handler, replace the two lines at [L311–312](frontend/src/SqlAdminController.ts#L311) with `this._panelDisposers.close(e.id);`.
   - Replace all four `this._panelDisposers.set(id, panel.dispose);` calls — [L561](frontend/src/SqlAdminController.ts#L561), [L1239](frontend/src/SqlAdminController.ts#L1239), [L1470](frontend/src/SqlAdminController.ts#L1470), [L2133](frontend/src/SqlAdminController.ts#L2133) — with `this._panelDisposers.register(id, panel);`. Note `panel` here is the wrapper (`DefinitionPanel`, `FunctionDefinitionPanel`, `DocumentationPanel`, `QueryPanel`), not `panel.content` — do not change which object is registered.
   - Check: `grep -n '_panelDisposers\.' frontend/src/SqlAdminController.ts` — five hits at this point (one `close`, four `register`), and no `.set(` / `.get(` / `.delete(`. Step 5 adds two more.

5. **Add the token flow to `openAsyncPanel`** ([L2921](frontend/src/SqlAdminController.ts#L2921)): add `disposeOnClose?: boolean` to the `spec` parameter type, and add the token/settle code from [Internal Structure](#internal-structure). `settle` runs after `await build()` and before `return content`, inside the existing `try`. Leave the `catch` untouched — a rejected build closes the tab, and the `"close"` handler clears the pending token. Extend the method's JSDoc with one sentence on `disposeOnClose`.

6. **Flag the nine diagram specs** in `frontend/src/SqlAdminController.ts` — add `disposeOnClose: true,` to each spec object literal, and nothing else:

   | Method | Spec at | Panel it returns |
   |---|---|---|
   | `openSchemaDiagram` | [L1492](frontend/src/SqlAdminController.ts#L1492) | `SchemaDiagramPanel` |
   | `openDatabaseDiagram` | [L1579](frontend/src/SqlAdminController.ts#L1579) | `DatabaseDiagramPanel` |
   | `openRelationDiagram` | [L1661](frontend/src/SqlAdminController.ts#L1661) | `RelationDiagramPanel` |
   | `openSchemaDependencyGraph` | [L1761](frontend/src/SqlAdminController.ts#L1761) | `RelationGraphPanel` |
   | `openRelationDependencyGraph` | [L1814](frontend/src/SqlAdminController.ts#L1814) | `RelationGraphPanel` |
   | `openSchemaInheritanceGraph` | [L1875](frontend/src/SqlAdminController.ts#L1875) | `RelationGraphPanel` |
   | `openRelationInheritanceGraph` | [L1929](frontend/src/SqlAdminController.ts#L1929) | `RelationGraphPanel` |
   | `openRoleMembershipDiagram` | [L2659](frontend/src/SqlAdminController.ts#L2659) | `RelationDiagramPanel` |
   | `openRoleGrantsDiagram` | [L2692](frontend/src/SqlAdminController.ts#L2692) | `RoleGrantsDiagramPanel` |

   - Check: `grep -c 'disposeOnClose: true' frontend/src/SqlAdminController.ts` — exactly `9`.
   - Check: the non-diagram `openAsyncPanel` sites (L424, L484, L601, L652, L1184, L2625) are **not** flagged — they return no `DiagramView`, and two of them already register their own wrapper.

7. **Fix `QueryPanel`'s diagram slot** in `frontend/src/dock/QueryPanel.ts`:
   - At [L574](frontend/src/dock/QueryPanel.ts#L574), change `diagramSlot = { content: nextDiagram, dispose: () => {} };` to `diagramSlot = { content: nextDiagram, dispose: () => nextDiagram.dispose() };`. **Not** `dispose: nextDiagram.dispose` — `ExplainDiagramPanel` extends `Panel`, so its `dispose` is a prototype method and a detached reference loses `this`.
   - Replace the stale comment at [L170–176](frontend/src/dock/QueryPanel.ts#L170) with one saying the disposer releases the panel's `DiagramView` and its ELK Worker, so re-running Explain no longer strands one per rebuild.
   - Leave [`removeDiagramTab`](frontend/src/dock/QueryPanel.ts#L315), the [`"tabclose"` branch](frontend/src/dock/QueryPanel.ts#L429), and [`this.dispose`](frontend/src/dock/QueryPanel.ts#L978) unchanged — all three already null the slot after calling it, and `Component.dispose()` is idempotent regardless.

8. **Update `ExplainDiagramPanel`'s header comment** — [`frontend/src/dock/ExplainDiagramPanel.ts:28-33`](frontend/src/dock/ExplainDiagramPanel.ts#L28) claims the slot's disposer is a no-op because the library cannot reclaim the Worker. Replace those lines with a statement that `QueryPanel`'s diagram slot now disposes this panel, which cascades to the child `DiagramView` and terminates its Worker.
   - Check: `grep -rn 'no-op' frontend/src/dock/ExplainDiagramPanel.ts frontend/src/dock/QueryPanel.ts` — no hit that still describes the diagram disposer as a no-op.

9. **Update `TODO.md`:**
   - Delete the whole "Every diagram now leaks a Worker thread…" bullet (lines 55–80) — this plan closes it.
   - Extend the `"@jimka/typescript-ui": "^0.2.0"` bullet (lines 46–54): the range now also fails to admit `DiagramView`'s `destructor()` override / `ElkLayoutEngine.dispose()`. Both that work and `elkWorkerFactory` are merged to typescript-ui's `master` but still unpublished, so the app resolves them only through the local symlink to that checkout; `npm ci` against the registry still fails until a release ships.

10. **Update `frontend/COMPONENT_CONVENTIONS.md`:** in section (f), change "one `_panelDisposers` map" to "one `_panelDisposers` registry"; in section (c), add one sentence noting that the controller's registry takes the panel object and calls `dispose()` itself, so registering a diagram panel cannot lose `this`.

11. **Grep invariants:**
    - `grep -rn '\.dispose[,)]' frontend/src/` — **exactly two hits, both in `QueryPanel.ts`** (L755, L786), where `dispose` is read off a `QueryResultGrid` / `QueryResultChart` that declares it as an arrow field. Any third hit is a detached prototype method and is the bug this plan exists to avoid.
    - `grep -rn 'elkWorkerFactory' frontend/src/dock/*.ts` — still the same six panels plus the factory module; this plan adds no new `DiagramView` construction.

12. **Typecheck and test:** `cd frontend && npm run typecheck && npm test`, both clean. In a worktree, symlink `frontend/node_modules` to the main tree first.

13. **Manual verification** — run the procedure in [Verification](#verification). It is the only thing that proves a Worker was actually reclaimed.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/panelDisposers.ts` |
| Create | `frontend/tests/dock/panelDisposers.test.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/src/dock/ExplainDiagramPanel.ts` |
| Modify | `frontend/COMPONENT_CONVENTIONS.md` |
| Modify | `TODO.md` |

The five diagram panel classes (`SchemaDiagramPanel`, `RelationGraphPanel`, `RoleGrantsDiagramPanel`, `DatabaseDiagramPanel`, `RelationDiagramPanel`) are **not** modified — they already inherit everything they need. `frontend/package.json` is not modified (see [Non-Goals](#non-goals)). `CHANGELOG.md` is not modified; it is written at release time, and the `elk-worker-adoption` plan set that precedent.

---

## Expected Behaviour

### Unit-testable — `frontend/tests/dock/panelDisposers.test.ts`

Each case uses a stand-in panel that records its `dispose()` calls.

1. **Register then close disposes once.** `register("a", panel)`, `close("a")` → `panel` disposed exactly once.
2. **Close is idempotent.** A second `close("a")` disposes nothing further.
3. **Closing an unknown id is a no-op.** `close("nope")` neither throws nor disposes anything.
4. **A registered panel is not disposed before its close.** After `register("a", panel)` alone, `panel` has not been disposed.
5. **A build that lands while its tab is open is registered, not disposed.** `t = beginLoad("a")`, `settle("a", t, panel)` → not yet disposed; then `close("a")` → disposed once.
6. **A build that lands after its tab closed disposes itself.** `t = beginLoad("a")`, `close("a")`, `settle("a", t, panel)` → `panel` disposed immediately; a following `close("a")` disposes nothing more.
7. **A superseded build disposes itself and leaves the newer one registered.** `t1 = beginLoad("a")`, `close("a")`, `t2 = beginLoad("a")`, `settle("a", t2, b)`, `settle("a", t1, a)` → `a` disposed immediately, `b` not yet; then `close("a")` → `b` disposed.
8. **`this` survives registration.** The stand-in for this case declares `dispose()` as a **prototype method** that increments `this.calls`. `register` + `close` must increment it — a registry that stored `panel.dispose` and called it detached would throw on the `this` access. This is the automated guard against the unbound-`dispose` mistake.

### Manual verification only

The panels are constructed inside async dock factory callbacks, and every one of them imports library modules that touch `document` at import scope; the project's vitest runs in the **node** environment and covers pure helpers only, by explicit design ([`frontend/vitest.config.ts`](frontend/vitest.config.ts)). No existing test constructs `SqlAdminController` or drives the Dock, and none can. So everything below is browser-only:

9. **One Worker per diagram tab, released on close.** Opening a schema diagram creates exactly one ELK Worker; closing the tab terminates it. Repeating open/close N times leaves zero live Workers.
10. **The wrapper shape releases too.** The same holds for a database diagram (`DatabaseDiagramPanel` — a `Panel` holding the `DiagramView`), proving the recursion through `Component.destructor()`.
11. **The Explain diagram releases per rebuild.** In a query tab: opening the Explain diagram creates one Worker; opening it again (a rebuild) terminates the previous one and creates one more; closing the Diagram tab terminates the current one; closing the query tab leaves none behind.
12. **Close-during-load leaves nothing behind.** Opening a large schema diagram and closing its tab while the spinner is still up ends with as many Workers terminated as were created.
13. **Diagrams still work.** Opening each diagram type renders as before — this change adds teardown only, and must not disturb layout, selection, or the context menu.

---

## Verification

**Ordering gate:** step 1 above. Nothing below means anything until `frontend/node_modules/@jimka/typescript-ui` resolves to a build containing `DiagramView.destructor()`.

- **Typecheck:** `cd frontend && npm run typecheck` clean.
- **Tests:** `cd frontend && npm test` — the new `panelDisposers` suite green, every existing suite still green.
- **Greps:** the two invariants in step 11, plus the `disposeOnClose: true` count of 9.

### Manual procedure (chrome-devtools, per `.claude/skills/verify/SKILL.md`)

Bring the stack up (`docker compose up -d db`, backend on :8000, `npm run dev` on :5173) and log in with **Host `sqladmin-db`**, database/user/password `sqladmin`.

**Before opening any diagram**, install a Worker counter via `evaluate_script`. It counts only ELK workers, so unrelated workers cannot skew the numbers:

```js
(() => {
  const Base = window.Worker;
  const elk  = new WeakSet();

  window.__elkWorkers = { made: 0, killed: 0 };

  const terminate = Base.prototype.terminate;

  Base.prototype.terminate = function () {
    if (elk.has(this)) { window.__elkWorkers.killed++; }
    return terminate.call(this);
  };

  window.Worker = class extends Base {
    constructor(url, ...rest) {
      super(url, ...rest);
      if (String(url).includes("elk-worker")) { elk.add(this); window.__elkWorkers.made++; }
    }
  };

  return "installed";
})()
```

Read the counter after each step with `evaluate_script` returning `window.__elkWorkers`. Diagrams open from a navigator node's right-click menu, which needs the dispatched pointer sequence the verify skill describes.

| # | Action | Expected `{ made, killed }` |
|---|---|---|
| 1 | Open a schema diagram, wait for nodes to render | `{ 1, 0 }` |
| 2 | Close that tab | `{ 1, 1 }` |
| 3 | Repeat open + close twice more | `{ 3, 3 }` |
| 4 | Open a **database** diagram, wait, close it | `{ 4, 4 }` |
| 5 | New Query → run `EXPLAIN`-able SQL → Explain → "Explain diagram" | `{ 5, 4 }` |
| 6 | Click "Explain diagram" again (rebuild) | `{ 6, 5 }` |
| 7 | Close the Diagram tab | `{ 6, 6 }` |
| 8 | Open a large schema diagram and close the tab while the spinner is still showing; wait ~20 s | `made === killed` |

Row 8 is asserted as an equality rather than a fixed pair because a panel disposed before its ELK finished constructing may never create a Worker at all — the library terminates a late-arriving instance in that case, so the two counters converge either way.[^late-elk]

Finish by confirming the console is clean (the `favicon.ico` 404 is pre-existing) and that each diagram type still renders — behaviour 13.

---

## Potential Challenges

- **The symlink must resolve to a build that has the disposal path.** If it points anywhere whose `DiagramView` lacks the `destructor()` override, `dispose()` frees DOM and theme subscriptions but no Worker — and every manual check fails with no compile error to explain why. This already bit once, when the symlink pointed at a since-deleted `.worktrees/elk-layout-web-worker`. Mitigation: step 1 checks the target and greps the built bundle for proof.
- **Double disposal.** A panel can be disposed by `PanelDisposers.close` and again by a slot's own teardown. Both `Component.dispose()` and `ElkLayoutEngine.dispose()` document themselves as idempotent, and `close` drops its map entries before calling. Mitigation: none needed beyond keeping the existing null-after-dispose lines in `QueryPanel` intact (step 7).
- **Registering the wrong object at the four existing sites.** Those factories return `panel.content`, but the object with the teardown is `panel`. Mitigation: step 4 spells out which one to pass; the typechecker will not catch a mix-up because `Container` also satisfies `DisposablePanel`.
- **Flagging a non-diagram `openAsyncPanel` site.** `disposeOnClose: true` on the definition-panel sites would register `panel.content` *and* `panel`, and the later registration wins — silently dropping the CodeEditor teardown. Mitigation: step 6 lists the nine sites and names the six that must stay unflagged.
- **A tear-off must not dispose.** Adding disposal to the Dock's `"detach"` event would destroy a panel the user just floated. Mitigation: only the existing `"close"` handler is touched.

---

## Critical Files

- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — the registry field (L205–209), the `"close"` handler (L304–313), `openAsyncPanel` (L2921), the four existing registrations, and the nine diagram specs.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) — the slot model and its double-dispose guards (L167–182, L275–321, L417–435, L972–980), and the `readonly dispose` arrow field (L150) that makes the *existing* unbound registrations safe.
- [`frontend/src/dock/ExplainDiagramPanel.ts`](frontend/src/dock/ExplainDiagramPanel.ts) — the `Panel`-wrapping-`DiagramView` shape and the header comment to correct.
- [`frontend/src/dock/tableWriteRules.ts`](frontend/src/dock/tableWriteRules.ts) and [`frontend/tests/dock/tableWriteRules.test.ts`](frontend/tests/dock/tableWriteRules.test.ts) — the precedent the new module and its test follow: DOM-free logic split out of a component, collaborators typed as minimal structural interfaces.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — section (c) on why a by-reference handler must be an arrow field, and section (f) on the composition wrappers whose `dispose` already is one.
- `../../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L291` — the `destructor()` override this plan consumes.
- `../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L715` — `dispose()` / `destructor()` (L732), and the child recursion at L749 that makes the wrapper shape work.

---

## Non-Goals

- **Bumping `"@jimka/typescript-ui": "^0.2.0"`.** No published version admits either API: the registry lists only `0.1.0`, `0.1.1`, `0.2.0`, and both `elkWorkerFactory` and the disposal path live on unmerged, unpublished library branches. There is nothing to bump *to*. The range bump and lockfile regeneration wait for the library's release and stay tracked in `TODO.md`, whose existing bullet step 9 extends to name the disposal API too.
- **Disposing non-diagram async panels.** Structure, data, sequence, and grants tabs hold no Worker, and blanket-registering `openAsyncPanel` content would collide with the definition panels' own registrations. They keep their current lifecycle.
- **Anything library-side.** Worker construction, the main-thread fallback, and termination all belong to typescript-ui. The app only calls `dispose()`.
- **Sharing or pooling one Worker across diagrams.** One `DiagramView`, one Worker, released on close — the model this plan implements.
- **Changing any panel's class shape.** The `extends DiagramView` / `extends Panel` split stays as it is; both dispose identically.
- **Closing the stranded-component leak beyond diagrams.** Non-diagram panels that leak theme subscriptions today keep doing so; that is a separate backlog item.

---

## Notes

[^object-not-function]: Keeping a `Map<string, () => void>` would have worked for the four panels already in it, because each declares `dispose` as a `readonly` arrow-function field, which stays bound when read off the instance. It does not work for diagram panels: `Component.dispose` is a prototype method, so `map.set(id, panel.dispose)` stores a function whose `this` is `undefined` at call time. Under the module's strict-mode semantics that throws inside `destructor()` on the first `this` access, inside the Dock's `"close"` handler — a broken teardown reported as an unrelated error, or swallowed. Since the mistake is invisible at the call site and the surrounding four lines model it, the fix is to remove the option: the registry stores the object and performs the call.

[^recursion]: `Component.destructor()` iterates `this._components` and calls `child.destructor()` on each before releasing its own resources (`core/Component.ts:748-750`), and every child added through the `components:` option or `addComponent` lands in that array (`addComponent` → `insertComponent` at `core/Component.ts:4817`). `DatabaseDiagramPanel` and `RelationDiagramPanel` both pass their `DiagramView` in the `super({ components: [...] })` bag, so it is a direct child; `ExplainDiagramPanel` does the same. `DiagramView.destructor()` bumps its layout generation, calls `this._engine.dispose()`, then `super.destructor()` — and `ElkLayoutEngine.dispose()` calls elkjs's `terminateWorker()`, which reaches the real `Worker.terminate()` through elkjs's `PromisedWorker`. So one `dispose()` on the outer panel terminates the Worker for every shape.

[^central-registration]: The alternative was a per-site `return this.someHelper(id, SchemaDiagramPanel(...))` wrapper at all nine `return` statements. That is nine chances to forget the wrapper on a tenth diagram added later, and nine places where an implementer could reach for the registry directly and reintroduce the unbound form. Putting the registration in `openAsyncPanel` means the only per-site artefact is a boolean whose absence is visible in a `grep -c`, and the close-during-load token never has to be threaded out to a call site — it is a local in `openAsyncPanel`'s own closure.

[^why-module]: The controller cannot be imported under the project's test runner at all: `vitest.config.ts` sets `environment: "node"` and states that component/DOM behaviour is verified live, and `SqlAdminController.ts`'s transitive imports touch `document` at module scope. Leaving the load/close ordering rule inline in the controller would make it permanently untestable, and it is the one part of this change with real branching. Extracting it is also what the codebase already does for exactly this reason — `tableWriteRules.ts`'s header names the constraint explicitly — so this is following an established split, not inventing one.

[^eager-elk]: `DiagramView`'s constructor calls `setData`, which calls `relayout`, which calls `this._engine.layout(...)` straight away — a diagram starts building its ELK (and therefore its Worker) at construction, whether or not it is ever mounted. The Dock's lazy panel activates immediately on `addLazyPanel`, so the build factory runs at once and the exposed window is the length of the data fetch: on a large schema that is seconds, and the tab is closeable throughout. `Dock.onPanelClosed` emits `"close"` and evicts the frame, then the resolved content is dropped on the floor — so without the token check the panel would exist, hold a Worker, and be referenced by nothing.

[^late-elk]: `ElkLayoutEngine.dispose()` sets a `_disposed` flag and terminates whatever instance exists. When disposal lands while ELK is still being imported and constructed, the construction path re-checks the flag on completion and terminates the instance it just built, so no Worker outlives the disposed engine. That is why row 8's assertion is `made === killed` rather than a fixed pair: whether the Worker gets created at all depends on how far construction had progressed.

---

## Implementation Notes

- **The nine diagram spec blocks were re-aligned, not only extended.** Step 6
  says to add `disposeOnClose: true,` "and nothing else", but the repo aligns
  object-literal colons to the longest key, and `disposeOnClose` is longer than
  every key already in those blocks. Adding it without re-padding would have
  left each block half-aligned. All nine blocks are therefore padded to the new
  width; no key, value, or ordering changed. (An audit round on the sibling
  `elk-worker-adoption` branch raised exactly this kind of alignment drift as a
  finding, which is why the wider diff was preferred over the literal reading.)
- **A ninth unit test was added beyond the plan's eight behaviours.** Behaviour
  8 pins that `this` survives `register` + `close`; the added case pins the same
  for the *other* path that calls `dispose`, the immediate disposal inside
  `settle` when a build lands after its tab closed. Both paths call the panel,
  and only one of them was covered.
- **The plan's Non-Goals section is stale on one point of fact.** It says both
  `elkWorkerFactory` and the disposal path "live on unmerged, unpublished
  library branches". They were merged to typescript-ui's `master` before this
  branch was implemented — still unpublished, so the conclusion (nothing to
  bump the `^0.2.0` range to) is unchanged and the Non-Goal stands. Step 9's
  `TODO.md` wording was written to the merged-but-unpublished state.
- **Behaviours 9–13 are browser-only and were verified manually**, per the
  plan's [Verification](#verification) procedure — the project's vitest runs in
  the node environment by design and cannot construct a panel. See the
  verification record below.

### Manual verification record

Driven live via `chrome-devtools` against `npm run dev` served from this
worktree, with the plan's ELK-only `window.Worker` counter installed before
login. Backend run on the host, so the login Host was `localhost` (the verify
skill's `sqladmin-db` is the compose-network name and does not resolve from a
host-run backend). Every row of the plan's [Verification](#verification) table
matched its expected `{ made, killed }` exactly:

| # | Action | Expected | Observed |
|---|---|---|---|
| 1 | Open `hub` schema diagram (154 tables) | `{1,0}` | `{1,0}`, 154 nodes |
| 2 | Close that tab | `{1,1}` | `{1,1}` |
| 3 | Two more open+close cycles | `{3,3}` | `{3,3}` |
| 4 | Database diagram (wrapper shape) open+close | `{4,4}` | `{4,4}`, 6 nodes |
| 5 | Query → Explain → Explain diagram | `{5,4}` | `{5,4}` |
| 6 | Explain diagram again (rebuild) | `{6,5}` | `{6,5}` |
| 7 | Close the Diagram tab | `{6,6}` | `{6,6}` |
| 8 | Close during load, then wait | `made === killed` | `{9,9}` |

Row 4 is the evidence for behaviour 10 — `DatabaseDiagramPanel` is a `Panel`
holding the `DiagramView`, so its release proves the `Component.destructor()`
child recursion. Row 8 needed care to be meaningful: a first attempt closed the
tab 250 ms after the menu click, by which point the build had already resolved
(the status line had updated), so it exercised the ordinary register-then-close
path rather than the race. Re-run by polling for the close button and clicking
it the moment it existed — 20 ms in, with the counter still at its pre-open
value and no node rendered — the build resolved afterwards, and its Worker was
created **and** terminated: the `settle`-with-a-stale-token path, in the real
app. Behaviour 13 additionally checked the dependency graph (313 nodes) and
inheritance graph, both balancing to `made === killed` on close.

**One defect found, library-side and recorded in [`TODO.md`](TODO.md) rather
than fixed here** (the plan's [Non-Goals](#non-goals) reserve library changes):
closing a diagram tab *while its entry animation is still running* logs one
uncaught `DOM handle N is not registered`. The stack is entirely inside the
library — `applyTransitionAndTo` → `InlineStyle.set` → `writeStyle` →
`HandleRegistry.resolve` — a transition callback writing through a handle
`Component.destructor()` has already released. It is a genuine regression in
console cleanliness surfaced by this change (nothing disposed a diagram
before), but not a functional one: the Worker is terminated in every case, the
counters balance, and it does not fire when the diagram is allowed to settle
first (0 errors) or when a `QueryPanel` is disposed (0 errors, the pre-existing
disposal path). Reproduced twice.
