---
touches-shared:
  - frontend/src/shell/queryShortcuts.ts
  - frontend/src/shell/shortcutRegistry.ts
  - frontend/tests/shell/shortcutRegistry.test.ts
  - LIBRARY_NOTES.md
---

# Review Dialog Keyboard Exit — Implementation Plan

> **Depends on the typescript-ui plan `dialog-escape-releases-tab-owner`**
> (`/home/jika/typescript/typescript-ui/plans/dialog-escape-releases-tab-owner.md`).
> That plan makes `Escape` inside an editor in a `Dialog` release the editor
> instead of closing the dialog. This plan runs before any library release,
> against a symlinked build of that plan's branch; `frontend/package.json`
> stays on `^0.10.0`.[^pin]

## Overview

Since typescript-ui 0.10.0, [`SqlPreviewDialog`](frontend/src/dock/SqlPreviewDialog.ts#L180)'s
review dialog opens with focus in its SQL `CodeEditor` whenever the dialog has
no other focusable content (a create-object *Review SQL…*, or a
Columns/Sequence/Enum/composite *Save*). From there a keyboard-only user
cannot reach Cancel or Execute: `Tab` indents, and `Escape` closes the whole
dialog. `LIBRARY_NOTES.md` logs this as "A review dialog with no other
focusable content traps Tab/Shift+Tab in the SQL editor (0.10.0)".

The library plan fixes the trap with no app change: inside a dialog, `Escape`
then `Tab` leaves the editor, and a second `Escape` closes the dialog. This
plan does three things in SQLAdmin:

1. Adds one row to the shortcut legend — *Escape, then Tab* — *Leave the
   editor* — rendered by both the Keyboard Shortcuts dialog and the start
   page.
2. Verifies the library fix live in the review dialog, keyboard only, against
   the symlinked build.
3. Marks the `LIBRARY_NOTES.md` entry fixed.

---

## Architecture Decisions

### `SqlPreviewDialog` is not changed

The dialog keeps its default initial focus (the editor) and its buttons. The
library's release is what makes Execute reachable; no `initialFocus`, extra
control or key handler is added.[^no-app-change]

### The legend advertises the exit gesture

A display-only constant `LEAVE_EDITOR_SHORTCUT = "Escape, then Tab"` joins
the editor-scoped block of [`queryShortcuts.ts`](frontend/src/shell/queryShortcuts.ts#L27),
and [`SHORTCUTS`](frontend/src/shell/shortcutRegistry.ts#L42) gains
`{ id: "leave-editor", keys: LEAVE_EDITOR_SHORTCUT, label: "Leave the editor", category: "editor" }`
as the last editor entry, after `explain-analyze`. No matcher is added: the
library and CodeMirror handle the keys.[^advise]

This mirrors `HISTORY_RECALL_SHORTCUT`, a display-only string with no
`isXChord` helper, and the registry's rule that `keys` come from
`queryShortcuts.ts` constants, never literals
(`plans/implemented/shortcut-legend-home.md`).

| Rendered row | Keys column | Label column |
|---|---|---|
| existing | `Ctrl/Cmd+Shift+E` | Explain Analyze the statement |
| new, directly below it | `Escape, then Tab` | Leave the editor |

---

## Ordered Implementation Steps

Work in a SQLAdmin worktree on a `feature/review-dialog-keyboard-exit` branch
from `main`. Symlink the worktree's `frontend/node_modules` to the main tree's
before any frontend check (`ln -s /home/jika/typescript/sqladmin/frontend/node_modules <worktree>/frontend/node_modules`).

1. **Tests first — `frontend/tests/shell/shortcutRegistry.test.ts`.**
   - Import `LEAVE_EDITOR_SHORTCUT` with the other constants.
   - Add `"leave-editor"` to `EXPECTED_IDS`, and raise the count in the comment
     above it and in the first `it` title by one (14 → 15 on today's `main`).
   - In the "references the queryShortcuts constants" test, add
     `expect(byId.get("leave-editor")).toBe(LEAVE_EDITOR_SHORTCUT);`.
   - In "groups the entries with counts …", raise the editor count by one and
     rename the test to match (`[6, 3, 5]` → `[7, 3, 5]` on today's `main`).
   - In "preserves registry order within a group", append `"leave-editor"` to
     the editor list.
   Run `cd frontend && npx vitest run tests/shell/shortcutRegistry.test.ts` —
   expect failures (the import does not exist yet).
2. **`frontend/src/shell/queryShortcuts.ts`.** After `EXPLAIN_ANALYZE_SHORTCUT`
   (line 38) add, with a comment that it is display-only — the editor's own exit
   gesture, handled by the library and CodeMirror, so no matcher exists:
   `export const LEAVE_EDITOR_SHORTCUT    = "Escape, then Tab";`
   (align the `=` with its neighbours).
3. **`frontend/src/shell/shortcutRegistry.ts`.** Import `LEAVE_EDITOR_SHORTCUT`
   and add the entry from *Architecture Decisions* directly after the
   `explain-analyze` entry (line 48), aligned with its neighbours.
   Re-run step 1's command — green.
4. **Link the library build.** Per `.claude/skills/verify/SKILL.md`,
   *Library changes*: `rm -rf frontend/node_modules/@jimka/typescript-ui`, then
   `ln -s` an **absolute** target at the typescript-ui checkout whose branch
   carries the library plan — its worktree's `packages/lib` while the branch is
   unmerged, else `/home/jika/typescript/typescript-ui/packages/lib`. Run
   `npm run build:lib` in that checkout's root (not `npm run build`). Confirm
   `ls -ld frontend/node_modules/@jimka/typescript-ui` shows a symlink, then
   `rm -rf frontend/node_modules/.vite` and restart the dev server.[^link-proof]
5. **Manual verification.** Run the cases in *Expected Behaviour → Manual*,
   keyboard only (no mouse after opening each dialog).
6. **`LIBRARY_NOTES.md`.** Change the entry's heading marker from `🐞🔎` to
   `🐞✅`. Append a closing paragraph in the shape of the existing ✅ entries:
   "Fixed in the library (`dialog-escape-releases-tab-owner`):" — `Escape`
   inside the editor now releases it instead of closing the dialog, so
   `Escape` then `Tab` reaches Cancel/Execute and a second `Escape` closes;
   the dialog also lets that first `Escape` reach CodeMirror, so it closes an
   open completion list. "Adopted here: no code change; the shortcut legend
   gained *Escape, then Tab* — *Leave the editor*." Name the library build
   verified against (branch or commit).
7. `cd frontend && npm run typecheck && npm test`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Modify | `frontend/tests/shell/shortcutRegistry.test.ts` |
| Modify | `frontend/src/shell/queryShortcuts.ts` |
| Modify | `frontend/src/shell/shortcutRegistry.ts` |
| Modify | `LIBRARY_NOTES.md` |

---

## Expected Behaviour

### Unit (node vitest)

`shortcutRegistry.test.ts`: the registry carries `leave-editor` exactly once;
its `keys` is `LEAVE_EDITOR_SHORTCUT`; the editor group ends with
`leave-editor`; the other groups are unchanged.

### Manual

Log in per `.claude/skills/verify/SKILL.md` (database `sqladmin`). Each
dialog case starts with the dialog just opened and focus in the SQL editor —
M8 after `Tab` from its name field — which
`document.activeElement.className` containing `cm-content` confirms.

| # | Dialog | Keys | Expected |
|---|---|---|---|
| M1 | Create table → *Review SQL…* | `Tab` | editor indents; focus stays in the editor (unchanged) |
| M2 | same | `Escape`, `Tab` | focus on **Cancel**; dialog still open |
| M3 | same, after filling the create-table form with a new table name and one column | `Escape`, `Tab`, `Tab`, `Enter` | focus reaches **Execute**; `Enter` runs it; the dialog closes and the table appears in the navigator |
| M4 | same | `Escape`, `Shift+Tab` | focus on the title-bar ✕ |
| M5 | same | `Escape`, `Escape` | dialog closes; nothing executed |
| M6 | same | `Escape`, type `x`, `Tab` | `x` is typed; `Tab` indents (the release expired) |
| M7 | same | type `SEL`, `Ctrl+Space` to open the completion list, `Escape` | completion list closes; dialog stays open; `Tab` then leaves the editor |
| M8 | Rename table (form field, then editor) | `Tab` from the name field into the editor, then `Escape`, `Tab` | focus leaves the editor to Cancel |
| M9 | — the Query tab's SQL editor | `Escape`, `Tab` (within two seconds) | focus leaves the editor (CodeMirror's own gesture; no dialog involved) |
| M10 | Keyboard Shortcuts dialog (`?`) and the start page | look | *Escape, then Tab* — *Leave the editor* is the last Editor row; no row wraps or clips |

M9 checks that the legend row is also true outside dialogs. If M9 fails, stop
and record it in `LIBRARY_NOTES.md` as a new entry instead of shipping the
legend row.

---

## Verification

1. `cd frontend && npm run typecheck` — clean.
2. `cd frontend && npm test` — green, including `shortcutRegistry.test.ts`.
3. `ls -ld frontend/node_modules/@jimka/typescript-ui` — a symlink during the
   manual run.
4. Manual cases M1–M10.
5. `git diff --stat` touches only the four files in the table (plus no
   `package.json` / lockfile change).

---

## Critical Files

- `frontend/src/dock/SqlPreviewDialog.ts` — the dialog under test (read only).
- `frontend/src/shell/queryShortcuts.ts`, `frontend/src/shell/shortcutRegistry.ts`,
  `frontend/src/shell/shortcutLegend.ts` — key strings, registry, renderer.
- `.claude/skills/verify/SKILL.md` — symlink override and login.
- `/home/jika/typescript/typescript-ui/plans/dialog-escape-releases-tab-owner.md`
  — the library behaviour being verified.
- `plans/spatial-navigation-adoption.md` — also edits the registry and its
  test (two `navigation` entries); the count edits in step 1 are relative so
  either plan can land first.

---

## Non-Goals

- **Moving `frontend/package.json` to the release carrying the fix.** The
  library plan ships in a minor (0.11.0), which `^0.10.0` excludes; bumping
  the range and dropping the symlink is a release step.
- **A `SqlPreviewDialog` change** — see *Architecture Decisions*.
- **A CHANGELOG.md entry.** SQLAdmin's changelog is written at release time
  from the implemented plans.

---

## Notes

[^pin]: Per the project's release gate, a typescript-ui fix is verified in
    SQLAdmin against a local build before it is released, so this plan cannot
    wait on the release. Under the symlink the installed package and the
    manifest disagree; that mismatch is expected and is resolved at release
    time, not here.

[^no-app-change]: Three app-side alternatives were considered and rejected.
    `initialFocus` on Execute would bring back 0.9.0's "Enter executes"
    opening, but puts a destructive action one keystroke from a dialog the user
    has not read, and still leaves the trap once the user clicks into the
    editor. A plain control before or after the editor adds UI that exists
    only to route around a library defect. An app keydown handler for
    `Escape` would reimplement the library fix in the app, against the
    project's "fix in the library, not a workaround" rule.

[^advise]: WCAG 2.1.2 (No Keyboard Trap) allows an exit that needs more than
    plain `Tab` or arrow keys only when the user is told how. `Escape` then
    `Tab` is such an exit, and the library's documentation reaches developers,
    not SQLAdmin's users. The legend is where this app tells users about keys,
    and the row is true for every SQL editor in the app: in a dialog through
    the library's release, elsewhere through CodeMirror's own gesture (M9).

[^link-proof]: A symlink to the wrong checkout silently serves the main tree's
    build. Before trusting the run, compare a hashed chunk the page loaded
    (`performance.getEntriesByType('resource')`, e.g. the `Dialog` or `overlay`
    chunk) against the linked checkout's `dist/lib` file name.
