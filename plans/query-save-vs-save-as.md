---
touches-shared: [frontend/src/dock/QueryPanel.ts, frontend/src/controller/queryWorkspace.ts, frontend/src/shell/queryShortcuts.ts, frontend/src/shell/shortcutRegistry.ts, LIBRARY_NOTES.md]
---

# Query Save vs Save As — Implementation Plan

## Overview

Today the query panel's Save button and Ctrl/Cmd+S always open the "Save query as" name
prompt, and saving never marks the tab clean. This plan splits the action in two:

- **Save** overwrites the saved query this tab is linked to, with no prompt. A tab with no
  link, or whose linked query no longer exists, falls through to Save as.
- **Save as** always asks for a name. If the name is already taken by a different saved
  query, a confirm dialog asks before replacing it. On success the tab is linked to the new
  name and its title changes to that name.

Both mark the editor clean on success, so the tab's modified dot clears and closing the tab
no longer prompts. Ctrl/Cmd+S is Save; Ctrl/Cmd+Shift+S is Save as. The toolbar's Save
button becomes a split button whose chevron menu holds "Save as…".

Saved queries are frontend-only: `SavedQueryStore`
([frontend/src/data/queryStore.ts:166](frontend/src/data/queryStore.ts#L166)) keeps them in
`localStorage`, keyed by name, with an upsert `save(name, sql)`. There is no backend API, so
no backend change is needed.[^no-backend] The save decisions move into a new pure module,
`frontend/src/controller/querySaveFlow.ts`, so they are unit-testable in node. The
per-tab link lives in a new private `QueryWorkspace.panelSaveHooks`, called from `openQuery`
([frontend/src/controller/queryWorkspace.ts:102](frontend/src/controller/queryWorkspace.ts#L102)),
and `QueryPanel` ([frontend/src/dock/QueryPanel.ts:331](frontend/src/dock/QueryPanel.ts#L331))
gets the split button, the second shortcut, and the `markClean()` call.

---

## Architecture Decisions

### A tab links to a saved query by name, held per panel by `panelSaveHooks`

A saved query's name is its only identity: `SavedQueryStore` upserts and looks up by name,
and there is no id.[^name-identity] `openQuery` gains a fifth parameter, `savedName?: string`.
`openSavedQuery` passes the name; every other caller passes nothing, so their tabs start
unlinked. A new private method, `panelSaveHooks`, holds the link for one panel in a
`let linkedName: string | null` and builds that panel's `onSave`/`onSaveAs`. The link changes only after a
successful save under a different name.

The tab title is not used as the link. `openQuery` already takes a `title` that is not a
saved-query name (`objectPanels.ts:76` passes a table name, `executeFunction` passes
`Run foo`).

### Save degrades to Save as when the link is gone

Save checks `store.get(linkedName)` right before writing. If the linked query was removed
(the Queries view's Remove), Save opens the Save-as prompt, prefilled with the old name.
There is no rename feature for saved queries, so removal is the only way a link can
break.[^no-rename]

### Save as asks before replacing a *different* saved query; declining returns to the name prompt

| Tab linked to | Name entered | Name exists? | Result |
|---|---|---|---|
| — | `report` | no | saved, no confirm |
| — | `report` | yes | confirm "Replace saved query" |
| `report` | `report` | yes | saved, no confirm (it is this tab's own query) |
| `report` | `daily` | yes | confirm |
| any | (cancel / blank) | — | nothing saved |

When the user declines the replace confirm, the name prompt opens again, prefilled with the
declined name. Cancelling the name prompt ends the flow with nothing saved.[^decline-loop]

The confirm uses `Dialog.confirm`, whose Cancel is the primary button, so Enter and Escape
both keep the existing query.[^dialog-confirm] The same flow also backs the Queries view's
Recent "Save under a name" action (`promptAndSaveQuery`), which has no tab to link.

### The save decisions live in a pure module with injected prompt, confirm, and store

`frontend/src/controller/querySaveFlow.ts` exports `saveQuery` and `saveQueryAs`. They take a
`QuerySaveDeps` bag (store, name prompt, replace confirm) and return the saved name or
`null`. The module imports no library code, only a type from `queryStore.ts`.
This follows `closeRequestBatcher.ts` and `dirtyTabMarker.ts`, which the controller keeps
free of library imports so the node vitest can load them
([frontend/src/controller/closeRequestBatcher.ts:1-5](frontend/src/controller/closeRequestBatcher.ts#L1)).
`QueryWorkspace` builds the real deps once, in its constructor.

### `QueryPanel` stays a pure view; its save callbacks return whether anything was saved

`QueryPanelOptions.onSave` changes from `(sql) => void` to `(sql) => Promise<boolean>`, and a
new `onSaveAs` has the same shape. The panel still trims the SQL and rejects an empty editor.
When the promise resolves `true`, the panel calls `editor.markClean()`. The workspace never
touches the editor, matching how `onRun`/`onResult` keep the store logic on the workspace
side ([frontend/src/controller/queryWorkspace.ts:123-133](frontend/src/controller/queryWorkspace.ts#L123)).
Nothing can edit the editor while a save is pending.[^no-race]

### A successful save marks the tab clean

This reverses a rule set by `app-wide-unsaved-changes-guard.md` and kept by
`dirty-tab-modified-indicator.md`: "Save… stores a copy and does not mark the tab clean".
That rule made sense while a save created an unlinked copy. Now the tab *is* the saved
query, so after Save or Save as its text has a stored copy and the dot, the close prompt,
and the tab's clean state all agree. `dirty-tab-modified-indicator.md` said changing this
"belongs in its own plan"; this is that plan.[^clean-reversal]

`CodeEditor.markClean()` takes the current editor text as the new clean baseline, so the dot
clears and returns on the next edit. The editor text may differ from the stored SQL only by
leading/trailing whitespace (the panel trims before saving). Treating that as clean is
intended.

### After Save as, the tab title and status label change to the saved name

The workspace calls `host.dock.setPanelTitle(id, name)` (library `Dock.setPanelTitle`,
durable across tear-off and re-dock) and updates the panel's status-line label. Save to the
existing link changes neither, since the title is already right or was deliberately set by
the opener.[^title-on-save]

### "Save as…" lives in the Save button's chevron menu, via the library `SplitButton`

The toolbar's Save `glyphButton` becomes a `SplitButton`: clicking the face saves, clicking
the chevron opens a one-item menu, "Save as…", showing `Ctrl/Cmd+Shift+S` as its shortcut
hint. The library's own `SplitButton` JSDoc example is exactly a Save / "Save As…" button.
A new `glyphSplitButton` helper in `frontend/src/dock/glyphButton.ts` builds it. That file
is the app's single owner of the glyph-only toolbar face; the new helper sits beside
`glyphMenuButton` ([frontend/src/dock/glyphButton.ts:68](frontend/src/dock/glyphButton.ts#L68)),
the precedent for a toolbar dropdown.[^why-split-button]

`SplitButton`'s chevron cannot be opened from the keyboard. This is a library defect, logged
in `LIBRARY_NOTES.md` with no app workaround. Keyboard users reach Save as through
Ctrl/Cmd+Shift+S.[^splitbutton-keyboard]

### Ctrl/Cmd+Shift+S is Save as, matched by new `queryShortcuts` helpers

`queryShortcuts.ts` gains `SAVE_AS_SHORTCUT = "Ctrl/Cmd+Shift+S"`, `isSaveChord`, and
`isSaveAsChord`, shaped exactly like `isExplainChord`/`isExplainAnalyzeChord`
([frontend/src/shell/queryShortcuts.ts:101-114](frontend/src/shell/queryShortcuts.ts#L101)).
The editor's keydown listener uses them instead of its inline `s`/`S` test.

| Keys | `isSaveChord` | `isSaveAsChord` |
|---|---|---|
| Ctrl+S / Cmd+S (`key` `s` or `S`) | true | false |
| Ctrl+Shift+S / Cmd+Shift+S | false | true |
| Ctrl+Alt+S | false | false |
| Alt+S (Open saved) | false | false |
| S alone | false | false |

The current inline test (`chord && (e.key === "s" || e.key === "S")`) does not look at
Shift, so today Ctrl+Shift+S also saves. The new matchers make the two chords
exclusive.[^shortcut-clash]

---

## Public API

```ts
// frontend/src/controller/querySaveFlow.ts (new)

/** The saved-query store surface the flow needs; `SavedQueryStore` satisfies it. */
export interface SavedQueryTarget {
    get(name: string): SavedQuery | undefined;
    save(name: string, sql: string): void;
}

/** The side effects the save flow needs, injected so the flow is node-testable. */
export interface QuerySaveDeps {
    /** The saved-query store. */
    store: SavedQueryTarget;
    /** Ask for a name, prefilled with `defaultName`; `null` abandons. */
    promptName: (defaultName: string) => Promise<string | null>;
    /** Ask whether to replace the existing saved query `name`. */
    confirmReplace: (name: string) => Promise<boolean>;
}

/** Save to `linkedName` when it still exists, else fall through to saveQueryAs. */
export async function saveQuery(deps: QuerySaveDeps, sql: string, linkedName: string | null): Promise<string | null>;

/** Prompt for a name, confirm before replacing another query, then save. */
export async function saveQueryAs(deps: QuerySaveDeps, sql: string, linkedName: string | null): Promise<string | null>;
```

Both return the name the SQL was saved under, or `null` when nothing was saved.

```ts
// frontend/src/dock/QueryPanel.ts — QueryPanelOptions (changed / new members)
onSave?:   (sql: string) => Promise<boolean>;   // was (sql: string) => void
onSaveAs?: (sql: string) => Promise<boolean>;   // new

// frontend/src/controller/queryWorkspace.ts — QueryWorkspace
openQuery(seedSql?: string, run?: boolean, title?: string, explain?: "plain" | "analyze", savedName?: string): void;
async promptAndSaveQuery(sql: string): Promise<void>;   // signature unchanged; now confirms before replacing

// frontend/src/shell/queryShortcuts.ts
export const SAVE_AS_SHORTCUT = "Ctrl/Cmd+Shift+S";
export function isSaveChord(event: KeyboardEvent): boolean;
export function isSaveAsChord(event: KeyboardEvent): boolean;

// frontend/src/dock/glyphButton.ts
export function glyphSplitButton(
    glyph: string, color: string, label: string,
    handler: (event: MouseEvent) => void, menuItems: MenuItemConfig[],
): SplitButton;
```

---

## Implementation

`querySaveFlow.ts` core logic (add JSDoc per the conventions):

```ts
export async function saveQuery(deps: QuerySaveDeps, sql: string, linkedName: string | null): Promise<string | null> {
    const linked = linkedName === null ? undefined : deps.store.get(linkedName);

    if (linked === undefined) {
        return saveQueryAs(deps, sql, linkedName);
    }

    deps.store.save(linked.name, sql);

    return linked.name;
}

export async function saveQueryAs(deps: QuerySaveDeps, sql: string, linkedName: string | null): Promise<string | null> {
    let defaultName = linkedName ?? "";

    for (;;) {
        const name = await deps.promptName(defaultName);

        if (name === null) {
            return null;
        }

        const replacesOther = name !== linkedName && deps.store.get(name) !== undefined;
        const confirmed     = !replacesOther || await deps.confirmReplace(name);

        if (confirmed) {
            deps.store.save(name, sql);

            return name;
        }

        defaultName = name;
    }
}
```

`QueryWorkspace` deps field, built in the constructor after `_saved`:

```ts
this._saveDeps = {
    store         : this._saved,
    promptName    : defaultName => promptQueryName(defaultName),
    confirmReplace: name => Dialog.confirm(
        "Replace saved query",
        `A saved query named “${elideName(name)}” already exists. Do you want to replace it?`,
    ),
};
```

`QueryWorkspace.panelSaveHooks`, a new private method that owns one panel's link. `openQuery`
spreads its result into the `QueryPanel` options in place of the current `onSave` line:

```ts
/**
 * Build one query panel's Save / Save as callbacks, holding that panel's
 * link to a saved query.
 *
 * @param id - The panel id (retitled after a Save as to a new name).
 * @param savedName - The saved query the panel starts linked to, if any.
 * @param onRenamed - Called with the new name when the link changes.
 *
 * @returns The panel's `onSave` / `onSaveAs` options.
 */
private panelSaveHooks(
    id: string, savedName: string | undefined, onRenamed: (name: string) => void,
): Pick<QueryPanelOptions, "onSave" | "onSaveAs"> {
    let linkedName: string | null = savedName ?? null;

    // Record a completed save: relink, retitle, refresh the surfaces. Returns
    // whether anything was saved, which is what the panel's callbacks resolve to.
    const applySaved = (name: string | null): boolean => {
        if (name === null) {
            return false;
        }

        if (name !== linkedName) {
            linkedName = name;
            this.host.dock.setPanelTitle(id, name);
            onRenamed(name);
        }

        this.notifyWorkspaceChanged();
        this.host.status(`Saved query “${elideName(name)}”`);

        return true;
    };

    return {
        onSave  : async (sql: string) => applySaved(await saveQuery(this._saveDeps, sql, linkedName)),
        onSaveAs: async (sql: string) => applySaved(await saveQueryAs(this._saveDeps, sql, linkedName)),
    };
}

// In openQuery: `const statusLabel` becomes `let statusLabel`, and the options gain
//     ...this.panelSaveHooks(id, savedName, name => { statusLabel = elideName(name); }),
```

`notify` already reads `statusLabel` at call time, so making it a `let` is enough for the
status prefix to follow a rename.

`QueryPanel`'s shared persist step (replaces `save()`):

```ts
/**
 * Hand the trimmed editor SQL to `saver`, then mark the editor clean when it
 * reports a save. A no-op (with a hint) on an empty editor.
 */
async function persist(saver: ((sql: string) => Promise<boolean>) | undefined): Promise<void> {
    const sql = editor.getValue().trim();

    if (!sql) {
        notify("Enter a SQL statement to save");

        return;
    }

    if (saver === undefined) {
        return;
    }

    const saved = await saver(sql);

    if (saved) {
        editor.markClean();
    }
}
```

---

## Ordered Implementation Steps

1. **Shortcut matchers — tests first.** In `frontend/tests/shell/queryShortcuts.test.ts`, import
   `isSaveChord` and `isSaveAsChord`, add both to `ALL_MATCHERS`, and add a
   `describe("isSaveChord / isSaveAsChord")` block covering every row of the shortcut table
   above (mirror the `isExplainChord` block). Run `npm test` in `frontend/` — expect failures.
2. **`frontend/src/shell/queryShortcuts.ts`.** Add `SAVE_AS_SHORTCUT = "Ctrl/Cmd+Shift+S"` after
   `SAVE_SHORTCUT` (line 32). Add `isSaveChord` and `isSaveAsChord` after `isExplainAnalyzeChord`,
   copying its shape with key `s`/`S`. Update the header comment (lines 13-16) to list
   Save / Save as among the editor-scoped chords. Tests from step 1 pass.
3. **Registry — tests first, then code.** In `frontend/tests/shell/shortcutRegistry.test.ts` add
   `"save-as"` to `EXPECTED_IDS` (15 ids; fix the "14" wording in the comment and test name),
   assert `byId.get("save-as")` is `SAVE_AS_SHORTCUT`, and change the group counts to
   `[7, 3, 5]`. Then in `frontend/src/shell/shortcutRegistry.ts` import `SAVE_AS_SHORTCUT` and add
   `{ id: "save-as", keys: SAVE_AS_SHORTCUT, label: "Save the query under a new name", category: "editor" }`
   right after the `"save"` entry. Tests pass.
4. **Save flow — tests first.** Create `frontend/tests/controller/querySaveFlow.test.ts` with a
   fake store (a `Map`-backed object implementing `SavedQueryTarget`), a scripted `promptName`
   (returns queued answers, records each `defaultName` it was given), and a scripted
   `confirmReplace` (queued booleans, records names). Cover every case in
   `## Expected Behaviour` → *Save flow*. Expect failures (module missing).
5. **`frontend/src/controller/querySaveFlow.ts`.** Create it with a header comment in the style of
   `closeRequestBatcher.ts` (pure, no library imports, why). Export `SavedQueryTarget`,
   `QuerySaveDeps`, `saveQuery`, `saveQueryAs` as in `## Public API` / `## Implementation`, with
   JSDoc. Only `import type { SavedQuery } from "../data/queryStore"`. Step 4 tests pass.
6. **`frontend/src/dock/glyphButton.ts`.** Import `SplitButton` from
   `@jimka/typescript-ui/component/button`. Add `glyphSplitButton` after `glyphMenuButton`:
   `const button = new SplitButton(label, { ...glyphButtonOptions(glyph, color, label), menuItems });`,
   then `button.on("action", handler)`, return it. Update the file header (lines 1-9) to name the
   split variant. `npm run typecheck` passes.
7. **`frontend/src/dock/QueryPanel.ts`.**
   1. Imports: add `glyphSplitButton` to the `./glyphButton` import (line 75); add
      `SAVE_AS_SHORTCUT, isSaveChord, isSaveAsChord` to the `../shell/queryShortcuts` import
      (lines 112-116).
   2. `QueryPanelOptions` (lines 169-174): change `onSave` to `(sql: string) => Promise<boolean>`,
      rewrite its JSDoc (Save to the linked query, or Save as when unlinked; resolves `true` when
      something was saved, and the panel then marks the editor clean). Add `onSaveAs` with the
      same type and JSDoc for Save as.
   3. Destructure `onSaveAs` alongside `onSave` (line 258).
   4. Line 331: replace the `glyphButton(...)` Save with
      `glyphSplitButton("floppy-disk", PRIMARY_COLOR, \`Save query (${SAVE_SHORTCUT})\`, () => void persist(onSave), [{ text: "Save as…", shortcut: SAVE_AS_SHORTCUT, action: () => void persist(onSaveAs) }])`.
      Keep the variable name `saveButton`.
   5. Replace `save()` (lines 663-677) with `persist` from `## Implementation`.
   6. `syncToolbarButtons` (line 696): keep `saveButton.setEnabled(onSave !== undefined && hasSql)`.
   7. Keydown listener (lines 1254-1259): replace the inline `s`/`S` branch with two branches,
      `isSaveAsChord(e)` → `void persist(onSaveAs)` and `isSaveChord(e)` → `void persist(onSave)`,
      each with `e.preventDefault()` and `return`. Update the listener's comment (line 1230) to
      mention Ctrl/Cmd+Shift+S.
   8. Check: `grep -n 'e.key === "s"' frontend/src/dock/QueryPanel.ts` — expect zero matches.
8. **`frontend/src/controller/queryWorkspace.ts`.**
   1. Import `saveQuery, saveQueryAs` and `type QuerySaveDeps` from `./querySaveFlow`.
   2. Add a `private readonly _saveDeps: QuerySaveDeps;` field next to `_saved` and build it in
      the constructor after `_saved` (see `## Implementation`).
   3. Add `import type { QueryPanelOptions } from "../dock/QueryPanel";` and the private method
      `panelSaveHooks` from `## Implementation`, placed just before the private `recordRun`
      method.
   4. `openQuery` (lines 102-151): add the `savedName?: string` parameter with JSDoc ("links the
      tab to this saved query so Save overwrites it"). Change `const statusLabel` (line 109) to
      `let`. Replace the `onSave` option and its comment (lines 128-130) with
      `...this.panelSaveHooks(id, savedName, name => { statusLabel = elideName(name); }),` and a
      one-line comment that the workspace owns the saved-query link, prompt, and store.
   5. `openSavedQuery` (line 193): call `this.openQuery(saved.sql, run, name, undefined, name)`.
   6. `promptAndSaveQuery` (lines 205-214): replace the body with
      `const name = await saveQueryAs(this._saveDeps, sql, null);`, return on `null`, then
      `this.notifyWorkspaceChanged();` and `this.host.status(\`Saved query “${elideName(name)}”\`);`.
      Update its JSDoc: it is now the Queries view's Recent "Save under a name" action only, and
      confirms before replacing.
   7. Delete the private `saveQuery` method (lines 351-355). Check:
      `grep -n "this.saveQuery\|private saveQuery" frontend/src/controller/queryWorkspace.ts` — zero matches.
9. **`frontend/src/promptQueryName.ts`.** Update the header comment (lines 3-5): the query panel's
   Save as (button menu, Ctrl/Cmd+Shift+S, and Save's fall-through) now shares this prompt; no code
   change.
10. **`frontend/src/data/queryStore.ts`.** Update `save`'s JSDoc (lines 181-182): "A plain upsert;
    callers confirm before replacing another query (see querySaveFlow.ts)." No code change.
11. **`LIBRARY_NOTES.md`.** Add a newest-first entry at the top (after the `---` on line 9):
    `## 🐞🔎 \`SplitButton\`'s dropdown cannot be opened from the keyboard (0.10.0)`. Content: the
    chevron is a non-focusable `Glyph` inside the `<button>`, opened only by a subtree `click`
    listener (`component/button/SplitButton.ts:141-156`, `_toggleMenu` at `:235`); there is no
    keydown path (e.g. Alt+ArrowDown / ArrowDown) and no `aria-haspopup`/`aria-expanded`, so
    keyboard and screen-reader users cannot reach the menu. Recommended fix: open the menu on
    Alt+ArrowDown (and ArrowDown) while the button has focus, and expose
    `aria-haspopup="menu"` plus `aria-expanded`. SQLAdmin impact: the query panel's "Save as…"
    menu item is mouse-only; Ctrl/Cmd+Shift+S covers keyboard users. SQLAdmin does not work around it.
12. **Full check.** In `frontend/`: `npm run typecheck` and `npm test` — all green.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/controller/querySaveFlow.ts` |
| Create | `frontend/tests/controller/querySaveFlow.test.ts` |
| Modify | `frontend/src/controller/queryWorkspace.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/src/dock/glyphButton.ts` |
| Modify | `frontend/src/shell/queryShortcuts.ts` |
| Modify | `frontend/src/shell/shortcutRegistry.ts` |
| Modify | `frontend/src/promptQueryName.ts` (comment only) |
| Modify | `frontend/src/data/queryStore.ts` (JSDoc only) |
| Modify | `frontend/tests/shell/queryShortcuts.test.ts` |
| Modify | `frontend/tests/shell/shortcutRegistry.test.ts` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

### Save flow (`querySaveFlow.ts`, unit-testable)

| # | Call | Store before | Prompt / confirm answers | Result | Store after |
|---|---|---|---|---|---|
| S1 | `saveQuery(sql, "a")` | `a` exists | none asked | `"a"` | `a` = sql |
| S2 | `saveQuery(sql, null)` | empty | prompt → `"b"` (asked with `""`) | `"b"` | `b` = sql |
| S3 | `saveQuery(sql, "a")` | `a` missing (removed) | prompt → `"a"` (asked with `"a"`) | `"a"` | `a` = sql; no confirm asked |
| S4 | `saveQueryAs(sql, null)` | empty | prompt → `null` | `null` | unchanged |
| S5 | `saveQueryAs(sql, null)` | `b` exists | prompt → `"b"`, confirm → true | `"b"` | `b` = sql; confirm asked with `"b"` |
| S6 | `saveQueryAs(sql, null)` | `b` exists | prompt → `"b"`, confirm → false, prompt → `"c"` | `"c"` | `b` unchanged, `c` = sql; second prompt asked with `"b"` |
| S7 | `saveQueryAs(sql, null)` | `b` exists | prompt → `"b"`, confirm → false, prompt → `null` | `null` | unchanged |
| S8 | `saveQueryAs(sql, "a")` | `a` exists | prompt → `"a"` (asked with `"a"`) | `"a"` | `a` = sql; no confirm asked |
| S9 | `saveQueryAs(sql, "a")` | `a`, `b` exist | prompt → `"b"`, confirm → true | `"b"` | `b` = sql, `a` unchanged |
| S10 | `saveQuery(sql, "a")` | `a` exists | — | — | `promptName` never called |

Blank-name handling stays in `promptQueryName` (a blank field resolves `null`), so S4 covers it.

### Shortcuts (unit-testable)

- Every row of the shortcut table in *Ctrl/Cmd+Shift+S is Save as*.
- The Alt-chord mutual-exclusion test still passes with the two new matchers in `ALL_MATCHERS`.
- Registry: 15 ids, `save-as` keys equal `SAVE_AS_SHORTCUT`, editor group has 7 entries.

### Query panel and workspace (manual — needs the running app)

- M1 **New tab, Ctrl+S.** Type SQL in a fresh `Query N` tab, press Ctrl+S → "Save query as"
  prompt. Enter `m1` → tab title becomes `m1`, dot clears, status reads `Saved query “m1”`,
  Queries view lists `m1`.
- M2 **Save again.** Edit the same tab (dot appears), press Ctrl+S → no prompt, dot clears,
  opening `m1` from the Queries view shows the new SQL.
- M3 **Save button face vs chevron.** Clicking the floppy face behaves as Ctrl+S; clicking the
  chevron shows "Save as…" with `Ctrl/Cmd+Shift+S` hint; choosing it opens the prompt prefilled
  with `m1`.
- M4 **Save as over another query.** In tab `m1`, Ctrl+Shift+S, enter an existing name `m0` →
  "Replace saved query" confirm. Cancel → name prompt reappears with `m0`; cancel → nothing
  saved, title stays `m1`. Repeat and confirm → `m0` holds the SQL, tab title `m0`, dot clear.
- M5 **Opened from the Queries view.** Open saved `m0` → tab titled `m0`, clean. Edit, Ctrl+S
  → overwrites `m0` with no prompt.
- M6 **Linked query removed.** With tab `m0` open, remove `m0` in the Queries view. Edit the
  tab, Ctrl+S → prompt prefilled `m0`; confirm → `m0` recreated, no replace confirm.
- M7 **Close after save.** After M2, close the tab → no unsaved-changes prompt. Edit once
  more and close → prompts.
- M8 **Recent "Save under a name".** In the Queries view's Recent section, save an entry under
  an existing name → replace confirm appears; declining returns to the prompt.
- M9 **Empty editor.** On an empty tab, Save is disabled; Ctrl+S and Ctrl+Shift+S show
  "Enter a SQL statement to save". The chevron's "Save as…" does the same if the menu opens.
- M10 **Ctrl+Shift+S reaches the app.** In Chrome, Firefox, and Edge, Ctrl+Shift+S in the editor
  opens the Save-as prompt, not a browser feature (Firefox and Edge bind it to screenshots).
- M11 **Tear-off.** Float a linked tab, Save as a new name → the float window's title updates.

---

## Verification

- `cd frontend && npm run typecheck && npm test` — all green, including the new
  `tests/controller/querySaveFlow.test.ts`. In the worktree, symlink `frontend/node_modules`
  to the main tree's first.
- `grep -n 'e.key === "s"' frontend/src/dock/QueryPanel.ts` — zero matches.
- `grep -rn "onSave" frontend/src` — only `QueryPanel.ts` and `queryWorkspace.ts`.
- Manual M1–M11 with the `verify` skill against the running app (query tab via Alt+N; Queries
  view via Alt+Q).

---

## Potential Challenges

- **Ctrl+Shift+S browser bindings (Firefox/Edge screenshots).** The editor listener calls
  `preventDefault()` in the capture phase like the other chords; confirm with M10, and if a
  browser still takes the chord, record it in the plan's implementation notes. Do not pick a
  different chord without asking the user.
- **Disabled `SplitButton` chevron.** A disabled `<button>` may still let the chevron's subtree
  click through in some browsers; `persist` rejects empty SQL anyway, so the worst case is the
  "Enter a SQL statement to save" hint (M9).
- **`SplitButton` label precedence.** Pass `label` both positionally and as `text` in the bag,
  so the tooltip and aria-label are right whichever the `Button` constructor prefers.
- **Two tabs linked to one query.** Both overwrite the same entry; the last Save wins. This is
  accepted, not guarded.

---

## Critical Files

- [frontend/src/controller/queryWorkspace.ts:102-214](frontend/src/controller/queryWorkspace.ts#L102) — `openQuery`, `openSavedQuery`, `promptAndSaveQuery`, `removeSavedQuery` (the existing `Dialog.confirm` usage).
- [frontend/src/dock/QueryPanel.ts](frontend/src/dock/QueryPanel.ts) — options (L143-196), toolbar (L330-369), `save()` (L663-677), `syncToolbarButtons` (L692-697), keydown listener (L1230-1289).
- [frontend/src/data/queryStore.ts:166-235](frontend/src/data/queryStore.ts#L166) — `SavedQueryStore` (name-keyed upsert).
- [frontend/src/promptQueryName.ts](frontend/src/promptQueryName.ts) — the reused name prompt.
- [frontend/src/controller/closeRequestBatcher.ts](frontend/src/controller/closeRequestBatcher.ts) and [frontend/tests/controller/closeRequestBatcher.test.ts](frontend/tests/controller/closeRequestBatcher.test.ts) — precedent for a pure, injected-deps controller module and its test.
- [frontend/src/dock/glyphButton.ts](frontend/src/dock/glyphButton.ts) — `glyphMenuButton`/`glyphToggleButton`, the precedent for `glyphSplitButton`.
- [frontend/src/shell/queryShortcuts.ts:95-114](frontend/src/shell/queryShortcuts.ts#L95) and [frontend/src/shell/shortcutRegistry.ts](frontend/src/shell/shortcutRegistry.ts) — chord matchers and the legend registry.
- `../typescript-ui/packages/lib/src/typescript/lib/component/button/SplitButton.ts` — the library split button (constructor, `menuItems`, `_toggleMenu`).
- `../typescript-ui/packages/lib/src/typescript/lib/overlay/Dock.ts:1941` — `Dock.setPanelTitle`.
- `frontend/COMPONENT_CONVENTIONS.md` §(c) and §(f) — callbacks and `QueryPanel`'s composition shape.

---

## Non-Goals

- **Backend persistence of saved queries.** They stay in `localStorage`; no API exists or is added.
- **Renaming saved queries** from the Queries view. There is no rename today.
- **Unlinking or re-dirtying other tabs** when their saved query is removed or overwritten
  elsewhere. Save's fall-through handles a removed link on demand.
- **A menubar Save / Save as entry.** No menubar item exists for query Save today.
- **Fixing `SplitButton` keyboard access in the library.** Logged in `LIBRARY_NOTES.md` only.
- **CHANGELOG.** Written at release time; note that the 0.10.0 entry's "Save… doesn't clear the
  dot" line becomes outdated.

---

## Notes

[^no-backend]: A search of `frontend/src` and `backend/` for saved-query code finds only
    `SavedQueryStore` (`queryStore.ts`) and its callers in `queryWorkspace.ts`. The store is
    scoped per user and connection in `localStorage` (`sqladmin.saved.<user>.<connection>`).
    Name uniqueness holds because `save` upserts by name; today a duplicate name silently
    replaces the old query with no warning.

[^name-identity]: Adding an id to `SavedQuery` would need a storage migration for existing
    entries and buys nothing while there is no rename. If a rename feature is added later,
    it should either give saved queries an id or update open tabs' links as part of the rename.

[^no-rename]: The Queries view's Saved section offers Open, Execute, and Remove
    (`QueriesView.ts:111-120`). Another tab's Save as can overwrite the linked entry's SQL,
    but the name still exists, so the link still resolves and Save overwrites it again —
    last write wins.

[^decline-loop]: No confirm-before-overwrite precedent exists in the app: `LoginDialog.savePreset`
    overwrites presets silently. Returning to the name prompt matches common desktop Save-As
    dialogs, where declining "replace?" lets you pick another name, and it avoids making the
    user restart the gesture. This was a judgment call made for the user; cancel-on-decline
    would be a one-line change (`return null` instead of looping).

[^dialog-confirm]: Project guidance prefers the `Dialog.confirm`/`info`/`warning` shortcuts over
    `Dialog.show`. `removeSavedQuery` already uses `Dialog.confirm` for the same store.
    `Dialog.confirm` labels its buttons Cancel/Confirm; a custom "Replace" label would need
    `Dialog.show` and was not worth leaving the shortcut for.

[^no-race]: Save to a live link writes synchronously and resolves on the next microtask. Save as
    runs behind modal dialogs, which block editing. So the text `markClean()` accepts is the text
    that was saved (modulo trimming), and no guard comparing before/after text is needed.

[^clean-reversal]: `plans/implemented/app-wide-unsaved-changes-guard.md` (the `QueryPanel` bullet
    and manual case 7) and `plans/implemented/dirty-tab-modified-indicator.md` (its
    `QueryPanel` decision and its `query-dirty` footnote). Both reasoned that the tab had "no other copy".
    With a link, Save as creates exactly that copy and Save keeps it current, so clean is now
    the truthful state. An unlinked tab still starts clean only at its opening text, as before.

[^title-on-save]: A tab opened by `openSavedQuery` is already titled with the name. A Save that
    falls through to Save as does retitle, because `applySaved` compares the saved name with the
    current link, not with which button was pressed.

[^why-split-button]: Two other placements were considered. A second toolbar button would add
    a near-duplicate floppy icon to an already long toolbar. A `glyphMenuButton` holding both
    Save and Save as would make the common Save a two-click action. `SplitButton` keeps Save as
    one click and shows Save as in a place users expect.

[^splitbutton-keyboard]: Confirmed by reading `SplitButton.ts`: the chevron is a plain `Glyph`
    with `pointer-events: auto` and a subtree `click` listener, and the class has no keydown
    handling or ARIA state. Per project practice, library defects are routed to a library fix,
    not worked around in the app; the keyboard shortcut already gives keyboard users a path.

[^shortcut-clash]: A search of `frontend/src` for `shiftKey` finds only `queryShortcuts.ts`'s
    Alt-chord guard and the two Explain matchers, so no in-app binding uses Ctrl/Cmd+Shift+S.
    The library's `CodeEditor` binds no `Mod-s`/`Mod-Shift-s` key. Ctrl/Cmd+Shift+S is the
    usual Save As chord (VS Code, most desktop editors). Firefox and Edge assign it to
    screenshot tools, which is why M10 checks it by hand.
