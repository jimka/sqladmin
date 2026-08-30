---
touches-shared: [frontend/src/shell/aboutDialog.ts, frontend/src/shell/changelogDialog.ts, frontend/src/shell/shortcutsDialog.ts, frontend/src/dock/SqlPreviewDialog.ts, frontend/src/dock/ImportRowsDialog.ts, frontend/src/dock/QueryPanel.ts]
---

# Dialog Subclass Foundation — Implementation Plan

## Overview

Two shared UI pieces are introduced and adopted, extending
[`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md)'s
class-first convention to dialogs.

`DismissDialog` (new, `frontend/src/shell/DismissDialog.ts`) is a `Dialog`
subclass for a dismiss-only information modal: a padded content wrapper, a
`Close` button, backdrop-dismiss. It replaces the Panel→`Dialog`→`show()`
sequence that [`aboutDialog.ts:61-87`](frontend/src/shell/aboutDialog.ts#L61),
[`changelogDialog.ts:45-71`](frontend/src/shell/changelogDialog.ts#L45), and
[`shortcutsDialog.ts:26-49`](frontend/src/shell/shortcutsDialog.ts#L26) each
build by hand, along with the `CONTENT_PAD = 16` all three declare separately.
Moving the content wrapper into the base removes a live defect:
[`shortcutsDialog.ts:36`](frontend/src/shell/shortcutsDialog.ts#L36) sets
`autoScroll: "y"` on its content, nesting a second scroll region inside
`Dialog`'s own already-scrolling content container, so the Shortcuts dialog
shows two stacked scrollbars whenever the legend overflows the viewport.
[`changelogDialog.ts:11-19`](frontend/src/shell/changelogDialog.ts#L11)
diagnosed and removed that same defect from its own dialog; `shortcutsDialog.ts`
never got the fix.

`ErrorBanner` (new, `frontend/src/dock/ErrorBanner.ts`) is a `Container`
subclass for the dismissible in-content error row currently written out three
times: [`SqlPreviewDialog.ts:82,159-225`](frontend/src/dock/SqlPreviewDialog.ts#L159),
[`ImportRowsDialog.ts:77,127-188`](frontend/src/dock/ImportRowsDialog.ts#L127),
and [`QueryPanel.ts:123,636-676`](frontend/src/dock/QueryPanel.ts#L636). Each
copy declares the same background token, builds the same glyph + wrapping text +
dismiss button row, and carries the same show / hide / dispose-if-detached
trio. All three adopt the shared class.

Nothing outside the error-banner code changes in those three host files.
`QueryPanel.ts` in particular keeps its tab-swap logic untouched, and only the
one header paragraph describing the banner is rewritten.

---

## Architecture Decisions

### Dialogs become `Dialog` subclasses, not shared open-functions

A reusable dialog is a class that `extends` the library's callable `Dialog`
export, following
[`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md)
sections (a), (b), (d) and (e) exactly as `QueryPanelContent`
([`frontend/src/dock/QueryPanel.ts:191`](frontend/src/dock/QueryPanel.ts#L191))
already applies them to `Container`.[^why-subclass] The composition fallback in section (f) does not
apply: none of these dialog bodies is a closure-dense factory, so the `extends`
form carries them without a rewrite.[^no-composition]

### `DismissDialog` owns the padded content wrapper

`DismissDialog`'s constructor builds the `Panel` (VBox, `itemAlign: "stretch"`,
a 16px inset on all four sides) and hands it to `super()` as
`contentComponent`. Callers pass the bare body component and never see the
wrapper.[^wrapper-owned]

The wrapper never sets `autoScroll`. The library's `Dialog` already wraps
whatever `contentComponent` it is handed in a `Panel` with `autoScroll: "y"`,
so a second one nests one scroll region inside another.

### `ErrorBanner` owns its own attach and detach

The shared class holds the host component, the layout constraints to attach
with, and an `onChange` callback the host uses to relayout. `show(error)` and
`hide()` do the attach/detach and fire `onChange`. Callers keep no
`errorBannerShown` flag of their own — they read `isShown()`.[^banner-owns-attach]

### `ErrorBanner` is constructed eagerly

Each host builds its banner once, up front, instead of lazily on first failure.
The instance is not attached until `show()`, so an unused banner costs four
never-rendered components and no DOM.[^eager]

### The base class's teardown already disposes a Markdown body

`aboutDialog.ts` and `changelogDialog.ts` currently call `md.dispose()` from
their `show()` continuation. Both calls are dropped: `Dialog`'s own teardown
recurses into the content component and reaches the `Markdown` instance's
`destructor()`, which is what releases the theme subscription.[^teardown-chain]

### A detached `ErrorBanner` is disposed by its owner

`SqlPreviewDialog` and `ImportRowsDialog` each call `errorBanner.dispose()`
unconditionally in the `finally` that follows `dialog.show()`.
`QueryPanelContent.destructor()` calls `this._errorBanner.dispose()`. Both
replace a `disposeDetachedErrorBanner()` helper that had to check
attachment first.[^unconditional-dispose]

---

## Public API

### `frontend/src/shell/DismissDialog.ts`

```ts
import type { Component }           from "@jimka/typescript-ui/core";
import type { DialogButtonConfig }  from "@jimka/typescript-ui/overlay";

/** Construction inputs for {@link DismissDialog}. */
export interface DismissDialogOptions {
    /** Title-bar text. */
    title: string;
    /** The dialog body. Mounted inside the padded content wrapper this class owns. */
    content: Component;
    /** Dialog panel width in pixels. */
    width: number;
    /**
     * Extra footer buttons rendered to the LEFT of the always-present Close
     * button, in array order. Omit for a Close-only dialog.
     */
    extraButtons?: DialogButtonConfig[];
}

class DismissDialog extends Dialog {
    constructor(options: DismissDialogOptions);
}

const DismissDialogCallable = callable(DismissDialog);
type  DismissDialogCallable = DismissDialog;
export { DismissDialogCallable as DismissDialog };
```

The footer is always `[...extraButtons, DialogButtons.Close]`, and
`closeOnBackdrop` is always `true`. `Dialog` derives its title-bar tone from the
set of button *results* — a lone `confirm` gives the info tone, `confirm` plus
`cancel` gives the affirm tone, anything else stays plain — so the tone follows
from `extraButtons` with no extra option:

| Caller | `extraButtons` | Footer, left to right | Result set | Header tone |
|---|---|---|---|---|
| `openChangelogDialog` | omitted | Close | `{close}` | plain |
| `openShortcutsDialog` | omitted | Close | `{close}` | plain |
| `openAboutDialog` | `[DIAGNOSTICS_BUTTON]` | Debug, Close | `{confirm, close}` | plain |

All three are `plain` today and stay `plain`.

### `frontend/src/dock/ErrorBanner.ts`

```ts
import type { Component }          from "@jimka/typescript-ui/core";
import type { LayoutConstraints }  from "@jimka/typescript-ui/layout";

/** Construction inputs for {@link ErrorBanner}. */
export interface ErrorBannerOptions {
    /** The component the banner attaches to while shown. */
    host: Component;
    /** Constraints passed to `host.addComponent`. Omit for a plain append. */
    constraints?: LayoutConstraints;
    /** Run after every attach and detach, so the host can relayout. */
    onChange?: () => void;
}

class ErrorBanner extends Container {
    constructor(options: ErrorBannerOptions);

    /** Whether the banner is currently attached to its host. */
    isShown(): boolean;

    /** Set the message from `error` and attach to the host if not already shown. */
    show: (error: unknown) => void;

    /** Detach from the host. A no-op when not shown. */
    hide: () => void;
}

const ErrorBannerCallable = callable(ErrorBanner);
type  ErrorBannerCallable = ErrorBanner;
export { ErrorBannerCallable as ErrorBanner };
```

`show`/`hide` are arrow-function fields, not plain methods, per
`COMPONENT_CONVENTIONS.md` section (c) — they are safe under both `banner.hide()`
and a by-reference `on("action", banner.hide)`.

`show(error)` normalizes its argument the same way all three current copies do:

| `error` argument | Message shown |
|---|---|
| `new Error("relation does not exist")` | `relation does not exist` |
| `"Choose a file to import first."` | `Choose a file to import first.` |
| `{ code: 42 }` | `[object Object]` |

### `QueryPanelContent` (changed, `frontend/src/dock/QueryPanel.ts`)

```ts
class QueryPanelContent extends Container {
    private readonly _resultHost : TabPanel;
    private readonly _errorBanner: ErrorBanner;

    /**
     * @param resultHost - The result pane, which the panel detaches while hidden.
     * @param onErrorBannerChange - Run after the banner is shown or hidden,
     *   in addition to this component's own relayout.
     */
    constructor(resultHost: TabPanel, onErrorBannerChange: () => void);

    /** The panel's durable error banner. */
    getErrorBanner(): ErrorBanner;

    protected destructor(): void;
}
```

The second constructor parameter replaces the current
`getErrorBanner: () => Component | null` late-binding closure. The banner is now
built inside `QueryPanelContent`, so nothing needs late binding.

---

## Internal Structure

### `DismissDialog`

Per `COMPONENT_CONVENTIONS.md` section (b), the wrapper is a **local** built
before `super()`:

```ts
class DismissDialog extends Dialog {
    constructor(options: DismissDialogOptions) {
        const body = Panel({
            layoutManager: new VBox({ itemAlign: "stretch" }),
            insets:        new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
            components:    [options.content],
        });

        super({
            title:            options.title,
            contentComponent: body,
            buttons:          [...(options.extraButtons ?? []), DialogButtons.Close],
            width:            options.width,
            closeOnBackdrop:  true,
        });
    }
}
```

`CONTENT_PAD = 16` is a module constant here and exists nowhere else.

### `ErrorBanner`

Child widgets are locals before `super()`; the dismiss button is wired after,
since its handler needs `this`:

```ts
class ErrorBanner extends Container {
    private readonly _message    : Text;
    private readonly _host       : Component;
    private readonly _constraints: LayoutConstraints | undefined;
    private readonly _onChange   : (() => void) | undefined;
    private _shown = false;

    constructor(options: ErrorBannerOptions) {
        const icon    = new Glyph("circle-exclamation", { foregroundColor: DESTRUCTIVE_COLOR });
        const message = new Text("", { whiteSpace: "normal", truncate: false });

        super({ layoutManager: new HBox({ spacing: BANNER_SPACING, itemAlign: "stretch" }) });

        this._message     = message;
        this._host        = options.host;
        this._constraints = options.constraints;
        this._onChange    = options.onChange;

        this.addComponent(icon);
        this.addComponent(message, { weight: 1 });
        this.addComponent(glyphButton("xmark", NEUTRAL_COLOR, "Dismiss", () => this.hide()));
        this.setBackgroundColor(ERROR_BANNER_BG);
    }

    isShown(): boolean {
        return this._shown;
    }

    show = (error: unknown): void => {
        this._message.setText(error instanceof Error ? error.message : String(error));

        if (!this._shown) {
            this._host.addComponent(this, this._constraints);
            this._shown = true;
            this._onChange?.();
        }
    };

    hide = (): void => {
        if (this._shown) {
            this._host.removeComponent(this);
            this._shown = false;
            this._onChange?.();
        }
    };
}
```

The module owns `ERROR_BANNER_BG` (the
`var(--ts-ui-notification-error-bg, rgba(244, 214, 214, 0.75))` literal, with
[`QueryPanel.ts:117-123`](frontend/src/dock/QueryPanel.ts#L117)'s comment moved
across verbatim), `BANNER_SPACING = 8`, and its own
`Glyph.register(circle_exclamation, xmark)`.

---

## Ordered Implementation Steps

1. **Create `frontend/src/shell/DismissDialog.ts`.** The class body from
   `## Internal Structure`, the `DismissDialogOptions` interface from
   `## Public API`, the `CONTENT_PAD = 16` constant, and the `callable()`
   export. Add a module header comment stating the contract: a dismiss-only
   modal; the base owns the padded content wrapper; the content must not set
   `autoScroll`, because `Dialog`'s own content container already scrolls.
   Imports: `Dialog`, `DialogButtons` and `type DialogButtonConfig` from
   `@jimka/typescript-ui/overlay`; `Panel`, `callable` and `type Component`
   from `@jimka/typescript-ui/core`; `VBox` from `@jimka/typescript-ui/layout`;
   `Insets` from `@jimka/typescript-ui/primitive`.
   Check: `npm --prefix frontend run typecheck`.

2. **Rewrite `frontend/src/shell/changelogDialog.ts` onto `DismissDialog`.**
   `openChangelogDialog`'s whole body becomes:

   ```ts
   const dialog = new DismissDialog({
       title:   `${APP_NAME} ${APP_VERSION}`,
       content: Markdown(CHANGELOG_MARKDOWN),
       width:   DIALOG_WIDTH,
   });

   void dialog.show();
   ```

   Drop `CONTENT_PAD`, the content `Panel`, the `md` local and its `dispose()`
   continuation, and the now-unused `Dialog`, `DialogButtons`, `Panel`, `VBox`,
   `Insets` imports. Keep `DIALOG_WIDTH = 600`. Replace the module comment's
   nested-scroll paragraph (lines 11-19) and the in-function comment at 46-51
   with one sentence saying `DismissDialog` owns the padded content wrapper —
   without repeating the option name, so the grep check below stays meaningful.
   Check: `npm --prefix frontend run typecheck`.

3. **Rewrite `frontend/src/shell/shortcutsDialog.ts` onto `DismissDialog`.**
   `openShortcutsDialog`'s whole body becomes:

   ```ts
   const dialog = new DismissDialog({
       title:   "Keyboard Shortcuts",
       content: buildShortcutLegend(),
       width:   DIALOG_WIDTH,
   });

   void dialog.show();
   ```

   **The `autoScroll: "y"` at line 36 is deleted along with the `Panel` it sat
   on** — this is the bug fix. Drop `CONTENT_PAD` and the `Dialog`,
   `DialogButtons`, `Panel`, `VBox`, `Insets` imports. Keep
   `DIALOG_WIDTH = 420`. Delete the in-function comment at lines 27-32, whose
   last sentence argues for keeping `autoScroll`.
   Check: `grep -n 'autoScroll' frontend/src/shell/shortcutsDialog.ts frontend/src/shell/changelogDialog.ts`
   — expect zero matches.

4. **Rewrite `frontend/src/shell/aboutDialog.ts` onto `DismissDialog`.**
   Annotate `DIAGNOSTICS_BUTTON` as `DialogButtonConfig` (importing the type
   from `@jimka/typescript-ui/overlay`), drop its `as const` on `result`, and
   trim the sentence in its comment that explains that `as const`. Then
   `openAboutDialog`'s whole body becomes:

   ```ts
   const dialog = new DismissDialog({
       title:        `About ${APP_NAME}`,
       content:      Markdown(ABOUT_MARKDOWN),
       width:        DIALOG_WIDTH,
       extraButtons: [DIAGNOSTICS_BUTTON],
   });

   void dialog.show().then((result) => {
       if (result === "confirm") {
           DiagnosticsOverlay.open();
       }
   });
   ```

   Drop `CONTENT_PAD`, the content `Panel`, the `md` local and its `dispose()`,
   and the now-unused `Dialog`, `DialogButtons`, `Panel`, `VBox`, `Insets`
   imports. Keep `Glyph`, `gauge_high`, `Markdown`, `DiagnosticsOverlay`, and
   `DIALOG_WIDTH = 460`.
   Check: `grep -rn 'CONTENT_PAD' frontend/src/` — expect matches only in
   `frontend/src/shell/DismissDialog.ts`.

5. **Create `frontend/src/dock/ErrorBanner.ts`.** The class body and constants
   from `## Internal Structure`, the `ErrorBannerOptions` interface from
   `## Public API`, and the `callable()` export. Imports: `Container`,
   `callable` and `type Component` from `@jimka/typescript-ui/core`; `HBox` and
   `type LayoutConstraints` from `@jimka/typescript-ui/layout`; `Text` from
   `@jimka/typescript-ui/component/input`; `Glyph` from
   `@jimka/typescript-ui/component/display`; `circle_exclamation` and `xmark`
   from their glyph modules; `glyphButton` from `./glyphButton`;
   `DESTRUCTIVE_COLOR`, `NEUTRAL_COLOR` from `../theme`. Module header comment:
   one owner for the in-content error row, so the query panel and the two DDL
   dialogs cannot drift apart; the banner attaches itself to `host` on `show()`
   and detaches on `hide()`; `onChange` is where the host relayouts.
   Check: `npm --prefix frontend run typecheck`.

6. **Adopt `ErrorBanner` in `frontend/src/dock/ImportRowsDialog.ts`.** Delete
   lines 127-188 (the `errorBanner`/`errorBannerText`/`errorBannerShown` locals
   and the `ensureErrorBanner` / `showError` / `hideErrorBanner` /
   `disposeDetachedErrorBanner` functions) and the `ERROR_BANNER_BG` constant
   at 74-77. After `content` is built, add:
   `const errorBanner = new ErrorBanner({ host: content, onChange: () => dialog.resizeToContent() });`
   Rewrite call sites: `hideErrorBanner()` → `errorBanner.hide()` (line 208);
   `showError(err)` → `errorBanner.show(err)` (lines 216, 227, 274);
   `showError(blockedReason())` → `errorBanner.show(blockedReason())` (line 258);
   the `finally` at 298-300 → `errorBanner.dispose();`. Remove the now-unused
   imports: `Container` (leaving `Panel`), `HBox` (leaving `VBox`), `Glyph`,
   `circle_exclamation`, `xmark`, `glyphButton`, and the whole
   `DESTRUCTIVE_COLOR, NEUTRAL_COLOR` line — plus the `Glyph.register(...)`
   call at line 44. Keep `Text` (still used for `summary`). Update the module
   comment at 18-23 to name `ErrorBanner` instead of the deleted helper trio.
   Check: `npm --prefix frontend run typecheck` (`noUnusedLocals` catches any
   import left behind).

7. **Adopt `ErrorBanner` in `frontend/src/dock/SqlPreviewDialog.ts`.** Delete
   lines 159-225 and the `ERROR_BANNER_BG` constant at 78-82. After `content` is
   built, add:
   `const errorBanner = new ErrorBanner({ host: content, onChange: () => dialog.resizeToContent() });`
   Rewrite call sites: `showError(err)` becomes two statements —
   `reportError(err, options.onError);` then `errorBanner.show(err);` — at
   lines 238 and 257; `hideErrorBanner()` → `errorBanner.hide()` (lines 233,
   249); the `finally` at 283-285 → `errorBanner.dispose();`. Keep the
   module-level `reportError` function unchanged. Remove the now-unused
   imports: `Container` (leaving `Panel`), `HBox` (leaving `VBox`), `Text`,
   `Glyph`, `circle_exclamation`, `xmark`, `glyphButton`, and the whole
   `DESTRUCTIVE_COLOR, NEUTRAL_COLOR` line — plus the `Glyph.register(...)`
   call at line 49. Update the module comment at 20-27 to name `ErrorBanner`.
   Check: `npm --prefix frontend run typecheck`.

8. **Adopt `ErrorBanner` in `frontend/src/dock/QueryPanel.ts` — the class.**
   Give `QueryPanelContent` (lines 191-222) the signature from `## Public API`:
   a second constructor parameter `onErrorBannerChange: () => void`, a
   `_errorBanner` field built in the constructor with
   `{ host: this, constraints: { placement: Placement.SOUTH }, onChange: () => { this.doLayout(); onErrorBannerChange(); } }`,
   a `getErrorBanner()` accessor, and a `destructor()` that calls
   `this._resultHost.dispose(); this._errorBanner.dispose(); super.destructor();`.
   Delete the `_getErrorBanner` field and its constructor doc paragraph about
   late binding.
   Check: `npm --prefix frontend run typecheck`.

9. **Adopt `ErrorBanner` in `frontend/src/dock/QueryPanel.ts` — the call sites.**
   Delete the three banner locals at lines 269-271 and the `ensureErrorBanner` /
   `showErrorBanner` / `hideErrorBanner` functions at 636-676, plus the
   `ERROR_BANNER_BG` constant at 117-123. Change line 337 to
   `const panel = new QueryPanelContent(resultHost, () => syncToolbarButtons());`
   and add `const errorBanner = panel.getErrorBanner();` right after it. Rewrite
   call sites: `hideErrorBanner()` → `errorBanner.hide()` (lines 585, 831);
   `showErrorBanner(error)` → `errorBanner.show(error)` (line 847);
   `errorBannerShown` → `errorBanner.isShown()` (line 622). Remove the now-unused
   imports: `HBox` from the layout line, the whole `Text` import line, the
   `circle_exclamation` and `xmark` import lines, `DESTRUCTIVE_COLOR` from the
   theme import line, and `circle_exclamation, xmark` from the `Glyph.register`
   call at line 106. Keep `Container`, `Glyph`, `Placement`, `NEUTRAL_COLOR`,
   `glyphButton`. Update two comments to name the new API instead of the deleted
   functions: the "durable error banner" block at 265-268, and the phrase
   `see hideResultPane / hideErrorBanner` in the module header at line 53
   (→ `see hideResultPane / ErrorBanner.hide`). Leave every other part of
   `QueryPanel.ts` alone.
   Check: `grep -rn 'ERROR_BANNER_BG\|ensureErrorBanner\|showErrorBanner\|hideErrorBanner\|errorBannerText\|errorBannerShown\|disposeDetachedErrorBanner' frontend/src/`
   — expect matches only in `frontend/src/dock/ErrorBanner.ts`
   (`ERROR_BANNER_BG` alone).

10. **Add section (g) to `frontend/COMPONENT_CONVENTIONS.md`.** A short section
    after (f), "Dialogs are `Dialog` subclasses": a reusable dialog `extends`
    the callable `Dialog` export and passes its `contentComponent` as a
    pre-`super()` local, per (a) and (b); `DismissDialog` is the worked example;
    a dialog that needs footer-button guards or a non-dismissable modal extends
    `Dialog` directly rather than `DismissDialog`; a subclass never sets
    `autoScroll` on its content, because `Dialog`'s content container already
    scrolls. Keep it to roughly the length of section (e).

11. **Full check.** `npm --prefix frontend run typecheck && npm --prefix frontend test && npm --prefix frontend run build`,
    then the manual smoke tests in `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/shell/DismissDialog.ts` |
| Create | `frontend/src/dock/ErrorBanner.ts` |
| Modify | `frontend/src/shell/aboutDialog.ts` |
| Modify | `frontend/src/shell/changelogDialog.ts` |
| Modify | `frontend/src/shell/shortcutsDialog.ts` |
| Modify | `frontend/src/dock/SqlPreviewDialog.ts` |
| Modify | `frontend/src/dock/ImportRowsDialog.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/COMPONENT_CONVENTIONS.md` |

---

## Expected Behaviour

The frontend's vitest suite runs in the `node` environment
(`frontend/vitest.config.ts`) and covers pure helpers only, so **every
behaviour below is manual-verify**; none is unit-testable without a DOM.

**`DismissDialog`**

1. Opening About, Changelog, or Shortcuts shows a modal with a 16px inset on
   all four sides of its body — the same padding as before the change.
2. Each of the three closes on the Close button, on Escape, on a backdrop
   click, and on the title-bar close.
3. About shows `Debug` then `Close`, left to right. Clicking `Debug` closes the
   dialog and opens the DiagnosticsOverlay; clicking `Close` (or dismissing any
   other way) opens nothing.
4. All three title bars keep the plain (untinted) tone they have today.
5. With the browser window shrunk below the content height, each dialog caps to
   the viewport and its body scrolls with **exactly one** vertical scrollbar.
   Shortcuts is the regression case: two stacked scrollbars today, one after.
6. Enlarging the window again re-grows the dialog toward its content instead of
   staying at the smaller capped height.
7. Opening the Changelog dialog, closing it, and reopening it a few times leaves
   no growth in the library DiagnosticsOverlay's listener count — the Markdown
   body's theme subscription is released on each close.

**`ErrorBanner`**

8. Run a failing statement in a query tab: the banner appears at the bottom of
   the panel with the error's `message`, an exclamation glyph, and a dismiss
   button. The Clear button becomes enabled.
9. Click the banner's dismiss button: the banner disappears and the panel
   relayouts. With an empty editor and no result shown, the Clear button becomes
   disabled again.
10. Run a second failing statement while the banner is already shown: the text
    updates in place and no second banner is added.
11. Starting a new run, or pressing Clear, hides the banner.
12. Open a table's Import dialog and press Import with no file chosen: the
    banner reads `Choose a file to import first.` and the dialog stays open.
13. Drop a malformed CSV: the banner shows the parse error, the preview grid
    resets to empty, and the dialog grows to fit the banner.
14. In a DDL dialog (e.g. Create table), submit SQL that fails: the banner shows
    the message, the dialog stays open with the form and SQL intact, and the
    caller's own error reporting still fires (status-bar text, notification
    history) exactly as before.
15. Dismiss a DDL dialog's banner, then close the dialog: no error and no
    console warning. Repeat without dismissing it first — the `finally` disposes
    the banner either way, and the second dispose of an attached banner is a
    documented no-op.
16. Close a query tab while its banner is dismissed (not shown): no error, and
    the DiagnosticsOverlay's component count drops rather than plateauing.

---

## Verification

- `npm --prefix frontend run typecheck` — the primary gate. `noUnusedLocals`
  and `noUnusedParameters` are on, so any import left behind by steps 6-9 fails
  here.
- `npm --prefix frontend test` — the existing suite must stay green. No test
  changes are expected; none of the touched modules has a test.
- `npm --prefix frontend run build`.
- Grep invariants:
  - `grep -rn 'CONTENT_PAD' frontend/src/` → only `frontend/src/shell/DismissDialog.ts`.
  - `grep -n 'autoScroll' frontend/src/shell/shortcutsDialog.ts frontend/src/shell/changelogDialog.ts frontend/src/shell/aboutDialog.ts` → zero matches. (Other `frontend/src/shell/` files use `autoScroll` legitimately; only these three must stop.)
  - `grep -rn 'ERROR_BANNER_BG' frontend/src/` → only `frontend/src/dock/ErrorBanner.ts`.
  - `grep -rn 'ensureErrorBanner\|showErrorBanner\|hideErrorBanner\|errorBannerText\|errorBannerShown\|disposeDetachedErrorBanner' frontend/src/` → zero matches.
  - `grep -n '\bDialog(' frontend/src/shell/aboutDialog.ts frontend/src/shell/changelogDialog.ts frontend/src/shell/shortcutsDialog.ts` → zero matches. (The word boundary makes this skip `DismissDialog(`, which is what those three now construct.)
- Manual smoke tests, driving the app per the `verify` skill: the menu bar's
  About / Changelog / Shortcuts entries (and the `?` accelerator) for cases 1-7;
  a query tab for cases 8-11 and 16; a table's Data tab → Import for cases 12-13;
  any Create/Alter action for cases 14-15.

---

## Documentation Impact

`frontend/COMPONENT_CONVENTIONS.md` gains section (g) (step 10). It is the
document the two follow-on plans will read for the dialog-subclass shape, so it
must state the contract, not just point at the example.

`CHANGELOG.md` is **not** touched. Per `release-steps.md`, changelog sections
are written at release time, not per feature branch. The Shortcuts
double-scrollbar fix is a user-visible `Fixed` entry for whoever cuts the next
release.

---

## Potential Challenges

- **`extends` on a `callable()` export.** The library exports `Dialog` and
  `Container` as `callable()` Proxies. Extending them, and overriding the
  `protected destructor()`, both typecheck — this was confirmed against the
  installed 0.8.0 `.d.ts` before writing this plan.[^probe] If a `Base
  constructor return type` error appears anyway, that is a signal something
  else is wrong; do not switch to the underscore alias (`_Dialog`), which
  `COMPONENT_CONVENTIONS.md` section (a) rules out.
- **`dialog` is referenced from an `ErrorBanner` `onChange` declared before it.**
  In both DDL dialogs the `onChange` arrow closes over the `const dialog`
  declared further down the function. The arrow only ever runs after `dialog`
  is assigned, exactly like the existing `editor.on("heightchange", …)` closure
  in `SqlPreviewDialog.ts:146-149`. Keep the banner's construction after
  `content` and before `dialog`.
- **`syncToolbarButtons` is referenced before its declaration in `QueryPanel`.**
  Step 9 passes `() => syncToolbarButtons()` at line 337 while the function is
  declared at line 619. Function declarations hoist within the constructor
  body, and the first actual call is at line 1284, so this is safe — but keep
  the arrow wrapper rather than passing the bare identifier.
- **Removing `autoScroll` changes how Shortcuts scrolls.** The eased wheel
  scroll moves from the inner panel to `Dialog`'s own content container. That
  is the intended outcome and matches Changelog's behaviour today; verify case 5
  on a short viewport rather than assuming it.

---

## Critical Files

- `frontend/COMPONENT_CONVENTIONS.md` — sections (a) `extends` the callable
  base, (b) the super-cascade trap, (c) arrow-function handler fields, (d) the
  instance is the component and the `callable()` export form, (e)
  `constructor.name` becomes the CSS class, (f) when composition is the
  fallback instead. Read in full; it governs both new classes.
- `frontend/src/dock/QueryPanel.ts:191-222` — `QueryPanelContent`, the in-repo
  worked example of a library-base subclass: pre-`super()` locals, fields
  assigned after, and a `protected destructor()` override reaching a child the
  normal recursion cannot. `DismissDialog` and `ErrorBanner` copy its
  construction shape; only `QueryPanelContent` itself keeps a `destructor()`.
- `frontend/node_modules/@jimka/typescript-ui/dist/lib/types/overlay/Dialog.d.ts`
  — `DialogConfig`, `DialogButtonConfig`, `DialogButtons`, `resizeToContent()`,
  `getContentComponent()`, and the `protected destructor()` the subclass may
  override.
- `frontend/src/shell/changelogDialog.ts:11-19` — the existing diagnosis of the
  nested-scroll defect this plan removes from `shortcutsDialog.ts`.
- `frontend/src/dock/glyphButton.ts` — the precedent for a shared, single-owner
  dock widget module; `ErrorBanner.ts` sits beside it and uses it.
- `frontend/src/shell/LoginDialog.ts:65-112` — the app's other composed dialog.
  It is **not** converted here (see `## Non-Goals`), but shows the
  `Dialog`-as-field shape that section (g) supersedes for new work.
- `plans/research/codebase-health-audit-2026-08-29.md` — Priority 1 #7,
  Priority 2 #2 and #13, the findings this plan closes.

---

## Non-Goals

- **Converting `SqlPreviewDialog`, `ImportRowsDialog`, `LoginDialog`, or
  `promptQueryName` to `Dialog` subclasses.** They adopt `ErrorBanner` (the
  first two) and nothing else. Each has a live retry/guard flow whose
  conversion is its own change, and the DDL-form plan that follows this one
  reshapes `SqlPreviewDialog` anyway.
- **Anything in `QueryPanel.ts` outside its error banner.** The tab-swap
  duplication and the header comments are owned by the query-workspace plan.
- **Extracting a shared `errorMessage(err)` helper for the app's other six
  `err instanceof Error ? … : String(err)` sites.** `ErrorBanner` absorbs the
  three that belong to it; the rest are unrelated call sites.
- **Adding a `severity` or `dismissable` option to `DismissDialog`.** A dialog
  that needs either extends `Dialog` directly. Keeping the dismiss-only base
  minimal is what makes its contract worth documenting.
- **Editing `CHANGELOG.md`.** See `## Documentation Impact`.

---

## Implementation Notes

- **`ErrorBanner.show()` fires `onChange` on every call, not just the
  attach.** `## Internal Structure`'s sketch put `this._onChange?.()` inside
  the `if (!this._shown)` guard, matching `QueryPanel.ts`'s original
  `showErrorBanner`. But the other two original copies —
  `SqlPreviewDialog.ts`'s and `ImportRowsDialog.ts`'s `showError` —  called
  `dialog.resizeToContent()` *unconditionally*, after the guard, so a second
  failure's (possibly longer) message still resized the dialog even though
  the banner was already shown. `SqlPreviewDialog.ts` masked this because
  both its call sites `hide()` the banner before every `show()`, so the
  guard's `false` branch never ran in practice — but `ImportRowsDialog.ts`'s
  `tryImport()` calls `show()` directly on an already-shown banner (a second
  blocked/failed Import with the banner still up from the first), where the
  sketch's version would have left the dialog un-resized for the new
  message. Firing `onChange` unconditionally in `show()` matches both DDL
  dialogs' original behaviour exactly and is a harmless superset for
  `QueryPanel.ts` (one extra, idempotent relayout call on a repeat error).
  Found during the audit's BLOCKING pass, not during initial implementation.

---

## Notes

[^why-subclass]: The audit's own suggestion for finding #13 was a shared
    `openDismissDialog({title, width, content})` function. The app owner's
    direction is the class form instead, and it is the one that matches the
    repo: `COMPONENT_CONVENTIONS.md` describes an in-progress migration *away*
    from capitalized factory functions toward classes that `extends` a library
    base, and a new shared factory would be a fresh instance of the pattern
    being retired. The class form also gives the two follow-on plans something
    to extend — a function gives them nothing. There is no existing `Dialog`
    subclass in either the app or the library to copy, so the nearest precedent
    is `QueryPanelContent` (`frontend/src/dock/QueryPanel.ts:191`), a
    `Container` subclass built the same way: pre-`super()` locals, fields
    assigned after, a `protected destructor()` override.
    `COMPONENT_CONVENTIONS.md` section (a) is why `extends Dialog` and not
    `extends _Dialog`: the underscore alias is explicitly ruled out, and the
    library's own architecture doc carries the matching rule (imports always use
    the callable name, `extends` clauses included).

