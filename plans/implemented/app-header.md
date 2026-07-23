# App Header — Implementation Plan

## Overview

Nothing on screen says what application SQLAdmin is. A first-time viewer sees a
menu bar, a sidebar, and a work area with no name attached to any of them. This
plan adds a persistent brand block — app name, version, and the connected
database — pinned to the leading edge of the existing menu bar.

The block is a new class-first component, `AppHeader`, inserted as the first
child of the `MenuBar` that [`frontend/src/shell/SqlAdminShell.ts:347`](frontend/src/shell/SqlAdminShell.ts#L347)
already builds. It adds no new row and resizes nothing: the menu bar is already
there, and the block occupies horizontal space to the left of the "Query" menu.

Two supporting pieces come with it. `appIdentity.ts` becomes the single source of
the app's name, version, and one-line description — the name is currently
hardcoded in three places and the version nowhere. `appHeaderText.ts` holds the
pure string logic so it can be unit-tested in the project's DOM-less test runner.

---

## Architecture Decisions

### The header is a child of the existing MenuBar, not a new NORTH row

`AppHeader` is inserted at index 0 of the menu bar built by `buildMenuBar`
([`frontend/src/shell/SqlAdminShell.ts:347`](frontend/src/shell/SqlAdminShell.ts#L347)),
mirroring how that same function already appends the Shortcuts and About buttons
to the menu bar's trailing edge
([`frontend/src/shell/SqlAdminShell.ts:407`](frontend/src/shell/SqlAdminShell.ts#L407)).[^why-menubar]

### It is a new component, built the way `buildIdentityWidget` is built

`AppHeader` is a glyph-plus-text strip: an `HBox` holding a `Glyph` and a few
`Text` children, with a `Tooltip` attached to the whole block. That is exactly
the shape of `buildIdentityWidget`
([`frontend/src/SqlAdminController.ts:100`](frontend/src/SqlAdminController.ts#L100)),
the app's existing "identity badge in a chrome bar" widget. `AppHeader` copies
its composition and differs in one respect: it is a class extending `Container`
rather than a module-level builder function, because
[`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) section
(a) requires new shell components to be class-first.[^class-first]

### The header shows the connected database, not the signed-in user

The block reads `SQLAdmin  v0.1.0  │  sqladmin`, where the last segment is the
database from the session. The signed-in username is deliberately not repeated
here — the status bar's right zone already pins it
([`frontend/src/SqlAdminController.ts:303`](frontend/src/SqlAdminController.ts#L303)).[^which-half]

### Name, version, and description come from one module

A new `frontend/src/appIdentity.ts` exports `APP_NAME`, `APP_VERSION`, and
`APP_TAGLINE`. `APP_VERSION` is injected at build time from
`frontend/package.json`'s `version` field via a Vite `define`, so it cannot drift
from the released version. The About dialog, the start page, and the
localStorage window all switch to `APP_NAME` instead of their own literals.[^one-name]

The canonical spelling is **`SQLAdmin`** (one word), matching `README.md`, the
document title, and the published image name. Two on-screen surfaces currently
read `SQL Admin` and change to `SQLAdmin`.

### Colours come from library theme tokens

Every colour the header sets is a `var(--ts-ui-…, fallback)` string handed to
`setForegroundColor`, the form already used across the app — for example
[`frontend/src/dock/ExplainNode.ts:56`](frontend/src/dock/ExplainNode.ts#L56).
No literal colour is introduced, and `frontend/src/theme.ts` is not touched.[^tokens]

| Element | Value |
|---|---|
| App name | `var(--ts-ui-text-color, rgb(33, 33, 33))` |
| Version, database label | `var(--ts-ui-menu-bar-item-shortcut-color, rgb(140, 140, 140))` |
| Separator | `ToolBarSeparator` (self-tokenised) |
| Background | none — inherits the menu bar's `--ts-ui-menu-bar-bg` |

---

## Public API

```ts
// frontend/src/appIdentity.ts
export const APP_NAME: string;      // "SQLAdmin"
export const APP_VERSION: string;   // injected from package.json, e.g. "0.1.0"
export const APP_TAGLINE: string;   // one-line description
```

```ts
// frontend/src/shell/appHeaderText.ts
export interface AppHeaderText {
    /** The app name, shown bold. */
    name: string;
    /** The version, already `v`-prefixed — e.g. "v0.1.0". */
    version: string;
    /** The connected database, or null when the separator and label are omitted. */
    database: string | null;
    /** The hover tooltip for the whole block. */
    tooltip: string;
}

export function appHeaderText(
    name: string,
    version: string,
    tagline: string,
    database?: string,
): AppHeaderText;
```

```ts
// frontend/src/shell/AppHeader.ts
export class AppHeader extends Container {
    constructor(database?: string);
}
```

```ts
// frontend/src/shell/SqlAdminShell.ts — signature change
function buildMenuBar(actions: MenuBarActions, database?: string): MenuBar;
```

```ts
// frontend/src/env.d.ts
declare const __APP_VERSION__: string;
```

---

## Internal Structure

### `appHeaderText` — the string rules

A blank or absent database is treated as "no database": the separator and the
label are dropped, and the tooltip loses its connection clause.

| `database` argument | `.database` | `.tooltip` |
|---|---|---|
| `"sqladmin"` | `"sqladmin"` | `SQLAdmin v0.1.0 — A browser-based PostgreSQL administration & query tool. Connected to “sqladmin”.` |
| `undefined` | `null` | `SQLAdmin v0.1.0 — A browser-based PostgreSQL administration & query tool.` |
| `""` | `null` | `SQLAdmin v0.1.0 — A browser-based PostgreSQL administration & query tool.` |

`.version` is always `"v" + version` — the caller passes `"0.1.0"`, the field
reads `"v0.1.0"`.

### `AppHeader` — composition

```ts
const text = appHeaderText(APP_NAME, APP_VERSION, APP_TAGLINE, database);
// children, in order: Glyph("database"), Text(name), Text(version),
// and — only when text.database is non-null — ToolBarSeparator(), Text(database)
```

Built as locals before `super({ layoutManager: new HBox({ spacing: GAP }),
components })`, per COMPONENT_CONVENTIONS.md (b). After `super()` returns:
`setInsets(new Insets(0, PAD, 0, PAD))`, `getAria().setRole("presentation")`,
and `Tooltip.attach(this, text.tooltip)`.

Constants: `GAP = 6` (matching `buildIdentityWidget`'s `HBox` spacing),
`PAD = 10` (matching the horizontal inset the library's own menu-bar buttons
use), `DB_LABEL_MAX_WIDTH = 160`.

The database `Text` is constructed with `{ truncate: true }` and capped with
`setMaxSize(DB_LABEL_MAX_WIDTH, UNBOUNDED)`, so a long database name cannot push
the trailing Shortcuts/About buttons off a narrow window. `UNBOUNDED` and
`Insets` import from `@jimka/typescript-ui/primitive`, `Container` from
`@jimka/typescript-ui/core`, `HBox` from `@jimka/typescript-ui/layout`, `Text`
from `@jimka/typescript-ui/component/input`, `Glyph` from
`@jimka/typescript-ui/component/display`, `ToolBarSeparator` from
`@jimka/typescript-ui/component/menubar`, and `Tooltip` from
`@jimka/typescript-ui/overlay`.

---

## Ordered Implementation Steps

1. **`frontend/tsconfig.json`** — add `"resolveJsonModule": true` to
   `compilerOptions`, so the Vite config may import `package.json`.

2. **`frontend/vite.config.ts`** — add `import pkg from "./package.json";` at the
   top and a top-level
   `define: { __APP_VERSION__: JSON.stringify(pkg.version) },` entry to the
   exported config. Leave every existing key untouched.

3. **`frontend/vitest.config.ts`** — add the same `import` and the same
   top-level `define` entry. Both configs need it: a `vitest.config.ts` replaces
   `vite.config.ts` for test runs rather than merging with it, so without this a
   test that ever imports `appIdentity.ts` would fail on an undefined global.

4. **Create `frontend/src/env.d.ts`** — a single ambient declaration:
   `declare const __APP_VERSION__: string;` with a comment naming the two configs
   that inject it. Check: `cd frontend && npm run typecheck` passes.

5. **Create `frontend/src/appIdentity.ts`** — export `APP_NAME = "SQLAdmin"`,
   `APP_VERSION: string = __APP_VERSION__`, and
   `APP_TAGLINE = "A browser-based PostgreSQL administration & query tool."`
   (the wording already in the About dialog's body). File-head comment: this is
   the only place the app's name, version, and description are written.

6. **Create `frontend/src/shell/appHeaderText.ts`** — the `AppHeaderText`
   interface and the `appHeaderText` function, per `## Internal Structure`. Pure
   strings only; no library imports.

7. **Create `frontend/tests/shell/appHeaderText.test.ts`** — cover the
   unit-testable cases in `## Expected Behaviour`. Follow the style of
   [`frontend/tests/shell/startPageWelcome.test.ts`](frontend/tests/shell/startPageWelcome.test.ts).
   Check: `cd frontend && npm test` passes.

8. **Create `frontend/src/shell/AppHeader.ts`** — the class, per
   `## Internal Structure`. Register its glyph at module level with
   `Glyph.register(database)` (the `database` glyph from
   `@jimka/typescript-ui/glyphs/solid/database`), mirroring how
   [`frontend/src/shell/StartPage.ts:33`](frontend/src/shell/StartPage.ts#L33)
   registers its own glyph even though the shell also registers it.

9. **`frontend/src/shell/SqlAdminShell.ts`** — change `buildMenuBar` to
   `function buildMenuBar(actions: MenuBarActions, database?: string): MenuBar`,
   and immediately before its `return menuBar;` add
   `menuBar.insertComponent(new AppHeader(database), 0);`. Update the call site
   at [line 90](frontend/src/shell/SqlAdminShell.ts#L90) to pass
   `controller.database` as the second argument. Add the `AppHeader` import.

10. **`frontend/src/shell/aboutDialog.ts`** — build `ABOUT_MARKDOWN` from
    `APP_NAME`, `APP_TAGLINE`, and `APP_VERSION` instead of the hardcoded text,
    and set the dialog `title` to `` `About ${APP_NAME}` ``. Add a
    `**Version:** ${APP_VERSION}` line above `**Author:**`. Keep the existing
    Author / Source / UI-library lines and the blank lines between blocks
    verbatim — `marked` needs them to lex separate paragraphs.

11. **`frontend/src/shell/StartPage.ts`** — replace the literal in
    `heading("SQL Admin", "600")` at
    [line 109](frontend/src/shell/StartPage.ts#L109) with `APP_NAME`.

12. **`frontend/src/shell/localStorageWindow.ts`** — change the button text at
    [line 267](frontend/src/shell/localStorageWindow.ts#L267) to
    `` `Clear ${APP_NAME} data` ``.

13. **Regression check** — `grep -rn 'SQL Admin' frontend/src` returns only
    file-head and inline *comment* lines; no remaining match is a string literal
    that reaches the screen. Then `cd frontend && npm run typecheck && npm test`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/env.d.ts` |
| Create | `frontend/src/appIdentity.ts` |
| Create | `frontend/src/shell/appHeaderText.ts` |
| Create | `frontend/src/shell/AppHeader.ts` |
| Create | `frontend/tests/shell/appHeaderText.test.ts` |
| Modify | `frontend/tsconfig.json` |
| Modify | `frontend/vite.config.ts` |
| Modify | `frontend/vitest.config.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |
| Modify | `frontend/src/shell/aboutDialog.ts` |
| Modify | `frontend/src/shell/StartPage.ts` |
| Modify | `frontend/src/shell/localStorageWindow.ts` |

---

## Expected Behaviour

### Unit-testable (`frontend/tests/shell/appHeaderText.test.ts`, node environment)

1. `appHeaderText("SQLAdmin", "0.1.0", TAGLINE, "sqladmin")` returns
   `name === "SQLAdmin"`, `version === "v0.1.0"`, `database === "sqladmin"`.
2. The same call's `tooltip` contains the name, `v0.1.0`, the tagline, and the
   database name.
3. `appHeaderText(…, undefined)` returns `database === null`, and its `tooltip`
   contains no connection clause (no occurrence of `Connected to`).
4. `appHeaderText(…, "")` behaves identically to `undefined` — `database` is
   `null`, not `""`.
5. The version is prefixed exactly once: passing `"0.1.0"` yields `"v0.1.0"`,
   never `"vv0.1.0"`.
6. A version already containing dots and a prerelease suffix (`"0.2.0-rc.1"`)
   passes through unaltered apart from the prefix: `"v0.2.0-rc.1"`.

### Manual verification (visual / layout / theme — the test runner has no DOM)

7. On login, the menu bar's leading edge reads `SQLAdmin v0.1.0 │ <database>`,
   with the "Query" menu immediately to its right.
8. The menu bar's height is unchanged (28px); no other region of the shell moves
   or resizes.
9. Clicking Query / Tools / View still opens each menu, anchored under its own
   button. Arrow-Left / Arrow-Right still cycle between open menus.
10. Hovering the block shows the tooltip from case 2.
11. Both light and dark theme: the app name is high-contrast body text, the
    version and database read as quieter secondary text, and the separator is
    visible in both.
12. At a narrow window width the database label truncates with an ellipsis and
    the Shortcuts and About buttons remain visible at the trailing edge.
13. The About dialog's title reads "About SQLAdmin" and its body shows a
    Version line matching `frontend/package.json`.
14. The start page heading reads "SQLAdmin", and the localStorage window's
    button reads "Clear SQLAdmin data".

---

## Verification

- `cd frontend && npm run typecheck` — passes.
- `cd frontend && npm test` — passes, including the new
  `tests/shell/appHeaderText.test.ts`.
- `cd frontend && npm run build` — passes, confirming the `define` reaches the
  production bundle.
- Grep from step 13 returns no stray `SQL Admin` literal in `frontend/src`.
- Manual smoke: run the backend and `npm run dev`, log in against the demo
  database, and walk cases 7–14 above. Toggle the theme to check case 11.

---

## Potential Challenges

- **A non-button child inside `role="menubar"`.** Setting the header's ARIA role
  to `presentation` keeps assistive tech from announcing the block as a menu
  item; the app name stays reachable via the document title and the About dialog.
- **Menu indices.** `MenuBar` tracks its menus in private `_buttons` / `_panels`
  arrays and anchors each dropdown to its button's element, so a child inserted
  at index 0 does not shift any menu index. Case 9 is the check that this holds.
- **Menu-bar crowding.** `MenuBar` lays its children out in a plain `HBox` with
  no overflow affordance, so anything added consumes width the trailing buttons
  need. The database label's `truncate` plus `DB_LABEL_MAX_WIDTH` cap bounds the
  block; case 12 is the check.
- **Vertical alignment inside a 28px bar.** The glyph and the text runs must sit
  on a common centre line. If they do not, give the header's `HBox` the same
  alignment treatment `buildIdentityWidget` gets in the status bar; this is
  visual-only and is covered by case 7.

---

## Critical Files

- [`frontend/src/shell/SqlAdminShell.ts`](frontend/src/shell/SqlAdminShell.ts) —
  `buildMenuBar` (line 347) is the precedent being mirrored and the file being
  modified.
- [`frontend/src/SqlAdminController.ts:100`](frontend/src/SqlAdminController.ts#L100) —
  `buildIdentityWidget`, the composition `AppHeader` copies; and the `database`
  getter at line 324, the state the header reads.
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) —
  sections (a), (b), (d) govern how `AppHeader` is written.
- [`frontend/src/shell/startPageWelcome.ts`](frontend/src/shell/startPageWelcome.ts) —
  the precedent for splitting pure logic out of a DOM component so it can be
  unit-tested.
- [`frontend/src/dock/ExplainNode.ts`](frontend/src/dock/ExplainNode.ts) — the
  `var(--ts-ui-…, fallback)` colour form.
- [`frontend/vitest.config.ts`](frontend/vitest.config.ts) — documents why the
  test environment is `node` and what that rules out.

---

## Non-Goals

- **No connection host or port in the header.** The session contract
  (`Session` in `frontend/src/data/api.ts`) carries only `connectionId`,
  `csrfToken`, `username`, and `database`. Surfacing the host would mean a
  backend and contract change, which is out of proportion to this feature.
- **No changes to the status bar.** Its identity badge and message zone stay
  exactly as they are.
- **No licence or attribution text in the header.** `LICENSE.md` and
  `THIRD-PARTY-NOTICES.md` stay where they are; the About dialog remains the
  in-app pointer to them.
- **No favicon, logo image, or window-title work.** `index.html` already titles
  the document `SQLAdmin`, which matches `APP_NAME`; it stays a hand-written
  literal because HTML cannot import the constant.
- **No restyling of the start page.** Its heading text changes; nothing else
  about it does.
- **No ARIA re-modelling of `MenuBar`.** The one ARIA call is the header's own
  `presentation` role.

---

## Implementation Notes

- **`getAria().setRole("presentation")` was dropped.** The plan's "Internal
  Structure" and "Potential Challenges" call for setting the header's ARIA
  role to `presentation` to keep assistive tech from announcing the block as
  a menu item. The installed library version (`@jimka/typescript-ui@0.2.0`,
  confirmed via `node_modules/@jimka/typescript-ui/dist/lib/types/core/Aria.d.ts`)
  types `Aria.setRole` as `(role: AriaRole) => this`, and `AriaRole` is a
  closed union of concrete widget roles (`menubar`, `menuitem`, `button`,
  `group`, …) with no `presentation` or `none` member, so the call does not
  compile. `AppHeader` therefore sets no ARIA role at all. This does not
  reintroduce the risk the plan was guarding against: the library only
  assigns an implicit ARIA role to specific interactive component kinds
  (buttons, menu items, …), not to a plain `Container`, so a roleless
  `AppHeader` mounted inside `role="menubar"` is not announced as a menu item
  either way — the explicit `presentation` role would have been redundant
  defense-in-depth, not the only thing preventing misannouncement. Case 9
  (menu open/close and Left/Right-arrow cycling unaffected by the inserted
  child) is still the manual check that this holds in practice.

---

## Notes

[^why-menubar]: A separate NORTH bar above the menu bar was the obvious
    alternative and was rejected: it would spend a whole row of vertical space —
    roughly another 28px off the work area, on top of the menu bar and the status
    bar already bracketing it — to show one short line of text, and it would put
    two near-identical grey strips on top of each other. The menu bar is already
    the app's top chrome, it is always present, and it already carries appended
    non-menu children at its trailing edge, so the leading edge is the cheapest
    place that is guaranteed visible in every state of the app. This also matches
    what the desktop editors this shell is modelled on do with their product
    identity.

[^class-first]: `buildIdentityWidget` is a module-level builder returning a bare
    `Component`, which is the older builder-first shape. COMPONENT_CONVENTIONS.md
    is explicit that new work is class-first and that the older form is a
    not-yet-migrated holdover, not a current pattern. So `AppHeader` copies the
    composition (HBox + Glyph + Text + Tooltip) and not the packaging. `Container`
    is the base rather than `Panel` because `Panel` carries a default 4px content
    inset that would fight the exact horizontal padding the block needs to line up
    with the menu buttons beside it.

[^which-half]: "What am I connected to" is the natural companion question to
    "what app is this", and a database browser that names itself but not its
    target answers only half. The database is the half worth promoting: today it
    appears only as a prefix inside transient status messages
    (`sqladmin · orders: 42 rows`), so it is easy to miss and easy to lose. The
    username, by contrast, is already pinned as a persistent badge in the status
    bar's right zone, and repeating it in the header would put the same fact in
    two places with two code paths to keep in step. Splitting the two facts
    across the two bars keeps each stated exactly once.

[^one-name]: The app name is currently written out three times in the frontend —
    the About dialog's Markdown body and its dialog title, and the start page
    heading — plus once in `index.html`. Two of those spell it `SQL Admin` and the
    document title spells it `SQLAdmin`, so the drift has already happened. The
    version is worse: it exists only in `frontend/package.json` and in prose in
    `README.md`, and the About dialog shows none, so a header carrying a
    hand-written version string would be wrong at the first release bump. Reading
    it through a Vite `define` makes the released `package.json` version the only
    place it is written.

[^tokens]: `frontend/src/theme.ts` holds app-level *action* semantics (run =
    green, delete = red) as literal `rgb(...)` values, and its `MUTED_TEXT_COLOR`
    is what the start page uses for secondary text. That module is the wrong
    source here: the header sits inside library chrome, so it should follow the
    chrome's own tokens and shift with the theme rather than pinning a fixed grey.
    `--ts-ui-menu-bar-item-shortcut-color` is the library's token for quiet
    secondary text inside menu-bar chrome, which is exactly what the version and
    database labels are. Every value keeps a literal fallback in the `var()`, the
    same defensive form the app's other token uses take.
