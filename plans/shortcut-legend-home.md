---
touches-shared: ["frontend/src/shell/SqlAdminShell.ts"]
---

# Keyboard-Shortcut Legend & Start-Page Home — Implementation Plan

## Overview

Give the app one **source of truth** for its keyboard shortcuts and surface it in two places: a redesigned two-column start-page "home" and a `?`-triggered Keyboard Shortcuts dialog. Today the shortcut display strings are split across two homes — the global Alt-chord constants in [`frontend/src/shell/queryShortcuts.ts`](frontend/src/shell/queryShortcuts.ts) and hand-typed strings scattered through [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts#L148) tooltips (`"Run (Ctrl+Enter)"`, `"Clear (Alt+C)"`, …) — and the start page shows only a flat five-line `keyboardHints()` list ([`StartPage.ts:164`](frontend/src/shell/StartPage.ts#L164)).

This plan:
1. Adds the missing **display-string constants** for the editor and Explain chords to `queryShortcuts.ts` (co-located with their `isXChord` matchers, extending the existing Alt-chord pattern), and a new `HELP_SHORTCUT` + `isHelpChord`.
2. Adds a pure, DOM-less **registry** module (`shortcutRegistry.ts`) that composes those constants into `{ id, keys, label, category, scope }` entries plus a `groupByCategory` helper — unit-testable under the project's node vitest (mirroring how `startPageWelcome.ts` was split from `StartPage.ts`; see [`vitest.config.ts`](frontend/vitest.config.ts)).
3. Adds a rendered **legend component** (`shortcutLegend.ts`) built from structured typescript-ui components.
4. Consumes the legend in two surfaces: the **redesigned StartPage** (two-column home) and a new **`openShortcutsDialog()`** (mirroring [`aboutDialog.ts`](frontend/src/shell/aboutDialog.ts)), reachable via a new `?` global accelerator and a menu-bar button beside About in [`SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts).

Investigated against the Phase-1 tip `feature/schema-diagram-view` (redesigned StartPage + `startPageWelcome.ts`, Markdown `aboutDialog.ts`, CodeEditor `QueryPanel.ts`).

---

## Architecture Decisions

### `queryShortcuts.ts` stays the single source of the key strings; the registry is a view over it

The registry must **not** re-declare the key strings. `queryShortcuts.ts` already owns both the Alt-chord display constants **and** the `isXChord` matchers, and is import-clean (no typescript-ui, no import-scope DOM). So we extend it with the currently-missing display constants (Run/Save/Clear/history/Explain), and the registry *imports those constants* to build its entries. This keeps one string per shortcut. The registry adds only the **display metadata** the keys don't carry — `label`, `category`, `scope` — for grouping and rendering. The `isXChord` helpers remain authoritative for key **matching**; the registry is DISPLAY-only and defines no matching logic.

### QueryPanel tooltips consume the same constants — killing the drift

The QueryPanel tooltip strings (`"Run (Ctrl+Enter)"`, etc.) are replaced by interpolations of the new constants (`` `Run (${RUN_SHORTCUT})` ``). QueryPanel depends only on the plain string constants from `queryShortcuts.ts` — **not** on the registry/legend module (which would drag typescript-ui-rendered UI into a code path that only needs a string). Both the legend and the tooltips therefore read from the same constants: no second source of the keys, and no import cycle.

### Unify on the "Ctrl/Cmd+…" display convention

The constants use the **Ctrl/Cmd** convention (`"Ctrl/Cmd+Enter"`, `"Ctrl/Cmd+S"`, …), which the start page *already* uses in its hand-typed hints (`"Ctrl/Cmd+Enter — run the query"`, [`StartPage.ts:166`](frontend/src/shell/StartPage.ts#L166)). This changes the QueryPanel tooltips from `"Ctrl+Enter"` to `"Ctrl/Cmd+Enter"` — a deliberate, minor consistency improvement (Mac-correct). Matching behaviour is unchanged (the `isXChord`/keydown handlers already accept `ctrlKey || metaKey`).

### The legend renders as structured components, not a Markdown table

`aboutDialog.ts` uses `Markdown` for **prose**. The legend is **tabular** data (keys ⇢ label, grouped by category), so it is built from `Text` + `Grid` instead:
- **Alignment & theming.** A two-column `Grid` (a keys track + a label track) aligns every row's keys column; `Text` + `MUTED_TEXT_COLOR` matches the start page's existing muted styling. Marked's table rendering (GFM) has uncontrolled column widths and unknown theme behaviour.
- **Reuse & embedding.** One `buildShortcutLegend()` Component drops straight into both the start-page column and the dialog, sizing to its host via library layout defaults — no re-parsing a Markdown blob per surface.
- **No disposal burden.** Pure `Text`/`Grid` hold no `ThemeManager` subscription, so — unlike the About Markdown body — the legend needs **no** `dispose()` on the dialog's dismissal or the start page's rebuild. This simplifies both callers.

### The `?` accelerator must be suppressed while the user is typing

Every existing global chord is `Alt+<letter>` — non-printable, so it can never collide with typing. `?` (Shift+/) **is** printable. If the user types `?` in the SQL `CodeEditor` or any text field, the dialog must NOT open and the character must be inserted normally. So `isHelpChord(event)` returns true only when `event.key === "?"` (no Ctrl/Meta/Alt) **and** the event target is not an editable context (`<input>`, `<textarea>`, or inside `[contenteditable]`/`.cm-editor`). Bundling the editable-target guard *inside* `isHelpChord` (not in the caller) makes it impossible for a call site to forget it. Because `installAccelerators` only calls `preventDefault()` on a matched chord, a `?` typed in the editor falls through unmatched and is inserted as normal text.

### Menu surface: a trailing button beside About

The About affordance is a **trailing `Button`** appended to the menu bar after the `menus` factory ([`SqlAdminShell.ts:362`](frontend/src/shell/SqlAdminShell.ts#L362)), not a dropdown item. To sit "next to About", the Keyboard Shortcuts affordance mirrors that exact pattern: a flat compact `Button({ glyph: "keyboard", text: "Shortcuts" })` appended immediately **before** the About button. This reuses the established wiring rather than inventing a Help menu.

---

## Public API

New/changed exported symbols.

```ts
// frontend/src/shell/queryShortcuts.ts — NEW display constants (plain strings)
export const RUN_SHORTCUT: string;             // "Ctrl/Cmd+Enter"
export const SAVE_SHORTCUT: string;            // "Ctrl/Cmd+S"
export const CLEAR_SHORTCUT: string;           // "Alt+C"
export const OLDER_QUERY_SHORTCUT: string;     // "Ctrl/Cmd+↑"   (Older toolbar button tooltip)
export const NEWER_QUERY_SHORTCUT: string;     // "Ctrl/Cmd+↓"   (Newer toolbar button tooltip)
export const HISTORY_RECALL_SHORTCUT: string;  // "Ctrl/Cmd+↑ / ↓" (combined, legend single entry)
export const EXPLAIN_SHORTCUT: string;         // "Ctrl/Cmd+E"
export const EXPLAIN_ANALYZE_SHORTCUT: string; // "Ctrl/Cmd+Shift+E"
export const HELP_SHORTCUT: string;            // "?"

// frontend/src/shell/queryShortcuts.ts — NEW matcher
/** Whether a keydown is the Help chord (?), and focus is NOT in an editable field. */
export function isHelpChord(event: KeyboardEvent): boolean;

// frontend/src/shell/shortcutRegistry.ts — NEW (pure data + grouping; no typescript-ui import)
export type ShortcutCategory = "editor" | "query" | "navigation";
export type ShortcutScope = "editor" | "global";

export interface ShortcutEntry {
    /** Stable id (e.g. "run", "new-query"). */
    id: string;
    /** Display key string, Ctrl/Cmd convention (from queryShortcuts constants). */
    keys: string;
    /** Human label ("Run the query"). */
    label: string;
    /** Display grouping. */
    category: ShortcutCategory;
    /** Where the key is actually bound (documentation only). */
    scope: ShortcutScope;
}

export interface ShortcutGroup {
    category: ShortcutCategory;
    /** Human heading for the category ("Editor" / "Query" / "Navigation"). */
    title: string;
    entries: ShortcutEntry[];
}

/** Every app shortcut, source of truth for the legend. */
export const SHORTCUTS: readonly ShortcutEntry[];

/** Group SHORTCUTS by category in canonical order Editor → Query → Navigation. */
export function groupByCategory(entries?: readonly ShortcutEntry[]): ShortcutGroup[];

// frontend/src/shell/shortcutLegend.ts — NEW (rendered component)
/** Build the keyboard-shortcut legend: category headings over keys⇢label grids. */
export function buildShortcutLegend(): Component;

// frontend/src/shell/shortcutsDialog.ts — NEW (dialog)
/** Open the modal Keyboard Shortcuts dialog (dismiss-only). */
export function openShortcutsDialog(): void;
```

---

## Internal Structure

### `shortcutRegistry.ts` — the 14 entries

All 13 existing shortcuts plus the new Help chord. `keys` values reference `queryShortcuts.ts` constants (never literals). `title` per category: `editor → "Editor"`, `query → "Query"`, `navigation → "Navigation"`.

| id | keys constant | label | category | scope |
|---|---|---|---|---|
| `run` | `RUN_SHORTCUT` | Run the query | editor | editor |
| `save` | `SAVE_SHORTCUT` | Save the query | editor | editor |
| `clear` | `CLEAR_SHORTCUT` | Clear the editor | editor | editor |
| `history-recall` | `HISTORY_RECALL_SHORTCUT` | Browse query history | editor | editor |
| `explain` | `EXPLAIN_SHORTCUT` | Explain the statement | editor | editor |
| `explain-analyze` | `EXPLAIN_ANALYZE_SHORTCUT` | Explain Analyze the statement | editor | editor |
| `new-query` | `NEW_QUERY_SHORTCUT` | New query | query | global |
| `open-saved` | `OPEN_SAVED_SHORTCUT` | Open saved queries | query | global |
| `query-history` | `QUERY_HISTORY_SHORTCUT` | Query history | query | global |
| `databases-rail` | `DATABASES_RAIL_SHORTCUT` | Databases rail | navigation | global |
| `roles-rail` | `ROLES_RAIL_SHORTCUT` | Roles rail | navigation | global |
| `queries-rail` | `QUERIES_RAIL_SHORTCUT` | Queries rail | navigation | global |
| `refresh` | `REFRESH_SHORTCUT` | Refresh the active view | navigation | global |
| `help` | `HELP_SHORTCUT` | Keyboard shortcuts | navigation | global |

`groupByCategory` iterates a fixed category order `["editor", "query", "navigation"]`, filtering `SHORTCUTS` per category, skipping any empty group, and returning `{ category, title, entries }`. Pure; no typescript-ui import.

### `queryShortcuts.ts` — `isHelpChord` + editable-target guard

```ts
/** Whether the keydown target is a text-editing context that should keep printable keys. */
function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    const tag = target.tagName;

    return tag === "INPUT"
        || tag === "TEXTAREA"
        || target.isContentEditable
        || target.closest(".cm-editor") !== null; // CodeMirror (CodeEditor) root
}

/**
 * Whether a keydown is the Help chord (?). Guards against firing while the user
 * is typing: ? is printable (Shift+/), so — unlike the Alt chords — it must be
 * ignored when focus is in an input/textarea/CodeEditor, or it would swallow a
 * literal ? the user meant to type.
 */
export function isHelpChord(event: KeyboardEvent): boolean {
    return !event.ctrlKey
        && !event.metaKey
        && !event.altKey
        && event.key === "?"
        && !isEditableTarget(event.target);
}
```
`HTMLElement` and `.closest` are referenced only inside function bodies, so the module has **no import-scope DOM access** and stays safe to import from the node-run registry test.

### `shortcutLegend.ts` — structured render

`buildShortcutLegend()` returns a `Panel` with a `VBox({ stretching: true })`. For each `ShortcutGroup` from `groupByCategory()`:
- a bold muted heading `Text(group.title, { fontWeight: "600" })` (foreground `MUTED_TEXT_COLOR`),
- a `Grid({ columns: 2, columnTracks: [{ mode: "content" }, { mode: "weight", value: 1 }] })` whose flattened cells are, per entry: a keys `Text(entry.keys)` then a label `Text(entry.label)` (label muted). Auto-flow tiles two cells per row (see the Grid usage in [`FilterDialog.ts:219`](frontend/src/dock/FilterDialog.ts#L219)).

Lean on library default spacing; only add small documented constants for the group gap if the default reads too tight. No `dispose` (pure Text/Grid).

### `shortcutsDialog.ts` — mirrors `aboutDialog.ts`

Same shape as [`aboutDialog.ts`](frontend/src/shell/aboutDialog.ts), minus the Markdown disposal:
```ts
export function openShortcutsDialog(): void {
    const content = Panel({
        layoutManager: new VBox({ stretching: true }),
        insets       : new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
    });
    content.addComponent(buildShortcutLegend());

    const dialog = Dialog({
        title           : "Keyboard Shortcuts",
        contentComponent: content,
        buttons         : [DialogButtons.Close],
        width           : DIALOG_WIDTH,       // fixed width; Dialog measures height at it
        closeOnBackdrop : true,
    });

    void dialog.show(); // no dispose needed — the legend holds no subscriptions
}
```

### `StartPage.ts` — two-column home

Replace the single flat `VBox` with a full-width header over a two-column body, preserving the existing rebuild/gating machinery:

- **Header (full width, above the columns):** the `"SQL Admin"` heading, and — gated on `shouldShowWelcome(controller)` — the transient welcome `Markdown` (unchanged gating; still disposed before each rebuild).
- **Left column** (`VBox`): the `"New Query"` action button, then the Recent tables and Saved queries lists (unchanged `appendList` + `actionButton` calls, same handlers/interactivity).
- **Right column** (`VBox`): the shortcut legend (`buildShortcutLegend()`) and the Connection heading + `mutedText(controller.connectionId)`.

The two columns sit in a container laid out with `HBox` (both from the existing layout imports; `HBox` is used in [`localStorageWindow.ts:20`](frontend/src/shell/localStorageWindow.ts#L20)). Keep the page `overflow: "auto"`.

`rebuild()` keeps its structure: dispose+null the welcome, `removeAllComponents()`, re-add header, re-build both columns, `doLayout()`. The legend is rebuilt each pass (cheap, no disposables). **Remove** the old `keyboardHints()` function, its `"Keyboard"` heading + loop, and the now-unused `NEW_QUERY_SHORTCUT`/`OPEN_SAVED_SHORTCUT`/`QUERY_HISTORY_SHORTCUT` imports (the legend replaces them).

---

## Ordered Implementation Steps

1. **`frontend/src/shell/queryShortcuts.ts`** — add the display constants (`RUN_SHORTCUT`, `SAVE_SHORTCUT`, `CLEAR_SHORTCUT`, `OLDER_QUERY_SHORTCUT`, `NEWER_QUERY_SHORTCUT`, `HISTORY_RECALL_SHORTCUT`, `EXPLAIN_SHORTCUT`, `EXPLAIN_ANALYZE_SHORTCUT`, `HELP_SHORTCUT`) with the Ctrl/Cmd convention, JSDoc each. Add the private `isEditableTarget` and exported `isHelpChord` (see Internal Structure). Update the file header comment to note the editor chords and Help now live here too.
2. **`frontend/src/shell/shortcutRegistry.ts`** (new) — define `ShortcutCategory`, `ShortcutScope`, `ShortcutEntry`, `ShortcutGroup`, the `SHORTCUTS` array (import the key constants from `queryShortcuts.ts`), and `groupByCategory`. No typescript-ui import.
3. **`frontend/src/shell/shortcutRegistry.test.ts`** (new) — unit tests (see Expected Behaviour): registry covers all 14 ids; every `keys` is non-empty; `groupByCategory` returns the three groups in Editor→Query→Navigation order with the right counts; category order is stable.
4. **`frontend/src/shell/shortcutLegend.ts`** (new) — `buildShortcutLegend()` per Internal Structure. `Glyph.register` not needed (no glyphs). Import `Text` from `component/input`, `Grid`/`VBox` from `layout`, `Panel` from `core`, `MUTED_TEXT_COLOR` from `../theme`, `groupByCategory` from `./shortcutRegistry`.
5. **`frontend/src/shell/shortcutsDialog.ts`** (new) — `openShortcutsDialog()` mirroring `aboutDialog.ts` (see Internal Structure). `DIALOG_WIDTH`/`CONTENT_PAD` documented constants.
6. **`frontend/src/dock/QueryPanel.ts`** — import the new constants; replace the hand-typed tooltip strings: `"Run (Ctrl+Enter)"` → `` `Run (${RUN_SHORTCUT})` ``, `"Save query (Ctrl+S)"` → `` `Save query (${SAVE_SHORTCUT})` ``, `"Clear (Alt+C)"` → `` `Clear (${CLEAR_SHORTCUT})` ``, `"Explain (Ctrl+E)"` → `` `Explain (${EXPLAIN_SHORTCUT})` ``, the Explain-Analyze tooltip's first line → `` `Explain Analyze (${EXPLAIN_ANALYZE_SHORTCUT})` `` (keep its `"\n\nexecutes the statement"` suffix), `"Older query (Ctrl+↑)"` → `` `Older query (${OLDER_QUERY_SHORTCUT})` ``, `"Newer query (Ctrl+↓)"` → `` `Newer query (${NEWER_QUERY_SHORTCUT})` ``. Do **not** touch the keydown handler's matching logic — only the tooltip display strings.
7. **`frontend/src/shell/StartPage.ts`** — redesign to the two-column home (see Internal Structure): add `HBox` to the layout import, `buildShortcutLegend` import; remove `keyboardHints()`, the Keyboard heading/loop, and the three now-unused shortcut-constant imports. Preserve `onWorkspaceChanged(rebuild)`, `shouldShowWelcome` gating, welcome dispose-before-rebuild, and all action/list handlers.
8. **`frontend/src/shell/SqlAdminShell.ts`** — register the `keyboard` glyph (add `import { keyboard } from "@jimka/typescript-ui/glyphs/solid/keyboard"` and add to the menu-bar `Glyph.register(...)` line). Import `isHelpChord` from `queryShortcuts` and `openShortcutsDialog` from `./shortcutsDialog`. In `installAccelerators`, add an `else if (isHelpChord(event)) { openShortcutsDialog(); }` branch (before the `else { matched = false; }`). In `buildMenuBar`, add `onShowShortcuts: () => void` to `MenuBarActions`, wire it from `SqlAdminShell` to `openShortcutsDialog`, and append a `Button({ glyph: "keyboard", text: "Shortcuts", showText: true, showDescription: false, compact: true, flat: true })` (action → `onShowShortcuts`) immediately before the About button append.
9. **Checkpoint greps:**
   - `grep -rn "Ctrl+Enter\|Ctrl+S)\|Alt+C)\|Ctrl+E)\|Ctrl+↑\|Ctrl+↓" frontend/src/dock/QueryPanel.ts` — expect zero (all now interpolated).
   - `grep -rn "keyboardHints" frontend/src/` — expect zero.
   - `grep -rn "NEW_QUERY_SHORTCUT\|OPEN_SAVED_SHORTCUT\|QUERY_HISTORY_SHORTCUT" frontend/src/shell/StartPage.ts` — expect zero.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/shell/shortcutRegistry.ts` |
| Create | `frontend/src/shell/shortcutRegistry.test.ts` |
| Create | `frontend/src/shell/shortcutLegend.ts` |
| Create | `frontend/src/shell/shortcutsDialog.ts` |
| Modify | `frontend/src/shell/queryShortcuts.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/src/shell/StartPage.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` (shared with the Phase-2 documentation-panel plan) |

---

## Expected Behaviour

**Unit-testable (`shortcutRegistry.test.ts`, node env):**
- `SHORTCUTS` contains exactly the 14 ids in the registry table; no duplicate ids.
- Every entry's `keys` and `label` are non-empty strings.
- Each entry's `keys` equals the corresponding `queryShortcuts` constant (e.g. the `run` entry's keys `=== RUN_SHORTCUT`) — pins that the registry references constants, not literals.
- `groupByCategory()` returns 3 groups in order `["editor","query","navigation"]` with entry counts 6 / 3 / 5 and titles `"Editor"`/`"Query"`/`"Navigation"`.
- `groupByCategory([])` returns `[]` (empty groups skipped).

