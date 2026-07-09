---
touches-shared:
  - frontend/src/SqlAdminController.ts
  - frontend/src/shell/SqlAdminShell.ts
---

# Markdown Documentation Panel — Implementation Plan

## Overview

Add an editable documentation / notes panel to the sqladmin frontend, backed by
typescript-ui's `MarkdownEditor` (a WYSIWYG rich-text editor whose value is a
Markdown string, from `@jimka/typescript-ui/component/editor`). The panel opens
as its own Dock work tab, seeded from and persisting to a per-connection
localStorage key, so a user's authored notes survive reloads.

Three things are added and two shared files are touched additively:
- **New** `frontend/src/data/notesStore.ts` — a pure, `KeyValueStore`-injected
  store for the single Markdown string, mirroring the query stores in
  [queryStore.ts](frontend/src/data/queryStore.ts).
- **New** `frontend/src/dock/DocumentationPanel.ts` — a factory that hosts a
  `MarkdownEditor` in a `Fit` panel, mirroring [DefinitionPanel.ts](frontend/src/dock/DefinitionPanel.ts).
- **Modify** [SqlAdminController.ts](frontend/src/SqlAdminController.ts) — a new
  `openDocumentation()` method, a `_notes` store field, a `_notesEditor`
  reference, and explicit editor disposal in the existing `dock.on("close")`
  handler ([SqlAdminController.ts:145](frontend/src/SqlAdminController.ts#L145)).
- **Modify** [SqlAdminShell.ts](frontend/src/shell/SqlAdminShell.ts) — one new
  Tools-menu item wired to `controller.openDocumentation()`.

`MarkdownEditor` is a *foreign live widget* (Lexical) like `CodeEditor`: its view
mounts nothing under the offline test seam, but `getValue()`/`setValue()` and the
`"change"` event operate on the DOM-free Lexical state, so value round-trip is
library-testable while the rendered surface is not. In this app's node-only
vitest (no DOM), only the pure `NotesStore` is unit-tested; the editor/panel
behaviour is verified live, matching the existing convention
([vitest.config.ts:8](frontend/vitest.config.ts#L8): "component/DOM behaviour is
verified live, not here").

---

## Architecture Decisions

### Persistence lives in a new `NotesStore`, keyed `sqladmin.notes.<connectionId>`

The notes are a single Markdown string per connection, not a query. Adding a
`NotesStore` to a new `data/notesStore.ts` (rather than extending
`queryStore.ts`, which is explicitly "the query workspace") keeps the query
features' file untouched and reuses the same `KeyValueStore` seam so the logic is
red-green testable offline. The key prefix `sqladmin.notes.` sits under the
`sqladmin.*` namespace, so the existing "Clear SQL Admin data" button in
[localStorageWindow.ts:29](frontend/src/shell/localStorageWindow.ts#L29) (which
removes every `sqladmin.*` key) already clears notes with no extra wiring, and
the localStorage inspector already dumps it. The value is stored as the **raw
Markdown string** (no `JSON.stringify`): it is a single scalar, and the
inspector's `readValue` falls back to raw text when a value doesn't parse as JSON.

### The panel is a deduped singleton Dock tab, id `notes/<connectionId>`

Mirrors the role-grants id style (`grants/<conn>/<role>`,
[SqlAdminController.ts:833](frontend/src/SqlAdminController.ts#L833)). Re-invoking
`openDocumentation()` focuses the existing tab via `this.dock.focusPanel(id)`
instead of opening a second one — the same dedup guard `openTable`/`openStructure`
use. The panel is deliberately **not** registered in `_openPanels` (it carries no
`DbObjectRef`/`node`/`columns`), exactly like scratch query panels; `syncToPanel`
no-ops for an unknown id, so the focus handler needs no change.

### The controller explicitly disposes the editor on tab close

`MarkdownEditor.dispose()` is a **separate public method**, not tied to the
framework's `Component.destructor()` — the library does not auto-call it on
disconnect (verified against the editor source). So unlike a query panel (whose
`TextArea` needs no teardown and is collected when the Dock disposes the
subtree), the notes editor must be disposed by hand. The controller keeps a
`_notesEditor` reference and, in the existing `dock.on("close")` handler, calls
`this._notesEditor?.dispose()` and clears the reference when the closed id is the
notes panel. Re-opening after close builds a fresh editor.

### No source/WYSIWYG toggle in v1

The editor ships with `mode: "wysiwyg"` (its default) and no toolbar. A
`ToggleButton`-driven `setMode` switch is consumer-wired and would add chrome for
marginal value on a prose-authoring surface; leaning on the library default
matches the project's "prefer library defaults" convention. The `setMode` seam
remains available for a later revision (see Non-Goals).

### `touches-shared` includes the shell, not just the controller

Both this plan and the parallel schema-diagram plan add an `open*` controller
method **and** a menu entry point in `SqlAdminShell.ts`'s `buildMenuBar`. Both
files are therefore shared; edits here are additive (one new menu item, one new
method + field) and must not reorder or restructure existing entries.

---

## Public API

New exported symbols (no changes to existing signatures):

```typescript
// frontend/src/data/notesStore.ts
/** Per-connection single-string notes store (raw Markdown, no JSON wrapper). */
export class NotesStore {
    constructor(connectionId: string, storage: KeyValueStore);
    /** The saved Markdown, or "" when never saved. */
    load(): string;
    /** Persist the Markdown string (overwrites). */
    save(markdown: string): void;
}
```

```typescript
// frontend/src/dock/DocumentationPanel.ts
/**
 * Build the documentation panel: a MarkdownEditor filling a Fit host, seeded
 * with `initial` and reporting edits through `onChange`. Returns the mount
 * container plus the editor so the caller can dispose() it on teardown.
 */
export function DocumentationPanel(
    initial: string,
    onChange: (markdown: string) => void,
): { component: Container; editor: MarkdownEditor };
```

```typescript
// frontend/src/SqlAdminController.ts (new method)
/** Open (or focus) the singleton documentation/notes tab for this connection. */
openDocumentation(): void;
```

`KeyValueStore` is reused from `queryStore.ts` (already exported there).

---

## Internal Structure

`NotesStore` (whole file body — trivial, mirrors `SavedQueryStore`'s shape):

```typescript
import type { KeyValueStore } from "./queryStore";

// localStorage key prefix, namespaced per connection under the app's sqladmin.*
// namespace so "Clear SQL Admin data" removes it with the query keys.
const NOTES_KEY_PREFIX = "sqladmin.notes.";

export class NotesStore {
    private readonly _key: string;
    private readonly _storage: KeyValueStore;

    constructor(connectionId: string, storage: KeyValueStore) {
        this._key     = NOTES_KEY_PREFIX + connectionId;
        this._storage = storage;
    }

    load(): string { return this._storage.getItem(this._key) ?? ""; }
    save(markdown: string): void { this._storage.setItem(this._key, markdown); }
}
```

`DocumentationPanel` (body):

```typescript
import { Container }      from "@jimka/typescript-ui/core";
import { Fit }            from "@jimka/typescript-ui/layout";
import { MarkdownEditor } from "@jimka/typescript-ui/component/editor";

export function DocumentationPanel(
    initial: string,
    onChange: (markdown: string) => void,
): { component: Container; editor: MarkdownEditor } {
    const editor = new MarkdownEditor(initial);
    editor.on("change", ({ value }) => onChange(value));

    const component = Container({ layoutManager: new Fit(), components: [editor] });

    return { component, editor };
}
```

Controller wiring (additive):

- Field: `private _notesEditor: MarkdownEditor | null = null;` and, alongside
  `_history`/`_saved`, `private readonly _notes: NotesStore;` constructed in the
  constructor as `new NotesStore(connectionId, window.localStorage)`.
- Import `MarkdownEditor` type, `NotesStore`, `DocumentationPanel`, and the
  `file_lines` glyph; add `file_lines` to the controller's top-level
  `Glyph.register(...)` call so the tab glyph is registered where it's referenced.
- Method:

```typescript
openDocumentation(): void {
    const id = this.notesPanelId();

    if (this.dock.focusPanel(id)) {
        return;
    }

    const { component, editor } = DocumentationPanel(
        this._notes.load(),
        markdown => this._notes.save(markdown),
    );
    this._notesEditor = editor;

    this.dock.addPanel({ id, title: "Notes", glyph: "file-lines", content: component });
}

private notesPanelId(): string {
    return `notes/${this._connectionId}`;
}
```

- In the existing `dock.on("close")` handler, append:

```typescript
if (e.id === this.notesPanelId()) {
    this._notesEditor?.dispose();
    this._notesEditor = null;
}
```

Shell wiring: add one item to the Tools menu items array in `buildMenuBar`
([SqlAdminShell.ts:318](frontend/src/shell/SqlAdminShell.ts#L318)), after the
`separator` before "Show localStorage…" (or as its own group), and a matching
`onOpenDocumentation: () => void` field on `MenuBarActions` wired in the
`buildMenuBar({...})` call to `() => controller.openDocumentation()`. Reuse the
already-registered `"file-lines"` glyph:

```typescript
{ text: "Notes…", glyph: "file-lines", action: actions.onOpenDocumentation },
```

---

## Ordered Implementation Steps

1. **Create `frontend/src/data/notesStore.ts`** with the `NotesStore` class and
   `NOTES_KEY_PREFIX` const above (file-top comment + JSDoc per conventions).
   Import `KeyValueStore` as a type from `./queryStore`.
2. **Create `frontend/src/data/notesStore.test.ts`** covering the Expected
   Behaviour cases below, reusing the `fakeStorage()` pattern from
   [queryStore.test.ts:5](frontend/src/data/queryStore.test.ts#L5). Run
   `npm test` — expect green.
3. **Create `frontend/src/dock/DocumentationPanel.ts`** with the factory above
   (file-top comment describing it as the editable counterpart to DefinitionPanel).
4. **Edit `frontend/src/SqlAdminController.ts`** (all additive, localized):
   - Add imports: `NotesStore` from `./data/notesStore`, `DocumentationPanel`
     from `./dock/DocumentationPanel`, `MarkdownEditor` (type) from
     `@jimka/typescript-ui/component/editor`, and `file_lines` from
     `@jimka/typescript-ui/glyphs/solid/file_lines`; add `file_lines` to the
     top-level `Glyph.register(...)` call.
   - Add fields `_notes` (readonly `NotesStore`) and `_notesEditor`
     (`MarkdownEditor | null = null`); construct `_notes` in the constructor
     beside `_history`/`_saved`.
   - Append the notes-dispose branch inside the existing `dock.on("close")`
     handler.
   - Add the `openDocumentation()` method and the private `notesPanelId()` helper.
5. **Edit `frontend/src/shell/SqlAdminShell.ts`**:
   - Add `onOpenDocumentation: () => void` to the `MenuBarActions` interface
     (with a doc comment).
   - Add the "Notes…" item to the Tools menu items array in `buildMenuBar`.
   - Wire `onOpenDocumentation: () => controller.openDocumentation()` in the
     `buildMenuBar({...})` call in `SqlAdminShell`.
6. **Typecheck**: `npm run typecheck` — expect zero errors.
7. **Regression grep**: `grep -rn "openDocumentation" frontend/src/` — expect the
   controller method, the shell wiring, and nothing stale.
8. **Live smoke test** (per Verification) — the editor round-trip and persistence
   cannot be exercised by the node-only vitest.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Create | `frontend/src/data/notesStore.ts` |
| Create | `frontend/src/data/notesStore.test.ts` |
| Create | `frontend/src/dock/DocumentationPanel.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |

---

## Expected Behaviour

**`NotesStore` (unit-testable, node env, fake `KeyValueStore`):**
- `load()` on a fresh store (key absent) returns `""`.
- `save(md)` then `load()` returns exactly `md`, including multi-line Markdown and
  Markdown that is not valid JSON.
- `save` overwrites: a second `save` replaces the value.
- Per-connection isolation: two `NotesStore`s with different `connectionId`s write
  to distinct keys and never cross-read.
- The storage key is `sqladmin.notes.<connectionId>` (assert via the fake's map),
  so it falls under the `sqladmin.*` clear/dump surface.

**Editor + panel + controller wiring (manual / live — no DOM in the test env):**
- Opening Tools → "Notes…" opens a Dock tab titled "Notes" with a WYSIWYG editor
  filling the tab.
- Typing rich text and Markdown shortcuts (`# `, `**b**`, `- `) formats live.
- Edits persist: the `"change"` event writes the current Markdown to
  `sqladmin.notes.default`; reloading the app and reopening "Notes…" restores the
  authored content (seeded via `NotesStore.load()`).
- Re-invoking "Notes…" while the tab is open **focuses** the existing tab (no
  duplicate).
- Closing the tab disposes the Lexical editor (no console errors); re-opening
  builds a fresh editor seeded from the persisted value.
- The persisted key appears in Tools → "Show localStorage…", and "Clear SQL Admin
  data" removes it.

Per the MarkdownEditor doc, the value get/set/round-trip runs headless on the
DOM-free Lexical state and is covered by the library's own tests; this app defers
component behaviour to live verification, so no app-level DOM test is added.

---

## Verification

- `npm test` — the new `notesStore.test.ts` passes (the Expected Behaviour
  `NotesStore` cases), all existing suites stay green.
- `npm run typecheck` — zero errors (confirms the `MarkdownEditor`
  import/types and the `Container` factory usage resolve).
- `grep -rn "openDocumentation" frontend/src/` — controller method + shell wiring
  only.
- `grep -rn "sqladmin.notes" frontend/src/` — only in `notesStore.ts` (and its
  test).
- **Live** (`npm run dev`): open Tools → "Notes…", author text, confirm dedup on
  re-open, close/reopen, reload-and-restore, and that the key shows and clears in
  the localStorage inspector.

---

## Potential Challenges

- **Editor host must be sized.** The `MarkdownEditor` fills and scrolls its box;
  a `Fit` panel gives it the full tab area (same as `DefinitionPanel`'s
  `TextArea`). If it renders zero-height, the host layout — not the editor — is
  the cause.
- **Disposal ordering.** The `dock.on("close")` branch must null `_notesEditor`
  after `dispose()` so a later reopen doesn't dispose a live editor; the id guard
  (`e.id === this.notesPanelId()`) keeps it from firing for other tabs.
- **Shared-file coordination.** The schema-diagram plan also edits
  `SqlAdminShell.ts`'s `buildMenuBar` and adds a controller `open*` method; keep
  both edits additive and expect a possible trivial merge in the Tools menu array.

---

## Critical Files

- [frontend/src/SqlAdminController.ts](frontend/src/SqlAdminController.ts) — the
  Dock owner; `dock.on("close")` handler (L145), `openStructure`/`openDefinition`
  dedup pattern, top-level `Glyph.register`.
- [frontend/src/shell/SqlAdminShell.ts](frontend/src/shell/SqlAdminShell.ts) —
  `MenuBarActions` and `buildMenuBar` (Tools menu, L318).
- [frontend/src/dock/DefinitionPanel.ts](frontend/src/dock/DefinitionPanel.ts) —
  the `Fit`-hosted read-only panel this factory mirrors.
- [frontend/src/data/queryStore.ts](frontend/src/data/queryStore.ts) — the
  `KeyValueStore` seam and the per-connection store pattern; source of the reused
  `KeyValueStore` type.
- [frontend/src/data/queryStore.test.ts](frontend/src/data/queryStore.test.ts) —
  the `fakeStorage()` test pattern to copy.
- [frontend/src/shell/localStorageWindow.ts](frontend/src/shell/localStorageWindow.ts)
  — confirms the `sqladmin.*` clear/dump surface the notes key joins.
- typescript-ui MarkdownEditor doc:
  `/home/jika/typescript/typescript-ui/docs/components/MarkdownEditor.md`; types:
  `.../dist/lib/types/component/editor/MarkdownEditor.d.ts`.

---

## Non-Goals

- **Source/WYSIWYG toggle** — the `setMode` seam is left unexposed in v1; a
  `ToggleButton` toolbar can add it later without touching persistence.
- **Formatting toolbar** — the command API (`toggleBold`, `setBlockType`, …) is
  not surfaced; Markdown-shortcut typing and keyboard shortcuts suffice for v1.
- **Multiple / named notes documents** — a single per-connection notes buffer,
  matching the singleton tab; a multi-document store is out of scope.
- **Read-only About / prose rendering** — that surface uses the read-only
  `Markdown` viewer and is owned by the parallel markdown-prose plan; this plan
  owns only the editable `MarkdownEditor`.
