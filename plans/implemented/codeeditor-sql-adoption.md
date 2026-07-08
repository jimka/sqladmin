# CodeEditor for SQL surfaces — Implementation Plan

## Overview

Replace the three plain-text SQL widgets in the sqladmin frontend with typescript-ui's new live `CodeEditor` (`@jimka/typescript-ui/component/editor`), gaining SQL syntax highlighting and one-command formatting:

1. The editable query editor in [frontend/src/dock/QueryPanel.ts:115](frontend/src/dock/QueryPanel.ts#L115) — a `TextArea` → `new CodeEditor(initialSql, { language: "sql" })`, plus a new **Format** toolbar button calling `editor.format()`.
2. The read-only EXPLAIN plan view in the same file ([QueryPanel.ts:436-446](frontend/src/dock/QueryPanel.ts#L436)) — a monospace-styled read-only `TextArea` → `new CodeEditor(result.plan, { language: "sql", readOnly: true })`.
3. The read-only view SQL definition in [frontend/src/dock/DefinitionPanel.ts:13](frontend/src/dock/DefinitionPanel.ts#L13) — `new TextArea(definition, { readOnly: true })` → `new CodeEditor(definition, { language: "sql", readOnly: true })`.

`CodeEditor` is a **live-only** component (like `Canvas`): under the framework's offline test seam it mounts nothing and every method (`getValue`, `setValue`, `format`, …) no-ops. There are **no unit tests** for either panel (`grep -rln 'QueryPanel\|DefinitionPanel' src` yields only source + the controller; the only related tests — `historyCursor`, `explain`, `exportExplainResult`, `queryStore` — exercise pure logic that never touches the widget). So this change breaks no test, but its runtime behaviour (highlighting, `format()`, shortcuts, editor text) is **manual-verify only**.

Two API facts drive the reroute and are verified against the shipped types (`node_modules/@jimka/typescript-ui/dist/lib/types/component/editor/CodeEditor.d.ts`):

- `CodeEditor` exposes **only** the events `"change"` (payload `{ value }`) and `"readonlyedit"` — **not** the `"keydown"`/`"action"` DOM events QueryPanel's `TextArea` used. Shortcuts reroute through `Event.addListener(editor, "keydown", …)` (the app's existing idiom, already used in `shell/QueriesView.ts:267`); toolbar-sync reroutes from `on("action")` to `on("change")`.
- `CodeEditor.dispose()` (unsubscribes the `ThemeManager` theme listener and destroys the CodeMirror view) is **never called by the framework** — the base `Component` has no cascading dispose, and `destructor()` runs only via GC finalization, not on Dock tab close. Because `ThemeManager` holds a strong reference to each live editor's theme-change closure, an un-disposed editor **leaks** (view + component) for every closed query/definition tab and every re-run EXPLAIN. Disposal must be wired explicitly.

---

## Architecture Decisions

### Reroute editor shortcuts through `Event.addListener`, not `editor.on("keydown")`

`CodeEditor.on` accepts only `"change"`/`"readonlyedit"`; it has no `"keydown"`. The app already wires component-scoped keydowns via `Event.addListener(component, "keydown", handler)` (`shell/QueriesView.ts:267`, on a `List`). `Event.addListener` installs a **window capture-phase** dispatcher and resolves the keydown's target element up to the registered component, so a keydown originating in CodeMirror's inner `contentDOM` resolves to the `CodeEditor` and fires **before** CodeMirror's own target/bubble-phase key handling — meaning `preventDefault()` in the handler still suppresses any CodeMirror default (e.g. `Ctrl+↑/↓` cursor motion). This preserves every existing chord (`Ctrl+Enter` run, `Ctrl+S` save, `Ctrl/Cmd+E` / `+Shift+E` explain, `Alt+C` clear, `Ctrl+↑/↓` history) with a one-line seam swap and no reach into the opaque element `Handle`.

### Reroute toolbar-sync from `on("action")` to `on("change")`

The `TextArea` used `on("action")` (input-event shorthand) specifically because its `"change"` bridge fired **before** `onInput`, reading a stale value. That ordering caveat is a `TextArea` artefact. `CodeEditor` emits `"change"` from CodeMirror's `updateListener` **after** the document transaction commits, and `getValue()` reads live view state, so `on("change", () => syncToolbarButtons())` reads the fresh value — the correct and only seam here.

### Controller-driven disposal via a `{ content, dispose }` factory return

Query panels are deliberately **not** registered in `_openPanels` ([SqlAdminController.ts:346](frontend/src/SqlAdminController.ts#L346)); definition panels are. Neither factory currently exposes a teardown hook, and the panel Container has no per-component "closed" event. The Dock fires one dock-level `"close"` event → `disposePanel(id)` ([SqlAdminController.ts:145](frontend/src/SqlAdminController.ts#L145)). Therefore the controller must own disposal: change `QueryPanel(...)` and `DefinitionPanel(...)` to return `{ content: Container; dispose: () => void }`; the controller stores each `dispose` in a new `_panelDisposers: Map<string, () => void>` keyed by panel id and invokes it from the existing `"close"` handler. This is the first live-only component in the app, so there is no prior disposer-return precedent — introduce it minimally, at the two call sites only.

### Two editors live in QueryPanel; both must be disposed

QueryPanel holds the long-lived main SQL editor **and** creates a fresh read-only plan `CodeEditor` on every EXPLAIN run (replacing the previous result-pane content). Each plan editor is its own live view + theme subscription, so the previous one must be disposed before it is replaced (rows result, another plan, hide, or clear) and on panel teardown — otherwise EXPLAIN leaks one editor per run. Track the current plan editor in a `planView` local and dispose it in a `disposePlanView()` helper called at the top of `showResultPane` and from `hideResultPane`; the panel's `dispose()` calls `disposePlanView()` then `editor.dispose()`.

### `getValue()` before mount returns the seed — autoRun/autoExplain is safe

`CodeEditor.getValue()` falls back to `_options.value` when `_view` is null (verified in source), and the constructor seeds `_options.value` from the positional `value`. The factory's `autoRun`/`autoExplain` fire synchronously at the end of construction, **before** the Dock mounts the editor, and read `editor.getValue().trim()`. That returns the seeded `initialSql`, so seeded run/explain still works. Likewise pre-mount `setValue` updates `_options.value`, which the later `mount()` renders — so `clear()`/history-recall before first layout persist correctly. No ordering change needed.

### Read-only editors keep the built-in rejection affordance

A read-only `CodeEditor` blocks edits at CodeMirror's input layer and, on an edit attempt, flashes an overlay and emits `"readonlyedit"` — a strictly better affordance than the old read-only `TextArea`. We do not need to wire `"readonlyedit"`; it is noted only so the implementer does not add custom edit-blocking. The `PLAN_STYLE` monospace/pre inline style is deleted — CodeMirror renders its own monospace, internally-scrolling surface.

---

## Public API

No library API changes. Two **app-internal** factory signature changes (single call site each, both in `SqlAdminController`):

```ts
// frontend/src/dock/QueryPanel.ts
export function QueryPanel(options: QueryPanelOptions): { content: Container; dispose: () => void };

// frontend/src/dock/DefinitionPanel.ts
export function DefinitionPanel(definition: string): { content: Container; dispose: () => void };
```

`CodeEditor` surface used (all verified in `CodeEditor.d.ts` + inherited `Component.d.ts`):

```ts
new CodeEditor(value?: string, options?: { value?; language?; readOnly?; listeners? })
getValue(): string
setValue(value: string): this
setReadOnly(readOnly: boolean): this      // not needed — pass readOnly in options instead
format(): Promise<void>                    // rejects on invalid SQL, leaving text untouched
on("change", (p: { value: string }) => void): this
dispose(): void
// inherited from Component: focus(preventScroll?), onFirstLayout(cb), getElement()
```

`Event.addListener(component, "keydown", (e: KeyboardEvent) => void)` — from `@jimka/typescript-ui/core`.

---

## Ordered Implementation Steps

### QueryPanel.ts

1. **Imports.** Replace the `TextArea` import (line 27) with `import { CodeEditor } from "@jimka/typescript-ui/component/editor";`. Add `Event` to the existing core import (line 20): `import { Component, Container, Panel, Event } from "@jimka/typescript-ui/core";`. Add the Format glyph import next to the others: `import { wand_magic_sparkles } from "@jimka/typescript-ui/glyphs/solid/wand_magic_sparkles";` and add `wand_magic_sparkles` to the `Glyph.register(...)` call (line 53).
2. **Delete `PLAN_STYLE`** (lines 55-58) — no longer referenced.
3. **Main editor construction** (line 115): `const editor = new CodeEditor(initialSql, { language: "sql" });`. Leave the `body.addComponent(editor, { weight: 0 })` line unchanged — the Split pane (and, while it is the sole pane, the Split fill fallback) sizes it, satisfying CodeEditor's sized-host requirement.
4. **Add the Format button.** After `clearButton` (line 132) add:
   ```ts
   const formatButton = glyphButton("wand-magic-sparkles", NEUTRAL_COLOR, "Format SQL", () => void formatSql());
   ```
   (The glyph registers under its hyphenated name.) Add `formatButton` to the ToolBar `components` array (line 153), placed after `clearButton`, before `explainButton`.
5. **Add `formatSql()`** near `save()`:
   ```ts
   /** Format the editor SQL; on invalid SQL format() rejects and leaves text untouched. */
   async function formatSql(): Promise<void> {
       try {
           await editor.format();
       } catch {
           notify("Cannot format — the statement is not valid SQL");
       }
   }
   ```
6. **Plan-editor tracking.** Add a module-scope-of-factory local `let planView: CodeEditor | null = null;` and helper:
   ```ts
   /** Dispose the current read-only plan editor (if any) before it is replaced or torn down. */
   function disposePlanView(): void {
       planView?.dispose();
       planView = null;
   }
   ```
7. **`showResultPane`** (line 200): call `disposePlanView();` as the first statement (before `resultHost.removeAllComponents()`), so a rows result or a new plan disposes the prior plan editor.
8. **`hideResultPane`** (line 240): call `disposePlanView();` as the first statement.
9. **`showPlan`** (line 436): replace the `TextArea` block with:
   ```ts
   const view = new CodeEditor(result.plan, { language: "sql", readOnly: true });

   showResultPane(view);
   planView = view;
   setActiveExport({ kind: "plan", plan: { result, sql, runExplain } });
   ```
   (Set `planView` **after** `showResultPane`, since `showResultPane` disposes the prior `planView` first.) Delete the `view.setReadOnly(true)` line — `readOnly` is passed in options.
10. **Shortcuts seam** (line 455): change `editor.on("keydown", (e: KeyboardEvent) => { … })` to `Event.addListener(editor, "keydown", (e: KeyboardEvent) => { … })`. The handler body is unchanged.
11. **Toolbar-sync seam** (line 534): change `editor.on("action", () => syncToolbarButtons())` to `editor.on("change", () => syncToolbarButtons())`. Update the preceding comment (the stale-value note about `action`-vs-`change` no longer applies — CodeEditor's `change` fires after the commit with a fresh `getValue()`).
12. **Factory return** (line 554): change `return panel;` to:
    ```ts
    return {
        content: panel,
        dispose: () => {
            disposePlanView();
            editor.dispose();
        },
    };
    ```
13. Leave all `editor.getValue()`/`editor.setValue()`/`editor.focus()`/`editor.onFirstLayout()` call sites (lines 252, 263, 279, 304, 349, 511, 514, 527, 546) **unchanged** — the API is identical to `TextArea`'s.

### DefinitionPanel.ts

14. Replace the `TextArea` import with `import { CodeEditor } from "@jimka/typescript-ui/component/editor";`. Body:
    ```ts
    export function DefinitionPanel(definition: string): { content: Container; dispose: () => void } {
        const editor = new CodeEditor(definition, { language: "sql", readOnly: true });
        const content = Container({ layoutManager: new Fit(), components: [editor] });

        return { content, dispose: () => editor.dispose() };
    }
    ```
    Update the JSDoc to mention it returns the panel plus its disposer.

### SqlAdminController.ts

15. **Add the disposer registry.** Near `_openPanels` (line 76) add `private readonly _panelDisposers: Map<string, () => void> = new Map();`.
16. **`"close"` handler** (line 145): after `this.disposePanel(e.id);` add:
    ```ts
    this._panelDisposers.get(e.id)?.();
    this._panelDisposers.delete(e.id);
    ```
17. **`openQuery`** (line 371): destructure the factory and register the disposer before `addPanel`:
    ```ts
    const { content, dispose } = QueryPanel({ /* unchanged options */ });

    this._panelDisposers.set(id, dispose);
    this.dock.addPanel({ id, title: label, glyph: "terminal", content });
    ```
18. **`openDefinition`** (line 268): same pattern —
    ```ts
    const { content, dispose } = DefinitionPanel(definition);

    this._panelDisposers.set(id, dispose);
    this.dock.addPanel({ id, title: `${ref.name ?? id} (definition)`, glyph: "file-code", tooltip: this.panelTooltip(ref), content });
    ```

### Checkpoints

- `grep -n 'TextArea' src/dock/QueryPanel.ts src/dock/DefinitionPanel.ts` → **zero** matches.
- `grep -n 'PLAN_STYLE' src/dock/QueryPanel.ts` → zero.
- `grep -n 'on("action")\|on("keydown")' src/dock/QueryPanel.ts` → zero (both rerouted).
- `npx tsc --noEmit` (in `frontend/`) → clean.

---

## Expected Behaviour

Everything below is **manual-verify** (CodeEditor is live-only; the offline seam mounts nothing). Drive the live app (`npm run dev` in `frontend/`, open a connection).

1. **Query editor renders with SQL highlighting.** New Query tab → typing SQL shows keyword/string/number colouring; the editor fills the panel until a result appears, then sits at ~150px over the result grid with a draggable gutter (unchanged layout).
2. **Format button** — click with valid SQL (e.g. `select 1 from t where a=1`) → SQL is re-formatted (uppercased keywords, line breaks) in one step, cursor preserved. With **invalid** SQL (e.g. `select from where`) → text is left **completely untouched** and the status line shows "Cannot format — the statement is not valid SQL".
3. **All existing shortcuts still fire** from inside the editor: `Ctrl+Enter` runs, `Ctrl+S` saves, `Ctrl/Cmd+E` explains, `Ctrl/Cmd+Shift+E` explain-analyzes, `Alt+C` clears, `Ctrl+↑/↓` recalls history (older/newer). None of these are swallowed by CodeMirror, and plain arrows/typing/`Ctrl+C` copy are untouched.
4. **Toolbar enable/disable tracks typing** — Run/Save/Clear enable as soon as the editor is non-empty and disable when emptied (driven now by `on("change")`).
5. **Seeded open** — "Open as query" (autoRun) runs the seeded SELECT immediately; a view's Explain action (autoExplain) shows its plan immediately — both read the seed before mount and behave as before.
6. **EXPLAIN plan view** — read-only, monospace, SQL-highlighted, internally scrolling; attempting to type in it flashes the read-only overlay (new affordance) and changes nothing; text is selectable/copyable; Export (text/JSON) still works.
7. **Definition tab** — a view's definition shows as read-only, highlighted, selectable SQL.
8. **No leak on teardown** — closing a query or definition tab, or re-running EXPLAIN repeatedly, disposes the prior editor(s): in the live app, confirm via a heap snapshot that `EditorView` instances do not accumulate across ~10 open/close (or explain-rerun) cycles.

---

## Verification

- `npx tsc --noEmit` in `frontend/` — clean (the two changed factory return types must type-check at their `SqlAdminController` call sites).
- `npm test` in `frontend/` — the existing suite (`historyCursor`, `explain`, `exportExplainResult`, `queryStore`, …) stays green; none instantiate the panels, so none change.
- The grep checkpoints above.
- Manual smoke test per **Expected Behaviour** in the live app — the only way to exercise the live-only editor. Screen: a New Query dock tab, an EXPLAIN run, and a view Definition tab.
- Optional but recommended: a browser production build (`npm run build && npm run preview`) confirming the editor still renders — the `esbuild.keepNames` workaround already in `vite.config.ts` covers CodeEditor's `constructor.name` class-derivation (see LIBRARY_NOTES).

---

## Potential Challenges

- **Shortcut capture ordering.** If a chord appears not to fire, confirm the handler is wired via `Event.addListener` (window capture) — `editor.on("keydown", …)` does not exist on CodeEditor and would be a type error, so tsc catches a mistaken port. `preventDefault()` (not `stopPropagation()`) keeps unconsumed events bubbling to the document-level Alt-chord accelerators, matching the current design.
- **Forgetting the plan editor's dispose.** The per-EXPLAIN plan editor is easy to miss — its dispose is the reason for `disposePlanView()` at the top of `showResultPane`/`hideResultPane`. Without it, EXPLAIN leaks one live editor per run.
- **Factory return is now an object.** Both call sites in `SqlAdminController` must destructure `{ content, dispose }`; passing the raw factory result to `addPanel({ content })` would break. tsc flags this.
- **Live-only means no automated coverage for the swap.** Do not add offline tests that read editor text — they would assert against a no-op seam. Rely on the manual checklist.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/src/dock/DefinitionPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |

---

## Critical Files

- [frontend/src/dock/QueryPanel.ts](frontend/src/dock/QueryPanel.ts) — the main swap; all editor read/write/shortcut sites.
- [frontend/src/dock/DefinitionPanel.ts](frontend/src/dock/DefinitionPanel.ts) — the read-only definition swap.
- [frontend/src/SqlAdminController.ts](frontend/src/SqlAdminController.ts) — `openQuery` (L362), `openDefinition` (L250), the `"close"` handler (L145), `disposePanel` (L922); wires the new disposer registry.
- `node_modules/@jimka/typescript-ui/dist/lib/types/component/editor/CodeEditor.d.ts` — the exact CodeEditor surface (events, methods).
- `/home/jika/typescript/typescript-ui/docs/components/CodeEditor.md` — behaviour reference (live-only, sized host, `format()` semantics, `dispose()`).
- [frontend/src/shell/QueriesView.ts:267](frontend/src/shell/QueriesView.ts#L267) — the `Event.addListener(component, "keydown", …)` idiom to mirror.
- [frontend/src/dock/glyphButton.ts](frontend/src/dock/glyphButton.ts) — the toolbar-button helper the Format button uses.

---

## Non-Goals

- Charts, diagrams, and markdown surfaces — separate plans; do not touch here.
- A Format keyboard chord — the task specifies a toolbar button only; keep it button-driven to stay in scope.
- Migrating shortcut handling to the document level or reworking the active-panel routing — out of scope; the `Event.addListener` reroute preserves the existing editor-scoped design.
- Adding offline/unit tests for the panels — impossible against the live-only seam; verification is manual.
- Changing the library's CodeEditor (e.g. adding a keydown/keymap seam) — the app adapts via the supported `Event.addListener` idiom.