**Unit-testable (`queryShortcuts` — optional `isHelpChord` coverage, node env):** `isHelpChord` needs a `KeyboardEvent`-like object with `.key`/modifier/`.target`; a plain object with `target: null` and `key: "?"` returns `true`, `key: "a"` returns `false`, and any of ctrl/meta/alt set returns `false`. (The editable-target branch needs a DOM element, so cover only the modifier/key logic in node; verify the typing-guard manually.)

**Manual verification (UI, not automatable):**
- Start page renders two columns: left = New Query + Recent/Saved lists; right = shortcut legend + Connection. Welcome blurb still shows only on an empty workspace, above the columns.
- Opening a table/query then closing all tabs rebuilds the start page with the updated lists (the `onWorkspaceChanged` path); action buttons still open queries/tables.
- Pressing `?` with focus on the body/start page/a list opens the Keyboard Shortcuts dialog; Escape/Close/backdrop dismisses it.
- Typing `?` inside the SQL editor or a text field inserts a literal `?` and does **not** open the dialog.
- The menu-bar "Shortcuts" button (beside About) opens the same dialog.
- QueryPanel toolbar tooltips read `"Run (Ctrl/Cmd+Enter)"`, `"Clear (Alt/C)"` etc., matching the legend's key strings.

---

## Verification