[^no-composition]: Section (f) exists for factories like `QueryPanel` (~700
    lines, ~25 interdependent closures) where hoisting into an `extends` class
    under the super-cascade constraint is a wholesale rewrite. The three info
    dialogs are 50-90 lines each with no closures at all, and their entire body
    is a `Panel` construction plus a `Dialog` construction. `ErrorBanner`'s
    three copies are ~40 lines each with three small functions over three
    locals. Nothing here is near the composition fallback's threshold.

[^wrapper-owned]: Splitting responsibility — base builds the `Dialog`, caller
    builds the padded wrapper — is precisely how the `autoScroll` regression
    happened: `changelogDialog.ts` fixed its own copy of the wrapper and
    `shortcutsDialog.ts`'s copy kept the defect, because nothing structurally
    connected them. With the wrapper inside the base there is no per-caller
    copy left to drift. The 16px inset was already identical in all three files
    (each declaring its own `CONTENT_PAD = 16`, two of them commenting that it
    matches About's), so nothing is lost by fixing it in the base.

[^banner-owns-attach]: A dumber `ErrorBanner` — just the row, with a
    `setMessage()` — would leave each of the three call sites its own
    `errorBannerShown` flag plus `show`/`hide` functions, roughly 20 of the ~40
    duplicated lines per site. The three sites differ only in *host*
    (`content` vs the query panel), *constraints* (none vs
    `Placement.SOUTH`), and *what runs after* (`dialog.resizeToContent()` vs
    `doLayout()` + `syncToolbarButtons()`), so all three differences fit in
    three constructor options and the whole trio moves into the class.

[^eager]: The current lazy `ensureErrorBanner()` forces every site into
    `Container | null` / `Text | null` locals and non-null assertions
    (`errorBannerText!`), and it is what makes "dispose it only if it exists and
    is detached" a separate function in two files. Eager construction costs one
    `Container`, one `Glyph`, one `Text` and one `Button` per host; components
    do not build DOM elements until rendered, and the banner is not attached to
    the tree until `show()`, so nothing reaches the DOM on the happy path.

[^teardown-chain]: `Dialog.hide()`'s `finalize` calls `this.destructor()`, which
    ends in `Component.destructor()`. That method iterates `this._components`
    and calls `child.destructor()` on each. The chain from the dialog reaches
    the `Markdown` body in three hops: `Dialog` → `_contentContainer` (added via
    `addComponent`, so it is in `_components`) → the padded wrapper `Panel` →
    `Markdown`. `Panel.destructor()` and `Container` do not interrupt the
    recursion — `Panel` overrides `destructor()` only to remove its scroll
    shadows and then calls `super.destructor()`. `Markdown.destructor()` is what
    calls `_unsubscribeTheme()`. `Component.dispose()` is documented idempotent,
    so the current explicit `md.dispose()` in the `show()` continuation is a
    second, redundant pass rather than the one that does the work.

[^unconditional-dispose]: The current
    `if (!errorBannerShown && errorBanner) errorBanner.dispose()` guard exists
    because `errorBanner` was a nullable local, and because both files'
    comments assumed disposing an attached banner twice would be a problem.
    It is not: `Component.dispose()` is idempotent. With the banner a non-null
    `const` (or field), the guard has nothing left to guard, so both files' helper —
    including the comment about TypeScript narrowing `errorBanner` to `never`
    inside `try/finally`, which was the only reason it was a separate function —
    goes away.

[^probe]: A throwaway module containing both class bodies from
    `## Internal Structure` — plus a no-op `protected destructor()` override on
    `DismissDialog`, to exercise that path too — was compiled against the installed
    `@jimka/typescript-ui@0.8.0` with the project's own `tsconfig.json`
    (`strict`, `noUnusedLocals`, `verbatimModuleSyntax`) and produced no
    diagnostics. That covered `class DismissDialog extends Dialog` on the
    callable export, the `protected destructor()` override, `callable()` around
    a subclass of a callable, the `ErrorBanner` arrow-function fields, and
    `addComponent(this, this._constraints)` with an optional
    `LayoutConstraints`. The probe was deleted; nothing from it is committed.
