---
depends-on: [query-error-position-reveal]
touches-shared:
  - frontend/src/dock/QueryPanel.ts
  - frontend/src/SqlAdminController.ts
  - frontend/src/controller/panelHost.ts
  - frontend/src/controller/queryWorkspace.ts
  - frontend/src/textFormat.ts
  - README.md
---

# Editor Selection Status — Implementation Plan

## Overview

Show the query editor's caret position and selection size in the status bar, for example `Ln 12, Col 4` or `Ln 14, Col 3 (15 chars, 2 lines selected)`. The readout is a `Text` in the status bar's right zone, left of the signed-in identity badge. It is visible only while the active dock tab is a query panel, and it follows the dock's active tab.

The data comes from typescript-ui's `CodeEditor`. `getCursorPosition()` and the `"cursorchange"` event (0.9.0) give the caret's 1-based `{ line, column, offset }`. `getSelection()` and the `"selectionchange"` event (0.10.0) give the primary selection's `{ characterCount, lineCount }` — counts only, never the selected text ([CodeEditor.ts:57-99](../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L57), [1188-1216](../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L1188)). typescript-ui 0.10.0 is released. The main tree's `frontend/node_modules/@jimka/typescript-ui` symlinks the local library checkout, which serves the same 0.10.0 code; `package.json` keeps `^0.9.0`, and this plan does not touch it. The range moves in the manual dependency swap the user runs by hand (see `typescript-ui-0-10-0-upgrade.md`, Addendum: Post-release swap).