- `cd frontend && npx tsc --noEmit` — clean.
- `cd frontend && npx vitest run src/shell/shortcutRegistry.test.ts` — green.
- The checkpoint greps in step 9.
- Manual smoke: `npm run dev`, exercise the start page, the `?` chord (in and out of the editor), and the menu button per Expected Behaviour.
- (Worktree tooling needs the node_modules symlink: `ln -sfn /home/jika/typescript/sqladmin/frontend/node_modules <worktree>/frontend/node_modules`.)

---

## Potential Challenges

- **`?` swallowing typed characters** — mitigated by the `isEditableTarget` guard inside `isHelpChord` and by only `preventDefault()`-ing matched chords; verify manually in the CodeEditor (`.cm-editor`) and a plain text field.
- **Grid two-column alignment across groups** — each group has its own Grid, so keys columns align within a group but may differ across groups if key strings vary widely; acceptable, and per-group grids keep headings clean. If cross-group alignment is wanted later, a single Grid with heading rows is the fallback (not needed now).
- **StartPage column balance** — the right column (legend) is taller than a sparse left column on an empty workspace; use `HBox` weights and top-anchored columns so it reads as a home, not a stretched split. Tune weights during manual verify.
- **Import-scope DOM in the registry test** — the registry must import only the string constants from `queryShortcuts.ts`; that module has no import-scope DOM (DOM refs live inside `isHelpChord`/`isEditableTarget` bodies), so the node test stays safe.

