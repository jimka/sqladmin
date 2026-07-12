---
touches-shared: [frontend/src/SqlAdminController.ts]
---

# Class-First Lifecycle Panels — Implementation Plan

## Overview

Four Dock-panel builder modules still ship as **capitalized factory functions that return a hand-rolled lifecycle handle** — the exact builder-first shape `frontend/COMPONENT_CONVENTIONS.md` is migrating away from:

- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts#L140) → `{ content: Container; dispose: () => void }`
- [`frontend/src/dock/DefinitionPanel.ts`](frontend/src/dock/DefinitionPanel.ts#L18) → `{ content: Container; dispose: () => void }`
- [`frontend/src/dock/QueryResultView.ts`](frontend/src/dock/QueryResultView.ts#L53) → two exports `QueryResultGrid` / `QueryResultChart`, each `{ content: Component; dispose: () => void }`
- [`frontend/src/dock/DocumentationPanel.ts`](frontend/src/dock/DocumentationPanel.ts#L23) → `{ component: Container; editor: MarkdownEditor }` (no `dispose` — the caller disposes `editor` by hand)

They are consumed in exactly two places (verified by grep — no other importers, no test importers): the controller [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) mounts `QueryPanel`/`DefinitionPanel`/`DocumentationPanel` as Dock tabs and drives their teardown from the Dock `"close"` event; `QueryPanel` itself constructs `QueryResultGrid`/`QueryResultChart` as its own tab bodies.

This plan converts all four modules from factory functions to **classes**, uniformly using the **composition-wrapper** shape (a class that owns a `content` field and exposes a `dispose()`), and rewires the controller's construction + disposal call sites. `SqlAdminController.ts` is a **shared file** also edited by the sibling `class-first-*` plans — see `touches-shared`.

---

## Architecture Decisions

### Decision — Option (b): composition wrapper, applied uniformly

Each of the four modules becomes a **class that owns a `content` (`Container`/`Component`) field and exposes a `dispose` arrow-function field** — *not* a class that `extends` a library base. The consumer keeps the instance and mounts `instance.content`, calling `instance.dispose()` on teardown. This is the "instance owns the content" composition shape, i.e. option (b), applied uniformly to all four.

**One-line reason:** `QueryPanel` (an 835-line factory with ~25 interdependent inner closures and ~9 mutable `let` locals) cannot become `extends Container` without mechanically hoisting every closure to a method and every local to a field under the super-cascade ordering constraint — a wholesale, high-risk rewrite disproportionate to a dispose-shape cleanup — so the composition fallback genuinely applies here, and uniform composition keeps the four siblings and the controller's single disposal path consistent.

### Why not option (a) — `extends` + public `dispose()`

Option (a) *is* the conventions doc's preferred end state ("the instance IS the component", section (d)), and the Dock provably can hold an instance as tab content (`new TableWorkPanel(...)` is passed straight to `content` at [`SqlAdminController.ts:320`](frontend/src/SqlAdminController.ts#L320)) and reach `dispose` (the controller already keys an id→disposer map, `_panelDisposers`). So (a) is *viable* for the three trivial modules (`DefinitionPanel`, `DocumentationPanel`, `QueryResultGrid`). It is rejected only because:
1. `QueryPanel` forces (b) (above), and the set must be uniform — all four flow through one `_panelDisposers` disposal path in the controller and two share `QueryPanel`'s slot logic; mixing `extends` for some and composition for others buys nothing and fragments the pattern.
2. Under (b), `QueryPanel`'s entire factory body is preserved **verbatim** inside the constructor, ending with two field assignments — near-zero churn — whereas (a) would rewrite ~350 lines of `x` → `this.x`.

### `dispose` is an arrow-function field, not a method

On every wrapper class, `dispose` is a **`readonly` arrow-function field** (`readonly dispose = (): void => { … }` or assigned in the constructor). Two consumers store it **by reference** and invoke it later — the controller does `this._panelDisposers.set(id, panel.dispose)`, and `QueryPanel`'s slots keep `{ …, dispose: nextData.dispose, … }`. A plain method would drop its binding when detached; an arrow field captures the constructor's locals permanently (mirroring COMPONENT_CONVENTIONS section (c)). The `dispose` closures reference only captured locals (`editor`, `chart`, `dataSlot`…), never `this`, so no other state needs hoisting.

### DocumentationPanel differs: it gains `dispose()` and drops the `editor` accessor

`DocumentationPanel` is the odd one out — today it exposes `editor` and has **no** `dispose`, and the controller holds that editor in `_notesEditor` purely to call `editor.dispose()` on close. Grep confirms `_notesEditor` is used for *nothing else*. So the conversion folds the editor teardown **into** `DocumentationPanel.dispose()` and stops exposing `editor`. The controller then registers the notes panel through the same uniform `_panelDisposers` path as the others, letting us delete the `_notesEditor` field, its `MarkdownEditor` type import, and the notes-specific branch in the Dock `"close"` handler. (The briefing's "extra editor accessor" is unnecessary once the only consumer — the dispose call — is internalized.) Also rename its owned field `component` → `content` for uniformity with the other three.

### Conventions-doc gap (surfaced, not silently violated)

`frontend/COMPONENT_CONVENTIONS.md` documents only the `extends` form (sections (a)–(e)); it has **no** written "composition fallback" note despite the briefing referencing one. This plan deliberately uses an undocumented composition shape. See `## Documentation Impact` — the doc should gain a section describing when composition substitutes for `extends`.

---

## Public API

All four keep their current export *names* and constructor/parameter shapes; only the call form changes from `Foo(args)` to `new Foo(args)` and the return handle becomes the instance.

```ts
// DefinitionPanel.ts
export class DefinitionPanel {
    readonly content: Container;          // Fit host wrapping the read-only CodeEditor
    readonly dispose: () => void;         // disposes the CodeEditor
    constructor(definition: string);
}
```

```ts
// DocumentationPanel.ts  (field renamed component → content; editor no longer exposed)
export class DocumentationPanel {
    readonly content: Container;          // Fit host wrapping the MarkdownEditor
    readonly dispose: () => void;         // disposes the MarkdownEditor
    constructor(initial: string, onChange: (markdown: string) => void);
}
```

```ts
// QueryResultView.ts
export class QueryResultGrid {
    readonly content: Component;          // the read-only results Table
    readonly dispose: () => void;         // no-op — MemoryStore needs no teardown
    constructor(result: QueryRowsResult);
}
export class QueryResultChart {
    readonly content: Container;          // config strip over the chart host
    readonly dispose: () => void;         // disposes the live chart instance
    constructor(result: QueryRowsResult); // caller must guarantee isChartable(result)
}
```

```ts
// QueryPanel.ts  (QueryPanelOptions, Notify, RunQuery, ExportTable exports unchanged)
export class QueryPanel {
    readonly content: Container;          // the BorderLayout panel (toolbar over body)
    readonly dispose: () => void;         // disposes data/chart/explain slot views + main editor
    constructor(options: QueryPanelOptions);
}
```

---

## Internal Structure

### The mechanical wrap (all four)

Each factory body is preserved and moved into the constructor. What was `return { content: X, dispose: Y }` becomes, at the end of the constructor, `this.content = X;` and `this.dispose = Y;` (with `content`/`dispose` declared as `readonly` fields). No inner closure or local is hoisted to a field — they remain captured by the `dispose` arrow.

For the two trivial panels the body is a couple of lines:

```ts
// DefinitionPanel — after
constructor(definition: string) {
    const editor = new CodeEditor(definition, { language: "sql", readOnly: true });
    this.content = Container({ layoutManager: new Fit(), components: [editor] });
    this.dispose = () => editor.dispose();
}
```

```ts
// QueryResultGrid — after
constructor(result: QueryRowsResult) {
    const store = new MemoryStore({ model: buildQueryModel(result.columns), data: result.rows, autoLoad: true });
    this.content = Table(store, { columns: [], rowReadOnly: () => true });
    this.dispose = () => {};   // MemoryStore needs no teardown
}
```

`QueryResultChart` and `QueryPanel` keep their long bodies (`buildStrip`/`rebuildChart`/`buildChart`; and `run`/`showResult`/`showChart`/`showPlan`/the `Event.addSubtreeListener` keydown handler/etc.) exactly as-is inside the constructor, ending with the two field assignments. `QueryPanel`'s `dispose` field is:

```ts
this.dispose = () => {
    dataSlot?.dispose();
    chartSlot?.dispose();
    explainSlot?.editor.dispose();
    editor.dispose();
};
```

### QueryPanel's Ctrl+E / Ctrl+Shift+E accelerators and run/save handlers stay closures

The editor accelerators — the `Event.addSubtreeListener(editor, "keydown", …)` handler (Ctrl/Cmd+Enter run, Ctrl/Cmd+S save, `isExplainChord` / `isExplainAnalyzeChord` Explain, Alt+C clear, Ctrl+↑/↓ recall) — and the toolbar button click handlers (`() => void run()`, `() => save()`, `() => showChart()`, …) remain **local closures inside the constructor** capturing local functions (`run`, `save`, `runExplainRun`). They are *not* registered by reference off `this` and never touch `this`, so they need **no** arrow-field conversion and carry no binding risk under (b). (This is the payoff of composition: the section-(c) arrow-field discipline that (a) would force across dozens of handlers is moot here.)

---

## Ordered Implementation Steps

1. **`frontend/src/dock/DefinitionPanel.ts`** — change `export function DefinitionPanel(definition: string): { content: Container; dispose: () => void }` to `export class DefinitionPanel`. Add `readonly content: Container;` and `readonly dispose: () => void;`; move the two-line body into `constructor(definition: string)`, assigning `this.content` / `this.dispose` as in Internal Structure. Update the leading file comment to say "class-first composition wrapper" instead of factory.

2. **`frontend/src/dock/QueryResultView.ts`** — convert both exports:
   - `QueryResultGrid` → `export class QueryResultGrid` with `readonly content: Component;` + `readonly dispose: () => void;` (`() => {}`), body in constructor.
   - `QueryResultChart` → `export class QueryResultChart` with `readonly content: Container;` + `readonly dispose: () => void;`. Move the whole body (including nested `buildStrip`/`rebuildChart`/`buildChart`) into the constructor unchanged; end with `this.content = content; this.dispose = () => { chart.dispose(); };`. Keep the `isChartable` precondition note in the docblock.

3. **`frontend/src/dock/DocumentationPanel.ts`** — `export class DocumentationPanel` with `readonly content: Container;` + `readonly dispose: () => void;`. Constructor `(initial, onChange)`: build the `MarkdownEditor`, wire `editor.on("change", …)`, set `this.content = Container({ layoutManager: new Fit(), components: [editor] })`, `this.dispose = () => editor.dispose()`. **Do not** expose `editor`. Rename the owned field from `component` to `content`. Update the docblock (drop the "caller keeps the editor reference to dispose it" note; state dispose now owns editor teardown).

4. **`frontend/src/dock/QueryPanel.ts`** — `export class QueryPanel` with `readonly content: Container;` + `readonly dispose: () => void;`. Move the entire factory body into `constructor(options: QueryPanelOptions)` verbatim. Replace the trailing `return { content: panel, dispose: () => {…} }` with `this.content = panel;` and `this.dispose = () => {…}` (same closure body). Inside `showRowsResult` change `QueryResultGrid(result)` → `new QueryResultGrid(result)`; inside `showChart` change `QueryResultChart(result)` → `new QueryResultChart(result)` (the surrounding slot objects `{ content: next.content, dispose: next.dispose, result }` stay unchanged — `next.dispose` is an arrow field, safe to store by reference). Keep `QueryPanelOptions`/`Notify`/`RunQuery`/`ExportTable` exports. Update the "Built as a callable factory" paragraph in the file header to describe the class-first composition wrapper.

5. **`frontend/src/SqlAdminController.ts` — `openDefinition`** ([~L355](frontend/src/SqlAdminController.ts#L355)): `const { content, dispose } = DefinitionPanel(definition);` → `const panel = new DefinitionPanel(definition);`. Change `this._panelDisposers.set(id, dispose);` → `this._panelDisposers.set(id, panel.dispose);` and the `content` key in `addPanel({ … content })` → `content: panel.content`.

6. **`SqlAdminController.ts` — `openQuery`** ([~L896](frontend/src/SqlAdminController.ts#L896)): `const { content, dispose } = QueryPanel({ … })` → `const panel = new QueryPanel({ … })`. `this._panelDisposers.set(id, dispose);` → `this._panelDisposers.set(id, panel.dispose);`. `this.dock.addPanel({ id, title: label, glyph: "terminal", content });` → `content: panel.content`.

7. **`SqlAdminController.ts` — `openDocumentation`** ([~L419](frontend/src/SqlAdminController.ts#L419)): `const { component, editor } = DocumentationPanel(…)` → `const panel = new DocumentationPanel(…)`. Delete `this._notesEditor = editor;`. Add `this._panelDisposers.set(id, panel.dispose);`. `addPanel({ id, title: "Notes", glyph: "file-lines", content: component })` → `content: panel.content`.

8. **`SqlAdminController.ts` — Dock `"close"` handler** ([L220–223](frontend/src/SqlAdminController.ts#L220)): delete the `if (e.id === this.notesPanelId()) { this._notesEditor?.dispose(); this._notesEditor = null; }` block — notes teardown now runs through `this._panelDisposers.get(e.id)?.()` (L217) like every other panel.

9. **`SqlAdminController.ts` — remove now-dead notes-editor state**: delete the `_notesEditor` field + its comment ([L143–146](frontend/src/SqlAdminController.ts#L143)) and remove the `import type { MarkdownEditor } … from "@jimka/typescript-ui/component/editor";` on [L19](frontend/src/SqlAdminController.ts#L19) (it merges into the `Tree, TreeNode` import line — keep that import; drop only the `MarkdownEditor` type). Update the `_panelDisposers` comment ([L131–134](frontend/src/SqlAdminController.ts#L131)) to list `QueryPanel, DefinitionPanel, DocumentationPanel`.

10. **Checkpoints:**
    - `grep -rn 'QueryPanel(\|DefinitionPanel(\|DocumentationPanel(\|QueryResultGrid(\|QueryResultChart(' frontend/src` — every remaining hit must be preceded by `new` (or be a `class …`/type/doc line); expect **zero** bare-call invocations.
    - `grep -rn '_notesEditor\|\.component\b' frontend/src/SqlAdminController.ts` — expect zero `_notesEditor`; no `.component` handle access remains.
    - `grep -rn 'MarkdownEditor' frontend/src/SqlAdminController.ts` — expect zero.
    - `npx tsc --noEmit` (from `frontend/`) — clean.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/dock/DefinitionPanel.ts` |
| Modify | `frontend/src/dock/DocumentationPanel.ts` |
| Modify | `frontend/src/dock/QueryResultView.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify (shared) | `frontend/src/SqlAdminController.ts` |
| Modify (doc) | `frontend/COMPONENT_CONVENTIONS.md` |

---

## Expected Behaviour

Behaviour must be **identical** to today except for the disposal-path unification. Pin these:

- **Construction parity** — `new DefinitionPanel(def)`, `new DocumentationPanel(initial, onChange)`, `new QueryResultGrid(result)`, `new QueryResultChart(result)`, `new QueryPanel(options)` each produce a `content` that is the same component subtree the factory produced. *Unit-testable* only shallowly (constructing DOM/CodeMirror/chart components requires jsdom and the library's DOM side-effects; per project memory these UI modules touch `document` at import scope, so they are not exercised by the node vitest suite). Treat as **manual** for the DOM-bound panels; the pure inputs (`buildQueryModel`, `buildChartSeries`, `defaultChartConfig`) already have their own tests and are unchanged.
- **Definition tab close** — opening a view's definition tab then closing it calls `DefinitionPanel.dispose()`, releasing the read-only `CodeEditor`'s CodeMirror view + ThemeManager subscription. **Manual** (Dock close event).
- **Query tab close** — closing a query tab calls `QueryPanel.dispose()`, which disposes any live Data grid, Chart, and Explain-plan editor plus the main SQL editor (no CodeMirror/chart leak). Re-running, charting, and Explain across a panel's life still dispose superseded slot views (unchanged slot logic). **Manual.**
- **Query editor accelerators still fire** — inside a query editor: Ctrl/Cmd+Enter runs, Ctrl/Cmd+S saves, Ctrl/Cmd+E explains, Ctrl/Cmd+Shift+E explain-analyzes, Alt+C clears, Ctrl+↑/↓ recalls history; toolbar Run/Save/Chart/Explain buttons behave as before. (These stay local closures — regression risk is only from an accidental body edit during the wrap.) **Manual.**
- **Chart tab** — opening the Chart tab on a chartable result, switching x/y combos and line/bar toggle rebuilds the chart; closing the Chart tab (or the panel) disposes the live chart instance exactly once (no double-dispose — the existing `suppressCloseHandler`/slot ownership is untouched). **Manual.**
- **Notes tab persistence + close** — typing in the Notes tab still persists through `onChange` → `NotesStore.save`; **closing the Notes tab disposes the `MarkdownEditor` via the unified `_panelDisposers` path** (not the deleted `_notesEditor` branch). Re-opening Notes re-seeds from the store. The `MarkdownEditor` is no longer reachable outside `DocumentationPanel` by design; the only prior external use was disposal, now internal. **Manual.**
- **No double-dispose / no missed dispose on notes** — after step 8/9, exactly one path disposes the notes editor. Verify closing Notes does not throw and does not leave a leaked editor, and that non-notes panels are unaffected. **Manual.**

Automated gate for the whole change: **`tsc --noEmit` clean** + the grep invariants in step 10. These catch the mechanical errors (missed `new`, stale `.component`/`.dispose` destructure, dangling `_notesEditor`/`MarkdownEditor` references) that are the realistic failure mode of this refactor.

---

## Verification

1. `cd frontend && npx tsc --noEmit` — zero errors.
2. Step-10 greps — all expected-zero / all-`new` invariants hold.
3. Run the app (`frontend` dev server) and exercise, watching the console for errors:
   - Open a view's **definition** tab, close it.
   - Open a **query** tab; run a SELECT (Ctrl+Enter), open **Chart**, switch axes/type, run **Explain** (Ctrl+E) and **Explain Analyze** (Ctrl+Shift+E), **Save** (Ctrl+S), **Clear** (Alt+C), recall with Ctrl+↑/↓; close the tab.
   - Open the **Notes** tab, type (confirm persistence by reopening), close it — confirm no console error and the editor is torn down.
4. Confirm the sibling `class-first-*` plans' controller edits merge cleanly (this plan touches distinct methods/lines: `openDefinition`, `openQuery`, `openDocumentation`, the `"close"` handler, and the `_notesEditor`/`_panelDisposers` fields).

---

## Documentation Impact

- **`frontend/COMPONENT_CONVENTIONS.md`** — add a section (e.g. `## (f) The composition fallback`) documenting that when a builder's body is too large / closure-dense to hoist into an `extends` class under the super-cascade constraint (the `QueryPanel` case), the class-first form is a **plain class owning a `content` field + an arrow-field `dispose`**, mounted by the consumer as `instance.content` and torn down via `instance.dispose()`. State it is a fallback from the preferred `extends` form (section (d)), and that `dispose` must be an arrow field because consumers store it by reference. This closes the gap the briefing assumed already existed.
- No public library/barrel surface changes — these are app-internal `dock/` modules with no doc-site page. No cross-references outside `SqlAdminController.ts` and `QueryPanel.ts` (grep-confirmed).

---

## Potential Challenges

- **Missed `new` on an internal call** — `QueryPanel` calls `QueryResultGrid`/`QueryResultChart`; forgetting `new` yields a "cannot call a class as a function" type error — caught by `tsc` and the step-10 grep.
- **Storing a method instead of an arrow field** — if `dispose` were written as a plain method, `this._panelDisposers.set(id, panel.dispose)` and the `QueryPanel` slot `{ dispose: next.dispose }` would detach `this`. Mitigation: `dispose` is specified as an arrow-function field on every wrapper (Architecture Decisions).
- **DocumentationPanel field rename** — `component` → `content`; any leftover `.component` access in the controller is a `tsc` error and a step-10 grep target.
- **Deleting the notes-close branch prematurely** — the branch (step 8) may only be removed *together with* registering `panel.dispose` in `openDocumentation` (step 7); doing one without the other either leaks the editor or double-disposes. Do steps 7 and 8 as a pair.
- **Shared-file merge with sibling plans** — `SqlAdminController.ts` is edited by other `class-first-*` plans; keep edits scoped to the named methods/lines to minimize conflict.

---

## Critical Files

- `frontend/COMPONENT_CONVENTIONS.md` — the migration rules (sections (a)–(e)); this plan uses the undocumented composition fallback.
- `frontend/src/dock/TableWorkPanel.ts` — the worked `extends Container` example and the proof the Dock accepts a component instance as `content` (contrast: this plan's modules use composition, not `extends`).
- `frontend/src/shell/LoginForm.ts` — the locals → `super({ components })` → field-assignment template (relevant only as the rejected (a) pattern).
- `frontend/src/SqlAdminController.ts` — the sole consumer; the `_panelDisposers` map, the Dock `"close"` handler, and `openDefinition`/`openQuery`/`openDocumentation`.

---

## Non-Goals

- **Converting the remaining builders** (`StructurePanel`, `ViewWorkPanel`, `RoleGrantsPanel`, `workPanelShell`) — out of scope; the conventions doc says convert only what you're already touching.
- **Adopting the `extends` form (option a) for the trivial panels** — deliberately rejected for uniformity and to keep `QueryPanel` low-risk (Architecture Decisions).
- **Changing any panel's runtime behaviour, layout, or event wiring** — this is a shape refactor; the only functional change is unifying the notes-editor disposal into `_panelDisposers`.