Four files change. [QueryPanel.ts](frontend/src/dock/QueryPanel.ts) listens to both editor events and reports a formatted string through a new `onCaretChange` option. [queryWorkspace.ts](frontend/src/controller/queryWorkspace.ts#L115) forwards it with the panel id to a new `PanelHost.setCaretReadout`. [SqlAdminController.ts](frontend/src/SqlAdminController.ts) stores one readout per panel id and shows the active panel's. The pure formatter `formatCaretReadout` goes in [textFormat.ts](frontend/src/textFormat.ts).

---

## Architecture Decisions

### Per-panel state keyed by id, shown for the active panel — mirrors `setActiveExport`

The query panel pushes its readout up through an injected callback. The controller keeps a `Map<string, string>` by panel id, and the dock `"focus"` handler decides which entry is shown. This is the same shape as the menubar export: `onResult` → [`setActiveExport(id, active)` (SqlAdminController.ts:693)](frontend/src/SqlAdminController.ts#L693) → `_activeQueryResult` read through `_activePanelId`. It also copies [`recordQueryRun` (SqlAdminController.ts:684)](frontend/src/SqlAdminController.ts#L684): a report for the already-active panel refreshes the display at once, without waiting for a `"focus"` event.[^precedent]

### A persistent right-zone `Text`, not `status()` messages

The readout is its own `Text` widget, added with `statusBar.addRight` before the identity badge. It is not written through `status()` / `setMessage`.[^right-zone] Right-zone order becomes: caret readout, identity badge, notification-history button. The `Text` uses library defaults (no font, size, or color overrides), like the identity badge's `new Text(username)`.

### Hidden, not blanked, when the active tab is not a query panel

`syncCaretReadout()` sets the text and calls `setDisplayed(readout !== undefined)`. A non-query tab, no focused tab (`"focus"` with `null`), and a just-closed query tab all hide the widget.[^hide-not-blank]

### The readout `Text` opts out of the status bar's live region

`StatusBar` marks the whole strip `aria-live="polite"` ([StatusBar.ts:145-146](../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts#L145)). The readout `Text` sets `getAria().setLive("off")`, so a screen reader does not announce the caret position on every keystroke and arrow press.[^aria-off]

### Format — `Ln L, Col C`, plus a `(… selected)` suffix only when characters are selected

`formatCaretReadout(caret, selection)` in `textFormat.ts` builds the string. The line count appears only for a selection spanning more than one line. `char` is singular only for exactly 1.

| caret `{line, column}` | selection `{characterCount, lineCount}` | Readout |
|---|---|---|
| `{1, 1}` | `{0, 1}` | `Ln 1, Col 1` |
| `{3, 9}` | `{1, 1}` | `Ln 3, Col 9 (1 char selected)` |
| `{3, 9}` | `{5, 1}` | `Ln 3, Col 9 (5 chars selected)` |
| `{14, 3}` | `{15, 2}` | `Ln 14, Col 3 (15 chars, 2 lines selected)` |
| `{2, 1}` | `{0, 2}` | `Ln 2, Col 1` (no characters, so no suffix whatever `lineCount` says) |

The numbers are the library's own, unconverted. `column` and `characterCount` are UTF-16 units (an emoji counts 2), a tab counts as 1 column, and the caret is the selection's moving end.[^library-units] The column matches the `(line X, column Y)` suffix that `query-error-position-reveal` adds to the error banner, since both count UTF-16 columns from 1.

### The formatter takes structural types, so `textFormat.ts` stays library-free

`formatCaretReadout` declares its parameters as inline `{ line: number; column: number }` and `{ characterCount: number; lineCount: number }` object types. The library's `CodeEditorCursorPosition` and `CodeEditorSelection` pass straight in (the extra `offset` field is allowed). `textFormat.ts` keeps its header promise of importing nothing from the library.[^home]

### One reporter, called from both events and once at construction

QueryPanel adds one local function, `reportCaret()`, that reads `editor.getCursorPosition()` and `editor.getSelection()` live and calls `onCaretChange?.(formatCaretReadout(...))`. It is registered for `"cursorchange"` and `"selectionchange"`, and called once right after registration. That first call reports `Ln 1, Col 1` from the library's pre-mount defaults. The `onFirstLayout` `moveCursorToEnd()` on a seeded panel then fires `"cursorchange"` with the real position.[^one-reporter]

### Cleanup is the Dock's and the library's; the controller deletes its map entry on `"close"`

The two editor listeners need no `off()`. `CodeEditor` registers its listener bag with `registerListenerBag`, which clears it on destroy ([Component.ts:1126-1130](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L1126)), and the Dock destroys the editor when the tab closes. The listeners point from the editor to the controller, never back. The controller's dock `"close"` handler deletes the panel's `_caretReadouts` entry beside the other per-panel maps, then calls `syncCaretReadout()`.[^cleanup]

### Query panels only

Only `QueryPanel`'s main editor reports. The read-only Explain-plan `CodeEditor` in the result pane, the definition editors, `SqlPreviewDialog`, and `DocumentationPanel` do not.[^scope]

### Depends on `query-error-position-reveal`

Both plans edit `QueryPanel.ts`, in different places. That plan lands first. This plan's manual checks also cover the interplay: a reveal selects the error token, and the readout reports that selection.[^order]

---

## Public API

App-internal only; no library change.

[frontend/src/textFormat.ts](frontend/src/textFormat.ts):

```ts
/**
 * The status bar's caret readout: `Ln 12, Col 4`, plus `(N char(s)[, M lines] selected)`
 * when the selection holds characters.
 */
export function formatCaretReadout(
    caret: { line: number; column: number },
    selection: { characterCount: number; lineCount: number },
): string;
```

[frontend/src/dock/QueryPanel.ts](frontend/src/dock/QueryPanel.ts#L132) — `QueryPanelOptions` gains:

```ts
/**
 * Called with the editor's caret/selection readout (see formatCaretReadout)
 * whenever the caret moves or the selection's size changes, and once at
 * construction. The controller shows it in the status bar while this panel
 * is the active tab.
 */
onCaretChange?: (readout: string) => void;
```

[frontend/src/controller/panelHost.ts](frontend/src/controller/panelHost.ts#L118) — `PanelHost` gains, right after `setActiveExport`:

```ts
/** Record a query panel's caret readout, shown in the status bar while it is the active panel. */
setCaretReadout(id: string, readout: string): void;
```

[frontend/src/SqlAdminController.ts](frontend/src/SqlAdminController.ts) — new private state and one private method:

```ts
// Each query panel's latest caret readout, keyed by panel id — shown by
// syncCaretReadout while that panel is the active one.
private readonly _caretReadouts: Map<string, string> = new Map();
// The status bar's right-zone caret readout; hidden while the active panel has none.
private readonly _caretReadoutText: Text;

setCaretReadout(id: string, readout: string): void;   // PanelHost
private syncCaretReadout(): void;
```

---

## Implementation

### `formatCaretReadout` (textFormat.ts)

```ts
export function formatCaretReadout(
    caret: { line: number; column: number },
    selection: { characterCount: number; lineCount: number },
): string {
    const position = `Ln ${caret.line}, Col ${caret.column}`;

    if (selection.characterCount === 0) {
        return position;
    }

    const chars = selection.characterCount === 1 ? "1 char" : `${selection.characterCount} chars`;
    const lines = selection.lineCount > 1 ? `, ${selection.lineCount} lines` : "";

    return `${position} (${chars}${lines} selected)`;
}
```

### QueryPanel wiring (after the existing `editor.on("change", …)` at [QueryPanel.ts:1254](frontend/src/dock/QueryPanel.ts#L1254))

```ts
/** Report the editor's caret line/column and selection size to the status bar. */
function reportCaret(): void {
    onCaretChange?.(formatCaretReadout(editor.getCursorPosition(), editor.getSelection()));
}

// Keep the status bar's caret readout current. Both events are needed: a
// select-all with the caret already at the end changes the selection without
// moving the caret. The first report shows the pre-mount default (Ln 1, Col 1);
// the onFirstLayout moveCursorToEnd below fires "cursorchange" with the real one.
editor.on("cursorchange", reportCaret);
editor.on("selectionchange", reportCaret);
reportCaret();
```

Add `onCaretChange` to the options destructuring at [QueryPanel.ts:238](frontend/src/dock/QueryPanel.ts#L238), and `import { formatCaretReadout } from "../textFormat";` to the import block.

### Workspace forwarding ([queryWorkspace.ts:133](frontend/src/controller/queryWorkspace.ts#L133))

Right after the `onResult` entry:

```ts
// Mirror the editor's caret/selection readout to the status bar while
// this panel is the active tab.
onCaretChange: (readout: string) => this.host.setCaretReadout(id, readout),
```

### Controller

Constructor, directly after `this.statusBar = new StatusBar();`:

```ts
this._caretReadoutText = new Text("");
this._caretReadoutText.setDisplayed(false);
// The status bar is one polite live region; the caret readout changes on
// every keystroke, so it opts out rather than flooding a screen reader.
this._caretReadoutText.getAria().setLive("off");
```

Status-bar setup: immediately **before** the `if (username) { this.statusBar.addRight(buildIdentityWidget(...)); }` block ([SqlAdminController.ts:318-323](frontend/src/SqlAdminController.ts#L318)):

```ts
// The active query panel's caret readout sits first in the right zone, left
// of the identity badge (the zone's HBox lays out left-to-right).
this.statusBar.addRight(this._caretReadoutText);
```

`"close"` handler ([SqlAdminController.ts:220-227](frontend/src/SqlAdminController.ts#L220)): after `this._queryPanelRuns.delete(e.id);` add `this._caretReadouts.delete(e.id);`, and as the handler's last statement add `this.syncCaretReadout();`.

`"focus"` handler ([SqlAdminController.ts:262-270](frontend/src/SqlAdminController.ts#L262)): add `this.syncCaretReadout();` next to `this.syncAddressBarFor(e ? e.id : null);`, after the if/else. Extend the handler's leading comment ("Switching tabs syncs the navigator selection and the status bar…") to say the caret readout follows too.

New methods, placed right after `setActiveExport`:

```ts
/**
 * Record a query panel's caret readout, and show it at once when `id` is
 * the active panel — the caret moves while its tab stays focused, so no
 * "focus" event follows (PanelHost).
 */
setCaretReadout(id: string, readout: string): void {
    this._caretReadouts.set(id, readout);

    if (id === this._activePanelId) {
        this.syncCaretReadout();
    }
}

/**
 * Show the active panel's caret readout in the status bar's right zone, or
 * hide the widget when the active panel has none (a non-query tab, or no tab).
 */
private syncCaretReadout(): void {
    const id      = this._activePanelId;
    const readout = id === null ? undefined : this._caretReadouts.get(id);

    this._caretReadoutText.setText(readout ?? "");
    this._caretReadoutText.setDisplayed(readout !== undefined);
}
```

`Text` is already imported in SqlAdminController.ts (line 16).

---

## Ordered Implementation Steps

1. **Worktree prep.** Symlink `frontend/node_modules` to the main tree's (`ln -s /home/jika/typescript/sqladmin/frontend/node_modules <worktree>/frontend/node_modules`). Check: `readlink -f <worktree>/frontend/node_modules/@jimka/typescript-ui` ends in `typescript-ui/packages/lib`, and its `package.json` says `"version": "0.10.0"`. Confirm `query-error-position-reveal` is in `plans/implemented/`.
2. **Tests first (red).** Add a `describe("formatCaretReadout")` block to [tests/textFormat.test.ts](frontend/tests/textFormat.test.ts) with cases U1–U7. `cd frontend && npm test -- textFormat` → fails (no export).
3. **`frontend/src/textFormat.ts`.** Add `formatCaretReadout` with a JSDoc covering the format and that the numbers are passed through unconverted. Keep the header comment true (no library import). `npm test -- textFormat` → green.
4. **`frontend/src/controller/panelHost.ts`.** Add `setCaretReadout` to `PanelHost` after `setActiveExport`. `npm run typecheck` now fails in SqlAdminController.ts (does not implement it) — expected.
5. **`frontend/src/SqlAdminController.ts`.** Add the two fields, the constructor lines, the `addRight` call, the `"close"` and `"focus"` additions, and the two methods, all as in *Implementation → Controller*. `npm run typecheck` → green.
6. **`frontend/src/dock/QueryPanel.ts`.** Add the `onCaretChange` option (after `onResult` in `QueryPanelOptions`), the destructuring entry, the import, and the `reportCaret` block. Add one sentence to the header comment as its own short paragraph after the "Two toolbar buttons run EXPLAIN…" paragraph: the editor reports its caret line/column and selection size through `onCaretChange`, which the controller shows in the status bar. Do not touch `run()`, `runExplainRun()`, or the "Errors funnel…" paragraph that `query-error-position-reveal` edited. Check: `grep -n 'on("cursorchange"\|on("selectionchange"' frontend/src/dock/QueryPanel.ts` → exactly two matches.
7. **`frontend/src/controller/queryWorkspace.ts`.** Add the `onCaretChange` entry after `onResult`. Check: `grep -rn "setCaretReadout" frontend/src` → matches only in panelHost.ts (the declaration), SqlAdminController.ts (the method), and queryWorkspace.ts (one call).
8. **Full checks.** `cd frontend && npm run typecheck && npm test`.
9. **README.** In the "SQL workspace" Highlights bullet ([README.md:53](README.md#L53)), add: "The status bar shows the query editor's line and column, and the size of the current selection."
10. **Manual verification** — M1–M10 below, in the running app against the linked 0.10.0 build (the `verify` skill drives it).

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/src/textFormat.ts` |
| Modify | `frontend/tests/textFormat.test.ts` |
| Modify | `frontend/src/controller/panelHost.ts` |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/src/controller/queryWorkspace.ts` |
| Modify | `README.md` |

---

## Expected Behaviour

### Unit-testable (vitest, node) — `formatCaretReadout`

| # | caret | selection | Expected |
|---|---|---|---|
| U1 | `{ line: 1, column: 1 }` | `{ characterCount: 0, lineCount: 1 }` | `"Ln 1, Col 1"` |
| U2 | `{ line: 12, column: 4 }` | `{ characterCount: 0, lineCount: 1 }` | `"Ln 12, Col 4"` |
| U3 | `{ line: 3, column: 9 }` | `{ characterCount: 1, lineCount: 1 }` | `"Ln 3, Col 9 (1 char selected)"` |
| U4 | `{ line: 3, column: 9 }` | `{ characterCount: 5, lineCount: 1 }` | `"Ln 3, Col 9 (5 chars selected)"` |
| U5 | `{ line: 14, column: 3 }` | `{ characterCount: 15, lineCount: 2 }` | `"Ln 14, Col 3 (15 chars, 2 lines selected)"` |
| U6 | `{ line: 2, column: 1 }` | `{ characterCount: 0, lineCount: 2 }` | `"Ln 2, Col 1"` |
| U7 | `{ line: 2, column: 1, offset: 9 }` (a `CodeEditorCursorPosition`-shaped object) | `{ characterCount: 1, lineCount: 2 }` | `"Ln 2, Col 1 (1 char, 2 lines selected)"` — extra fields are ignored; a selection of just a line break spans 2 lines |

### Manual verification (focus, events, layout, screen reader — not unit-testable)

| # | Steps | Expected |
|---|---|---|
| M1 | Open a new query tab | Right zone reads `Ln 1, Col 1`, left of the user badge. |
| M2 | Type `SELECT 1` | Readout ends at `Ln 1, Col 9`, updating per keystroke. |
| M3 | Shift+Home | `Ln 1, Col 1 (8 chars selected)`. |
| M4 | Type a second line, then Ctrl+A with the caret already at the document end | Readout changes to `(… chars, 2 lines selected)` even though the caret did not move. |
| M5 | Open a saved query ("Open query") | Readout shows the caret at the end of the seeded text, not `Ln 1, Col 1`. |
| M6 | Open a table's Data tab, then switch back to the query tab | Readout hidden on the table tab (no gap left beside the badge), and back with the query tab's last position on return. |
| M7 | Two query tabs with different caret positions; switch between them | Each tab's own position is shown. |
| M8 | Close the active query tab while another query tab remains; then close the last tab | Readout switches to the survivor's position; with no tab left it is hidden. |
| M9 | Tear a query tab out into a float, click into it and type | Readout follows the float's editor. |
| M10 | Run `SELEC 1` (after `query-error-position-reveal` has landed) | The reveal selects `SELEC`; readout shows `Ln 1, Col 6 (5 chars selected)` (the caret is the selection's end). Typing a character clears it to a caret position. |

Also check once with a screen reader, or in DevTools' accessibility pane: the readout element has `aria-live="off"`, and moving the caret is not announced.

---

## Verification

- `cd frontend && npm run typecheck && npm test` — green, including U1–U7.
- `grep -n 'on("cursorchange"\|on("selectionchange"' frontend/src/dock/QueryPanel.ts` → two matches.
- `grep -rn "_caretReadouts" frontend/src/SqlAdminController.ts` → the field, the `"close"` delete, `setCaretReadout`, and `syncCaretReadout`.
- `git diff --stat frontend/package.json` → no change.
- Manual M1–M10 in the running app.

---

## Documentation Impact

No library or exported-API docs. In-repo only: the README "SQL workspace" bullet (step 9), QueryPanel's header comment (step 6), and the `"focus"` handler comment in SqlAdminController.ts (step 5).

---

## Potential Challenges

- **Typecheck fails on `getSelection` / `"selectionchange"`.** Those exist only in 0.10.0, and `package.json` still names `^0.9.0`. Confirm the symlink (step 1) first; do not bump `package.json`.
- **The readout changes width as digits grow.** `Ln 9` → `Ln 10` widens the `Text` by one digit, and the flex spacer absorbs it, so the badge and history button shift left slightly. Accepted; a fixed-width slot would mean a hardcoded size.
- **A hidden right-zone child might still take the 4px row spacing.** If M6 shows a gap beside the badge, that is a `StatusBar`/`HBox` defect. Record it in `LIBRARY_NOTES.md` for a library fix rather than padding around it in the app.
- **An editor event after the tab closed** would re-add a `_caretReadouts` entry for a dead id. This does not happen: the Dock destroys the editor on close, which clears its listener bag and its CodeMirror view before any further update could fire.

---

## Critical Files

- [frontend/src/SqlAdminController.ts:215-270, 315-331, 684-696](frontend/src/SqlAdminController.ts#L215) — the `"close"`/`"focus"` handlers, the status-bar setup, and the `recordQueryRun` / `setActiveExport` precedent.
- [frontend/src/controller/queryWorkspace.ts:98-138](frontend/src/controller/queryWorkspace.ts#L98) — `openQuery`, where `onResult` is bound to the panel id.
- [frontend/src/controller/panelHost.ts:92-120](frontend/src/controller/panelHost.ts#L92) — the `PanelHost` seam.
- [frontend/src/dock/QueryPanel.ts:132-177, 238-245, 1254-1273](frontend/src/dock/QueryPanel.ts#L132) — options, the editor, the `"change"` listener and `onFirstLayout`.
- [frontend/src/textFormat.ts](frontend/src/textFormat.ts), [frontend/tests/textFormat.test.ts](frontend/tests/textFormat.test.ts) — the pure module and its tests.
- [typescript-ui CodeEditor.ts:57-99, 1188-1216, 1536-1605, 2087-2100](../typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts#L57) — the payload types, the getters, the dedup, and when the events fire.
- [typescript-ui StatusBar.ts](../typescript-ui/packages/lib/src/typescript/lib/component/container/StatusBar.ts) — `addRight`, the live region.
- [plans/query-error-position-reveal.md](plans/query-error-position-reveal.md) — the prerequisite's `QueryPanel.ts` edits, not to be disturbed.

---

## Non-Goals

- **Run selection.** The library has no getter for the selected text; `getSelection()` returns counts only. When "run selection" (TODO.md: "Multi-statement execution + transaction control") is built, it needs a library `CodeEditor` method returning the selected text and its start offset, added in typescript-ui. It must not be worked around from the app (for example by reaching into CodeMirror, or by slicing `getValue()` with offsets guessed from the counts).
- **Other editors.** The Explain-plan viewer, definition editors, `SqlPreviewDialog`, and `DocumentationPanel` do not report (see *Query panels only*).
- **Multiple cursors.** Only the primary selection is reported, as the library measures it.
- **Tab-width-aware columns or code-point counts.** The library's numbers are shown as-is.
- **Clicking the readout** (for example a "go to line" prompt).
- **Any library change or version bump.**

---

## Notes

[^precedent]: Searched for how the app already shows per-tab state that follows the active tab: `_activeQueryResult`/`setActiveExport` (menubar export), `_queryPanelRuns`/`recordQueryRun` (address bar), `_activeRoleGrants`. All three key a map by panel id, fill it from a callback bound to the id in the opener, and read it through `_activePanelId`. `syncToPanel`/`updateStatusFor` was also checked and does not fit: it only serves panels in the `_openPanels` registry, and query panels are deliberately never registered there (see `QueryWorkspace.openQuery`'s JSDoc). The readout's map stores the formatted string rather than the raw numbers because the controller only displays it, the same way `notify` hands the controller finished status text.

[^right-zone]: The left zone is one `setMessage` line that every `status()` and `notifyError()` call overwrites. A caret readout written there would erase "3 row(s)" or an error the moment the user moves the caret, and would itself be erased by the next status message. The controller's own comment already assigns persistent items (identity) to the right zone for this reason. Putting the readout first in the right zone matches editors like VS Code, where the cursor position sits on the right beside other persistent indicators.

[^hide-not-blank]: An empty but displayed `Text` would keep its slot and the row's spacing, leaving a visible gap beside the identity badge. `setDisplayed(false)` removes it from the layout. Deleting the entry and re-syncing in the `"close"` handler covers the gap before the Dock's deferred focus recompute: the Dock emits `"focus"` for a survivor (or `null`) only after the close, so for that moment `_activePanelId` still names the closed tab.

[^aria-off]: The nearest `aria-live` setting governs a node, so `"off"` on the child silences it inside the polite strip. This is an ordinary use of the library's `Aria` API (`AriaLive` includes `"off"`), not a workaround. The row-count and error messages in the left zone keep being announced.

[^library-units]: `CodeEditorCursorPosition.column` and `CodeEditorSelection.characterCount` count UTF-16 code units, and a literal tab is one column (library JSDoc, CodeEditor.ts:65-99). VS Code expands tabs to tab stops and counts graphemes. Converting in the app would mean re-reading the document text on every caret move to redo what the library already measured. Emoji and tabs are rare in SQL, and the error banner's column (from `query-error-position-reveal`) uses the same units, so the two readouts always agree. If the units ever matter, the fix belongs in the library's payload, not in app code. `lineCount` counts every line the selection touches, so selecting a whole line including its line break reports 2 lines; that is the library's definition and is shown unchanged. The `(N chars, M lines selected)` wording follows the library changelog's own example ("12 characters, 2 lines selected"), shortened to `chars` to fit a 22px bar that already holds the database scope, the message, the badge, and the history button.

[^home]: `textFormat.ts` is the app's module for "small pure value-to-display-string helpers" and has a node-vitest test file already. `controllerText.ts` was considered, but it holds controller-specific derivations (panel ids, tooltips), and the formatter is called from `QueryPanel`, a `dock/` module that does not import from `controller/`. `controllerText.ts` is also edited by `dock-beforeclose-unsaved-guard`, so using it would add a file conflict for no gain. The inline object types avoid inventing app types that would shadow the library's `CodeEditorCursorPosition` / `CodeEditorSelection`.

[^one-reporter]: Reading both getters on either event keeps the two halves of the string consistent. Both events fire from the same CodeMirror update, one after the other, and `view.state` is already updated when they run, so the second call produces the same string as the first. That double `setText` with an identical string is cheap and not worth deduplicating. The construction-time call is needed because an empty editor never fires either event: its caret starts at `Ln 1, Col 1`, and the library's dedup only emits on a change. The panel is built before the Dock adds it, so that first report arrives while `_activePanelId` is still the previous tab. It is stored, and the Dock's `"focus"` for the new tab then shows it. `offset` from `getCursorPosition()` is not shown: no editor convention displays it, and nothing in this feature needs it.

[^cleanup]: This is the teardown shape recorded after the DiagramView listener leak: the leak came from a long-lived object holding a listener onto something whose lifetime ended. Here the long-lived side (the controller) holds only strings keyed by id, removed on `"close"`. The short-lived side (the editor) holds the closures, and the library clears them when the editor is destroyed. No `off()` call or `destructor()` override is added to `QueryPanelContent`.

[^scope]: The definition editors and `SqlPreviewDialog` would each need their own id plumbing to the controller (the preview is a modal, not a dock tab, so the active-tab rule does not even apply). `DocumentationPanel` uses `MarkdownEditor`, which is Lexical-based and exposes no caret-position API. The Explain viewer is read-only and lives inside the query tab, where two readouts would compete for one slot. None of these falls out of the query-panel wiring for free, so they are left out. The controller side (`setCaretReadout(id, …)`) is generic, so a later surface only needs its own `on("cursorchange")`/`on("selectionchange")` wiring and an id.

[^order]: The conflict is textual, not functional. `query-error-position-reveal` edits `run()`, `runExplainRun()`, the header's "Errors funnel…" paragraph, the `RunQuery` JSDoc, and adds helpers after `setBusy`. This plan adds an option, a destructuring entry, an import, a new header paragraph, and a block after the `"change"` listener. Line numbers cited here are from before that plan lands; the implementer should find each site by the symbol or comment named, not by the number alone.