---

## Critical Files

- [`frontend/src/shell/queryShortcuts.ts`](frontend/src/shell/queryShortcuts.ts) — existing constants + `isXChord` pattern to extend.
- [`frontend/src/shell/aboutDialog.ts`](frontend/src/shell/aboutDialog.ts) — the Dialog + Panel + fixed-width pattern to mirror.
- [`frontend/src/shell/StartPage.ts`](frontend/src/shell/StartPage.ts) — rebuild/gating machinery to preserve.
- [`frontend/src/shell/startPageWelcome.ts`](frontend/src/shell/startPageWelcome.ts) + [`frontend/src/shell/startPageWelcome.test.ts`](frontend/src/shell/startPageWelcome.test.ts) — the split-for-testability precedent to follow for `shortcutRegistry`.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts#L148) — tooltip strings + keydown handler (matching logic stays).
- [`frontend/src/shell/SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts#L129) — `installAccelerators` and `buildMenuBar`/About wiring.
- [`frontend/src/dock/FilterDialog.ts`](frontend/src/dock/FilterDialog.ts#L219) — `Grid` `columnTracks` usage reference.
- [`frontend/vitest.config.ts`](frontend/vitest.config.ts) — node env; why the registry must be DOM-less.

---

## Non-Goals

- **Rebinding or remapping keys / user-configurable shortcuts** — the registry is display-only; matching stays in the `isXChord` helpers.
- **A per-OS (Mac vs Windows) rendered key string** — the "Ctrl/Cmd" convention is a single static string, matching the app's existing hints.
- **Making QueryPanel depend on the registry/legend module** — tooltips consume the plain constants only, to avoid pulling UI rendering into the panel and to prevent an import cycle.
- **A Help top-level menu** — the Shortcuts affordance is a trailing button beside About, reusing the existing pattern.
