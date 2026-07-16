# Notification History in the Status Bar — Implementation Plan

## Overview

Add a notification-history button to the far right of SQLAdmin's status bar. The library already ships the entire UI: `NotificationHistoryButton` ([src/typescript/lib/overlay/NotificationHistoryButton.ts:76](../../typescript-ui/src/typescript/lib/overlay/NotificationHistoryButton.ts#L76)) is a `Button` subclass that owns its own anchored `Menu`, builds rows from `Notification.getHistory()`, formats relative times, renders an empty state, and re-opens a row's full message in a modal detail dialog. **No app-side UI is written.** The button is one `addRight` call in [frontend/src/SqlAdminController.ts:267](frontend/src/SqlAdminController.ts#L267).

The real work is the second half. SQLAdmin's user-feedback channel today is almost entirely `statusBar.setMessage(...)` — 92 call sites — and the library's history records **only** `Notification.show()`. The app calls `Notification.show` in exactly two places ([frontend/src/shell/LoginDialog.ts:210](frontend/src/shell/LoginDialog.ts#L210), [frontend/src/dock/SqlPreviewDialog.ts:217](frontend/src/dock/SqlPreviewDialog.ts#L217)). Dropped in as-is, the button would list one login toast and nothing else. This plan therefore also routes the app's **single error funnel** — `SqlAdminController.notifyError` ([frontend/src/SqlAdminController.ts:2465](frontend/src/SqlAdminController.ts#L2465)), the sink for ~60 call sites — through `Notification.show(..., "error")` so every app error becomes a reviewable history entry.

Scope is two files: `frontend/src/SqlAdminController.ts` (the button + `notifyError`). Nothing in `frontend/src/shell/SqlAdminShell.ts` changes — it mounts `controller.statusBar` wholesale at [frontend/src/shell/SqlAdminShell.ts:113](frontend/src/shell/SqlAdminShell.ts#L113).

---

## Architecture Decisions

### Pure composition — do not write any history UI

`NotificationHistoryButton` is exported from the overlay barrel ([overlay/index.ts:16](../../typescript-ui/src/typescript/lib/overlay/index.ts#L16)) `callable()`-wrapped, and the library's own documented recipe is a single `addComponent`/`addRight` call (`docs/recipes/notifications.md` §"Reviewing past notifications", `docs/components/NotificationHistoryButton.md` §Usage). The button self-wires in its constructor: it seeds the `clock-rotate-left` glyph, sets `aria-label="Notification history"`, and binds `on("action", …)` to toggle its own rebuild-mode `Menu`. **It requires zero app-side wiring** — no listener, no history plumbing, no menu construction. Reuse over reimplementation is a governing convention; hand-rolling a list here would be a straight violation.

### No `Spacer.flex()` — `StatusBar` already owns the right zone

Unlike the menu bar ([SqlAdminShell.ts:394](frontend/src/shell/SqlAdminShell.ts#L394)), the status bar must **not** get a manual flex spacer. `StatusBar` is internally `[leftZone, Spacer.flex(), rightZone]` ([StatusBar.ts:127-129](../../typescript-ui/src/typescript/lib/component/container/StatusBar.ts#L127)) and exposes `addRight(component)` for exactly this. The right zone is an `HBox` that appends left-to-right, so "far right" = **added last**. The app already puts the identity widget there at [SqlAdminController.ts:265](frontend/src/SqlAdminController.ts#L265); the history button is appended after it.

### `notifyError` gains a toast — this is what makes the history non-empty

`notifyError` is the app's one error sink (~60 call sites: store `exception` events, every `onError` callback, every `catch`). Today it writes a status-bar line that the *next* `setMessage` silently clobbers — an error can vanish before the user reads it. Routing it through `Notification.show(text, "error")` fixes that independently of this feature *and* is precisely what fills the history: errors are the class of message a user wants to review after the fact. The status-bar line **stays** (zero regression to the glanceable channel); the toast is additive.

### Success/progress `setMessage` sites stay status-bar-only

The other ~30 `setMessage` calls are transient chatter — `"Running…"`, `"Explaining…"`, `"refreshed"`, `"diagram (5 tables)"`, plus the per-tab-focus resync in `syncToPanel` ([SqlAdminController.ts:2597](frontend/src/SqlAdminController.ts#L2597)). Toasting those would spam the corner on every tab click and flood a 50-entry history with noise, burying the errors. They are deliberately left alone. The history's contract becomes: **errors, plus the login/preview toasts the app already shows.** That is a useful, honest history — not an audit log.

### The toast text drops the `"Error"` prefix; the status bar keeps it

The toast and the history row already carry a colour-coded error badge, so `"Error (customers): permission denied"` reads redundantly. The status bar has no badge and keeps its prefix. Both are built from one shared `detail` string, so they cannot drift.

### `flat: true, compact: true` for status-bar fit

`StatusBar` hard-caps its own height at `STATUS_BAR_HEIGHT = 22` via `setMaxSize` ([StatusBar.ts:110](../../typescript-ui/src/typescript/lib/component/container/StatusBar.ts#L110)), leaving a 21px content row (22 minus the 1px top border) that the stretching `HBox` clamps children to. A default `Button` is raised chrome with `Insets(5,10,5,10)` and a 2px ridge border + shadow — visually wrong on a 22px strip and too tall. `compact: true` collapses a glyph-only button to `Insets(2,2,2,2)` ([Button.ts:194](../../typescript-ui/src/typescript/lib/component/button/Button.ts#L194)), so 16px glyph + 4px = **20px**, inside 21px. `flat: true` drops the resting border/shadow/gradient, giving hover/pressed treatment only — the correct idiom for an icon in a chrome strip. Both are plain `ButtonOptions` fields, inherited by `NotificationHistoryButtonOptions` (`interface NotificationHistoryButtonOptions extends ButtonOptions {}`).

### Library build is already current — no `build:lib` prerequisite

sqladmin consumes the built, symlinked `dist/lib`, not source. **Verified present**: `dist/lib/overlay.es.js` contains `NotificationHistoryButton`, `getHistory`, and the `"No notifications yet"` string; `dist/lib/types/overlay/index.d.ts:14` exports the class; `dist/lib/types/overlay/Menu.d.ts:25` has `setScrollToBottomOnShow`. The artefact (2026-07-14) postdates the library merge (79736c5b, 2026-07-12). If `npx tsc --noEmit` nonetheless cannot resolve the symbol, the fix is `npm run build:lib` in `/home/jika/typescript/typescript-ui` — **never** `npm run build`.

---

## Public API

No new exported symbols. One existing method changes behaviour (signature unchanged):

```typescript
// frontend/src/SqlAdminController.ts
/** Surface an error to the StatusBar and as an error Notification (recorded in history). */
notifyError(error: unknown, ref?: DbObjectRef): void
```

---

## Ordered Implementation Steps

1. **Extend the overlay import** in [frontend/src/SqlAdminController.ts:5](frontend/src/SqlAdminController.ts#L5). Change

   ```typescript
   import { Dock, Tooltip } from "@jimka/typescript-ui/overlay";
   ```

   to

   ```typescript
   import { Dock, Notification, NotificationHistoryButton, Tooltip } from "@jimka/typescript-ui/overlay";
   ```

   Keep the file's existing column-aligned `from` position (the imports in this file are aligned to a common column — match it, don't reflow the block). → verify: `npx tsc --noEmit` resolves both symbols.

2. **Append the button to the status bar's right zone** in the `SqlAdminController` constructor, immediately after the `if (username) { … addRight(buildIdentityWidget(…)) }` block ([SqlAdminController.ts:264-266](frontend/src/SqlAdminController.ts#L264)) and as the **last** statement of the constructor:

   ```typescript
   // The notification history sits at the FAR right — appended after the
   // identity widget, since the right zone's HBox lays out left-to-right.
   // flat + compact keep the library button inside the bar's fixed 22px row.
   const historyButton = new NotificationHistoryButton({ flat: true, compact: true });

   Tooltip.attach(historyButton, "Notification history");
   this.statusBar.addRight(historyButton);
   ```

   Added unconditionally — it is not gated on `username`. `Tooltip` is already imported and already used by `buildIdentityWidget` ([SqlAdminController.ts:105](frontend/src/SqlAdminController.ts#L105)); this matches that idiom. Do **not** add a `Spacer.flex()`.

3. **Route `notifyError` through `Notification.show`.** Replace the body at [SqlAdminController.ts:2464-2468](frontend/src/SqlAdminController.ts#L2464):

   ```typescript
   /**
    * Surface an error (AjaxError detail, or any thrown value) to the StatusBar
    * and as an error Notification. The toast is what lands the error in
    * `Notification.getHistory()` — the status bar's line is clobbered by the
    * next setMessage, so the history is the only place a passed-over error
    * survives. The toast drops the "Error" prefix: its severity badge says so.
    */
   notifyError(error: unknown, ref?: DbObjectRef): void {
       const where  = ref?.name ? ` (${ref.name})` : "";
       const detail = this.errorMessage(error);

       this.statusBar.setMessage(`Error${where}: ${detail}`);
       Notification.show(ref?.name ? `${ref.name}: ${detail}` : detail, "error");
   }
   ```

   `errorMessage` ([SqlAdminController.ts:2604](frontend/src/SqlAdminController.ts#L2604)) is private on the same class — call it once and share the result. → verify: `grep -n "Notification.show" frontend/src/SqlAdminController.ts` — expect exactly one match.

4. **Confirm no other feedback path is touched.** `grep -c "statusBar.setMessage" frontend/src/SqlAdminController.ts` — the count must be unchanged from before the edit (the success/progress sites are deliberately untouched). Only `notifyError`'s body changes.

5. **Typecheck and test.** `cd frontend && npx tsc --noEmit && npm test`. Both must pass; no test asserts on `notifyError`'s channels today.

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | `frontend/src/SqlAdminController.ts` — overlay import (L5), constructor `addRight` (after L266), `notifyError` body (L2464-2468) |

No files created or deleted. `frontend/src/shell/SqlAdminShell.ts` is **not** modified.

---

## Expected Behaviour

All of the below is **manual-verify**. This repo's vitest runs in a `node` environment ([frontend/vitest.config.ts](frontend/vitest.config.ts): *"They need no DOM… component/DOM behaviour is verified live, not here"*), and every behaviour here is a library component touching `document` — `StatusBar`, `Button`, `Menu`, `Notification`. There is **no new pure logic to unit-test**: the button is library code (already unit-tested at `typescript-ui/tests/overlay/NotificationHistoryButton.test.ts`), and `notifyError`'s only added statement is a DOM-bound `Notification.show`. Do not add a test file; do not stub `document` to fake one.

1. **Button position** — the status bar's right end reads, left-to-right: `[user glyph] username`, then the clock-rotate-left icon button. The icon is the rightmost thing in the bar.
2. **Button fit** — the bar stays exactly 22px tall; the button shows no raised border/shadow at rest, and shows a hover treatment on pointer-over. The icon is not clipped and does not stretch the bar.
3. **Tooltip** — hovering the button shows "Notification history".
4. **Non-empty at boot** — `showLoginDialog` fires `Notification.show("Connected to <db>", "success")` *before* the shell (and controller) is constructed; the history is a `Notification` static, so that entry survives. Right after login, opening the menu shows **one** row: a green success badge, `Connected to sqladmin`, `just now`.
5. **Empty state** — the disabled row `No notifications yet` appears only if the history is somehow empty (it will not be on a normal login path). Library-owned; do not implement it.
6. **Error capture** — trigger an error (e.g. open a table you lack SELECT on, or run `SELECT * FROM nope;` in a query panel). Expect **both**: the status-bar line `Error (nope): <detail>`, and an error toast reading `nope: <detail>` (no `Error` prefix). Reopen the history menu: a new row with a red error badge, that same text, `just now`.
7. **Errors survive clobbering** — after the error, click another tab (which resyncs the status bar via `syncToPanel` and overwrites the line). The error is gone from the bar but **still listed** in the history menu. This is the feature's point.
8. **Progress messages are NOT captured** — run a query successfully. `"Running…"` / `"OK"` / `"N rows"` appear in the status bar and must produce **no** toast and **no** history row.
9. **Menu ordering and re-open** — with several entries, the menu opens scrolled to the bottom, latest last. Clicking a row opens a modal detail dialog with the full message and adds **no** new history row (`showDetail` does not record).
10. **Cap** — after >50 notifications the oldest are evicted (library-owned, `HISTORY_CAP = 50`); history does not persist across a page reload.
11. **Toast burst** — a multi-row save failure calls `notifyError` once per failure ([SqlAdminController.ts:2456](frontend/src/SqlAdminController.ts#L2456)), producing one toast per failure. They stack and auto-dismiss; each is a separate history row. This is accepted, not a bug.

---

## Verification

- `cd frontend && npx tsc --noEmit` — clean.
- `cd frontend && npm test` — all existing tests pass (none touch this path).
- `grep -n "Notification.show" frontend/src/SqlAdminController.ts` — exactly one match, inside `notifyError`.
- `grep -n "Spacer" frontend/src/SqlAdminController.ts` — expect zero matches (no manual flex spacer was added).
- Manual smoke (`cd frontend && npm run dev`, log in with **Host `sqladmin-db`**, not `localhost`): walk Expected Behaviour 1-4 and 6-9 against the running app. The status bar is the strip at the bottom of the shell; the button is its rightmost widget.

---

## Potential Challenges

- **`dist/lib` staleness** — if `tsc` cannot resolve `NotificationHistoryButton`, run `npm run build:lib` in `/home/jika/typescript/typescript-ui` (not `npm run build`), then re-run `tsc`. Verified current at plan time, so this should not fire.
- **Button too tall for the 22px strip** — if the icon looks clipped despite `flat`+`compact`, the fix is in the options bag (e.g. a smaller `glyph` `preferredSize`), never by changing `StatusBar`'s height or by copying the button into the app.
- **Error-toast fatigue** — a failing store retry loop could toast repeatedly. Out of scope; if it bites, debounce at the call site, not in `notifyError`.
- **Import-block alignment** — `SqlAdminController.ts`'s import block is column-aligned to a very wide `from` column. Editing line 5 must preserve that alignment; a reflow would produce a huge, noisy diff.

---

## Critical Files

- [`../../typescript-ui/src/typescript/lib/overlay/NotificationHistoryButton.ts`](../../typescript-ui/src/typescript/lib/overlay/NotificationHistoryButton.ts) — read the constructor and `buildItems`; confirms zero wiring is needed and the empty state is library-owned.
- [`../../typescript-ui/src/typescript/lib/component/container/StatusBar.ts`](../../typescript-ui/src/typescript/lib/component/container/StatusBar.ts) — `STATUS_BAR_HEIGHT` (L17), the three-zone construction (L127-129), `addRight` (L188).
- [`../../typescript-ui/src/typescript/lib/component/button/Button.ts`](../../typescript-ui/src/typescript/lib/component/button/Button.ts) — `flat` (L140) / `compact` (L150) option docs and the compact glyph insets (L194).
- [`../../typescript-ui/docs/recipes/notifications.md`](../../typescript-ui/docs/recipes/notifications.md) §"Reviewing past notifications" — the library's documented composition recipe; follow it.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — the only file modified: `buildIdentityWidget` (L99), constructor right-zone wiring (L264-266), `notifyError` (L2465), `errorMessage` (L2604).
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — class-first rules. This change adds no new component, so the class-first migration does not apply; it is a two-line composition edit inside an existing class.

---

## Non-Goals

- **No bespoke history UI.** No app-side list, panel, or dialog. The library button is the whole feature.
- **No `Notification` subclass, wrapper, or app-level `notify(message, type)` façade.** The two existing direct `Notification.show` call sites (LoginDialog, SqlPreviewDialog) stay as they are.
- **No conversion of success/progress `setMessage` sites to toasts.** Deliberate — see Architecture Decisions.
- **No persistence of history across reloads.** The library's history is explicitly in-session; adding localStorage would fork the library's contract.
- **No changes to `SqlAdminShell.ts`.** It mounts `controller.statusBar` whole; the button rides along.
- **No touching `/home/jika/typescript/typescript-ui`.** Reference only. The one exception is running `npm run build:lib` if and only if the dist check fails.
