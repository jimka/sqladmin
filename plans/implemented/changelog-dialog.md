# Changelog Dialog — Implementation Plan

## Overview

Add a **Changelog** button to the menu bar's trailing button cluster, beside the
existing Shortcuts and About buttons ([frontend/src/shell/SqlAdminShell.ts:414-422](frontend/src/shell/SqlAdminShell.ts#L414)).
Clicking it opens a dismiss-only modal that renders the repo root's
[CHANGELOG.md](CHANGELOG.md) with the library's read-only `Markdown` viewer.

The dialog is a near-copy of the About dialog ([frontend/src/shell/aboutDialog.ts:48-68](frontend/src/shell/aboutDialog.ts#L48)),
with one addition taken from the Shortcuts dialog: a scrolling content panel
([frontend/src/shell/shortcutsDialog.ts:33-37](frontend/src/shell/shortcutsDialog.ts#L33)),
because the changelog is far taller than a viewport and grows every release.

Unlike About's hand-authored `ABOUT_MARKDOWN` string, the body is a real file
that lives outside the frontend package. It is inlined into the bundle at build
time by a Vite `?raw` import, which needs an ambient type declaration in
[frontend/src/env.d.ts](frontend/src/env.d.ts) and one adjustment to the
Docker frontend build stage ([Dockerfile:4-13](Dockerfile#L4)).

---

## Architecture Decisions

### The changelog is inlined at build time with a Vite `?raw` import

`frontend/src/shell/changelogText.ts` does `import text from "../../../CHANGELOG.md?raw"`
and re-exports it as `CHANGELOG_MARKDOWN`. Nothing is fetched at runtime.[^raw-import]

The three paths that must all resolve to the same file:

| Context | Vite/Node root | Resolved path |
|---|---|---|
| Dev checkout | `frontend/` | `<repo>/CHANGELOG.md` |
| `vite build` / `vitest` | `frontend/` | `<repo>/CHANGELOG.md` |
| Docker `frontend` stage | `/build/frontend` | `/build/CHANGELOG.md` |

### The raw import lives in its own module, separate from the dialog

`changelogText.ts` imports nothing from `@jimka/typescript-ui`, so the unit test
can import it under vitest's `node` environment. The dialog module
`changelogDialog.ts` imports library components that touch `document` at module
scope and is therefore not importable there.[^split-module]

### The dialog mirrors `aboutDialog.ts`, with `shortcutsDialog.ts`'s scrolling panel

Same shape as [frontend/src/shell/aboutDialog.ts:48-68](frontend/src/shell/aboutDialog.ts#L48):
a `Panel` with a stretching `VBox` and a 16px inset, a `Markdown` child, a
`Dialog` with `buttons: [DialogButtons.Close]`, a fixed `width`,
`closeOnBackdrop: true`, and `md.dispose()` once `show()` resolves. The one
divergence is `autoScroll: "y"` on the content panel, copied from
[frontend/src/shell/shortcutsDialog.ts:33-37](frontend/src/shell/shortcutsDialog.ts#L33) —
the only other dialog in the app whose body can outgrow the viewport.[^scroll]

### The opener is a module-level function, not a class-first component

`export function openChangelogDialog(): void`, matching `openAboutDialog` and
`openShortcutsDialog`. `frontend/COMPONENT_CONVENTIONS.md` governs *components*
— things that extend a library base — not dialog openers, and neither existing
opener is a class.

### The button joins the menu bar's trailing cluster, between Shortcuts and About

The app has no separate top-right icon area: the brand strip above the menu bar
([frontend/src/shell/AppHeader.ts:56-90](frontend/src/shell/AppHeader.ts#L56)) is
a left-aligned glyph + name + version with no trailing components. "Upper-right
chrome" is the menu bar's `Spacer.flex()` cluster
([frontend/src/shell/SqlAdminShell.ts:420-422](frontend/src/shell/SqlAdminShell.ts#L420)).
Changelog is inserted before About so About keeps the far-right slot its own
code comment and doc comments claim.[^button-order]

### The Docker frontend stage mirrors the repo layout

`WORKDIR` moves from `/build` to `/build/frontend`, and `CHANGELOG.md` is copied
to `/build/CHANGELOG.md`, so the container's directory structure matches the
repo's and the import's `../../../` lands where a reader expects.[^docker-layout]

---

## Public API

```ts
// frontend/src/shell/changelogText.ts
export const CHANGELOG_MARKDOWN: string;

// frontend/src/shell/changelogDialog.ts
export function openChangelogDialog(): void;

// frontend/src/env.d.ts — ambient, no runtime value
declare module "*.md?raw" {
    const content: string;
    export default content;
}
```

`MenuBarActions` ([frontend/src/shell/SqlAdminShell.ts:316-347](frontend/src/shell/SqlAdminShell.ts#L316))
gains one field, placed directly after `onShowShortcuts`:

```ts
/** Opens the Changelog dialog (the menu-bar button between Shortcuts and About). */
onShowChangelog: () => void;
```

---

## Ordered Implementation Steps

1. **`frontend/src/env.d.ts`** — append the ambient module declaration for
   `*.md?raw` shown in `## Public API`, with a comment explaining why it is
   hand-written: `frontend/tsconfig.json:7` sets `"types": []`, so Vite's own
   `vite/client` ambient declarations are not in scope.

2. **Create `frontend/src/shell/changelogText.ts`.** A file-header comment plus:

   ```ts
   import text from "../../../CHANGELOG.md?raw";

   /** The repo root's CHANGELOG.md, inlined into the bundle at build time. */
   export const CHANGELOG_MARKDOWN: string = text;
   ```

   The header comment states that the repo root's `CHANGELOG.md` is the single
   source of truth, that the file is inlined by Vite at build time (so nothing
   is fetched at runtime), and that this module deliberately imports no library
   component so it stays importable from a node-environment unit test.

3. **Create `frontend/tests/shell/changelogText.test.ts`** with the three
   assertions in `## Expected Behaviour` (unit-testable group). Run
   `cd frontend && npm test` — expect it to pass; a wrong relative path in step 2
   fails here rather than only at bundle time.

4. **Create `frontend/src/shell/changelogDialog.ts`**, copying
   `frontend/src/shell/aboutDialog.ts` and changing:
   - imports: drop `appIdentity`, add `import { CHANGELOG_MARKDOWN } from "./changelogText";`
   - `const DIALOG_WIDTH = 600;` (About uses 460; the reason for the wider
     dialog is in the `## Architecture Decisions` note on the scrolling panel)
   - `CONTENT_PAD` stays `16`
   - the content `Panel` gains `autoScroll: "y"`
   - `Markdown(CHANGELOG_MARKDOWN)` instead of `Markdown(ABOUT_MARKDOWN)`
   - `title: "Changelog"`
   - keep `buttons: [DialogButtons.Close]`, `closeOnBackdrop: true`, and
     `void dialog.show().then(() => md.dispose());` exactly as About has them

   Carry over the two explanatory comments the copy sources already have: the
   fixed-width note from `aboutDialog.ts:16-18`, and the "leave the content
   uncapped, the Dialog caps its own height to the viewport" note from
   `shortcutsDialog.ts:27-32`.

5. **`frontend/src/shell/SqlAdminShell.ts`** — five edits:
   - after the `keyboard` glyph import (line 38), add
     `import { scroll } from "@jimka/typescript-ui/glyphs/solid/scroll";`
   - after `import { openShortcutsDialog }` (line 56), add
     `import { openChangelogDialog } from "./changelogDialog";`
   - add `scroll` to the second `Glyph.register(...)` call (line 67), the one
     decorating the menu bar
   - in `MenuBarActions`, add the `onShowChangelog` field from `## Public API`
     after `onShowShortcuts`, and amend `onShowShortcuts`'s own doc comment: it
     currently reads "the menu-bar button beside About", which stops being true
     once Changelog sits between them — change it to "the menu-bar button left of
     Changelog, and the ? accelerator"
   - in the `buildMenuBar(...)` call (line 101), add
     `onShowChangelog    : () => openChangelogDialog(),` between `onShowShortcuts`
     and `onAbout`

6. **`frontend/src/shell/SqlAdminShell.ts`, `buildMenuBar`** — build and mount the
   button between `shortcuts` and `about` (lines 414-422):

   ```ts
   const changelog = Button({ glyph: "scroll", text: "Changelog", showText: true, showDescription: false, compact: true, flat: true });
   changelog.on("action", actions.onShowChangelog);
   ```

   ```ts
   menuBar.addComponent(Spacer.flex());
   menuBar.addComponent(shortcuts);
   menuBar.addComponent(changelog);
   menuBar.addComponent(about);
   ```

7. **`frontend/vite.config.ts`** — extend the existing `fs.strict off` bullet in
   the header comment (lines 6-9). It currently gives one reason (serving a
   symlinked library checkout); add the second: the Changelog dialog imports the
   repo root's `CHANGELOG.md?raw`, which is outside the Vite root, and the dev
   server returns 403 for it under the default strict rule. No config value
   changes. This is a comment-only edit and matters because it stops a future
   cleanup from deleting a now-load-bearing setting.

8. **`Dockerfile`** — rework the `frontend` stage so the repo layout is mirrored:

   ```dockerfile
   WORKDIR /build/frontend

   # Dependency layer first so it caches independently of source changes.
   COPY frontend/package.json frontend/package-lock.json ./
   RUN npm ci

   COPY frontend/ ./
   # The Changelog dialog inlines the repo-root changelog at build time
   # (frontend/src/shell/changelogText.ts imports ../../../CHANGELOG.md?raw),
   # so the builder mirrors the repo: /build is the repo root, /build/frontend
   # the frontend package. Copied after the source layer so a changelog-only
   # edit does not invalidate it.
   COPY CHANGELOG.md /build/CHANGELOG.md
   RUN npm run build
   ```

   Then update the runtime stage's copy (line 32) from
   `COPY --from=frontend /build/dist ./static` to
   `COPY --from=frontend /build/frontend/dist ./static`.

9. **Regression checks.** From the repo root:
   `grep -rn 'beside About' frontend/src/` — expect zero matches (step 5's doc
   comment amendment). `grep -n '/build/dist' Dockerfile` — expect zero matches
   (step 8).

10. **Run `## Verification`.**

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/shell/changelogText.ts` |
| Create | `frontend/src/shell/changelogDialog.ts` |
| Create | `frontend/tests/shell/changelogText.test.ts` |
| Modify | `frontend/src/env.d.ts` |
| Modify | `frontend/src/shell/SqlAdminShell.ts` |
| Modify | `frontend/vite.config.ts` (comment only) |
| Modify | `Dockerfile` |

---

## Expected Behaviour

### Unit-testable — `frontend/tests/shell/changelogText.test.ts`

`CHANGELOG_MARKDOWN` must:

1. start with `# Changelog`;
2. contain at least one release heading — `/^## \[\d+\.\d+\.\d+\]/m` matches;
3. contain at least one link-reference definition — `/^\[\d+\.\d+\.\d+\]: https:\/\//m`
   matches. This is the construct whose *rendering* is checked manually below, so
   the test pins its presence in the source.

A wrong relative path in the import fails the whole test file at module
resolution, before any assertion runs. A path that resolves to the wrong file
fails assertion 1.

### Manual — run the app (`## Verification` names the entry point)

4. The menu bar's right edge reads **Shortcuts · Changelog · About**, left to
   right. The Changelog button carries a scroll glyph and is flat and compact
   like its two neighbours.
5. Clicking Changelog opens a modal titled "Changelog", 600px wide.
6. The body is rendered Markdown — headings, bullets, bold runs, links — not raw
   Markdown source. The three Keep a Changelog constructs render as:

   | Source | Rendered |
   |---|---|
   | `## [0.4.0] — 2026-08-04` | a heading whose `0.4.0` is a link to the GitHub release tag |
   | `[0.4.0]: https://github.com/…/v0.4.0` (trailing block) | nothing — consumed by the parser as the definition for the link above |
   | `- **Faster table opens.** Opening a table…` | a bullet whose first sentence is bold |

7. The body scrolls by mouse wheel and by dragging the scrollbar, and shows
   **exactly one** vertical scrollbar.
8. Shrinking the browser window shrinks the dialog to fit; enlarging it again
   grows the dialog back. The dialog never extends past the viewport.
9. Close, Escape, a backdrop click, and the title-bar close each dismiss it.
10. Reopening after dismissal renders the full changelog again — the `md.dispose()`
    on the previous instance does not affect a fresh one. Open and close it three
    times to confirm.

---

## Verification

```bash
cd frontend && npm run typecheck        # ambient *.md?raw declaration resolves
cd frontend && npm test                 # changelogText.test.ts passes
cd frontend && npm run build            # the ?raw import inlines at build time
```

Then confirm the changelog actually reached the bundle:

```bash
grep -l "Keep a Changelog" frontend/dist/assets/*.js    # expect at least one match
```

Docker build (needs Docker; this is the only check that covers step 8):

```bash
docker build --target frontend -t sqladmin-frontend-check .
```

Manual smoke test — behaviours 4-10 above. Start the stack per README's
_Development_ section (`docker compose up -d db`, the backend via uvicorn,
`cd frontend && npm run dev`), log in against `localhost:5432` / database
`sqladmin`, and exercise the Changelog button at the menu bar's right edge.

---

## Potential Challenges

- **The dev server 403s the changelog if `server.fs.strict` is ever re-enabled.**
  The import leaves the Vite root, and `frontend/`'s own `package-lock.json`
  makes Vite treat `frontend/` — not the repo root — as the workspace root, so
  the default allowlist excludes `CHANGELOG.md`. `frontend/vite.config.ts`
  already sets `fs: { strict: false }`; step 7 records the new dependency in its
  comment so the setting is not cleaned up later.
- **Two scrollbars in the dialog.** The `Dialog` scrolls its own content
  container when capped to the viewport, and the content `Panel`'s `autoScroll`
  adds eased wheel scrolling on top. Behaviour 7 checks for a doubled scrollbar.
  Record a doubled scrollbar in `LIBRARY_NOTES.md` as a library-side defect
  rather than working around it here — the Shortcuts dialog pairs the same two
  settings.
- **Reference links may not render.** Behaviour 6 depends on the library's
  `Markdown` resolving `marked`'s link-reference definitions. A trailing
  `[0.4.0]: https://…` block showing as literal text also goes in
  `LIBRARY_NOTES.md`; do not pre-process the Markdown string in app code.
- **The changelog grows every release.** The dialog scrolls and the `Dialog`
  caps its own height, so no size ceiling is needed — but the inlined string
  grows the bundle by roughly its own byte count (about 5 KB today).

---

## Critical Files

| File | Why |
|---|---|
| [frontend/src/shell/aboutDialog.ts](frontend/src/shell/aboutDialog.ts) | The precedent this dialog copies — read in full before writing `changelogDialog.ts`. |
| [frontend/src/shell/shortcutsDialog.ts](frontend/src/shell/shortcutsDialog.ts) | Source of the `autoScroll: "y"` content panel and its comment. |
| [frontend/src/shell/SqlAdminShell.ts](frontend/src/shell/SqlAdminShell.ts) | Glyph registration, `MenuBarActions`, and the trailing button cluster. |
| [frontend/src/env.d.ts](frontend/src/env.d.ts) | Where the ambient `*.md?raw` declaration goes, beside `__APP_VERSION__`. |
| [frontend/vite.config.ts](frontend/vite.config.ts) | The `fs.strict` setting the dev server now depends on. |
| [Dockerfile](Dockerfile) | The frontend build stage that must see the repo-root changelog. |
| [frontend/tests/appIdentity.test.ts](frontend/tests/appIdentity.test.ts) | The house style for a small constants test. |

---

## Non-Goals

- **No keyboard accelerator.** Shortcuts has `?` because it is consulted mid-task;
  a changelog is not. `queryShortcuts.ts`, `shortcutRegistry.ts`, and
  `shortcutLegend.ts` stay untouched.
- **No CHANGELOG.md entry for this feature.** Changelog entries are written as
  part of a release, not folded into feature work (see `plans/implemented/release-v0-1-0.md`).
- **No backend endpoint and no runtime fetch.** The changelog ships in the bundle.
- **No "what's new since you last visited" badge or unread marker.** That needs
  persisted state and a version comparison; this is a plain viewer.
- **No shared helper extracted from the three dialog openers.** Each is ~20 lines
  and they differ in width, scrolling, and disposal; a premature abstraction
  would obscure those differences.

---

## Notes

[^raw-import]: Verified in this repo before choosing: `vite build` inlines the
    repo-root file with no config change, `vitest run` resolves it with no config
    change, and `tsc --noEmit` passes once the ambient `*.md?raw` declaration is
    added. The dev server serves it because `frontend/vite.config.ts` already
    sets `server.fs.strict: false` — with the default strict rule it returns 403.
    Three alternatives were rejected. **A Vite `define`**, mirroring the
    `__APP_VERSION__` injection at `frontend/vite.config.ts:29-31` and
    `frontend/src/appIdentity.ts:15`, is the nearest existing precedent for
    getting build-time content into the bundle — but `vitest.config.ts` replaces
    `vite.config.ts` rather than merging with it (its own comment at lines 11-14
    says so), so a `define` must be written twice and kept in sync, which the
    `?raw` import avoids entirely. The precedent also solves a different problem:
    a scalar read out of `package.json`, which has no file-content equivalent.
    **A hand-copied constant** in the style of `ABOUT_MARKDOWN` would create a
    second copy of the changelog that drifts from the real one at every release —
    the exact failure `appIdentity.ts` was written to prevent for the version
    string. **A backend endpoint** would turn static build-time content into a
    runtime request with its own loading and error states, and would need
    `CHANGELOG.md` added to the runtime image alongside `LICENSE.md` and
    `THIRD-PARTY-NOTICES.md` (`Dockerfile:33`) — more moving parts for content
    that never changes after a build.

[^split-module]: `frontend/vitest.config.ts` runs tests in the `node`
    environment. Library UI modules touch `document` at import scope, so a test
    importing `changelogDialog.ts` would fail on the import alone. Keeping the
    `?raw` import in a library-free module gives the test something to assert
    against, and that test is what turns a mistyped relative path from a
    build-time failure into a `npm test` failure. The split mirrors
    `frontend/src/appIdentity.ts` and its `frontend/tests/appIdentity.test.ts`.

[^scroll]: `shortcutsDialog.ts:27-32` explains the pairing: the `Dialog` caps its
    own height to the viewport and scrolls its content container, re-fitting live
    as the viewport resizes, so the content must be left uncapped — a fixed
    `maxSize` would be a stale ceiling that stops the dialog growing back. The
    `autoScroll` adds the eased wheel scroll used elsewhere in the app. The width
    goes to 600 rather than About's 460 because the changelog's bullets are
    multi-sentence paragraphs with nested indentation; at 460 they wrap every few
    words. `DialogConfig.height` exists but is deliberately unused — setting it
    would defeat the viewport cap.

[^button-order]: `aboutDialog.ts:1-2` calls About "reached from the far-right of
    the menu bar", and `MenuBarActions.onAbout`'s doc comment
    (`SqlAdminShell.ts:338`) calls it "the far-right menu-bar button". Appending
    Changelog after About would falsify both. Inserting before About keeps them
    true and costs only the amendment to `onShowShortcuts`'s doc comment in
    step 5. The `scroll` glyph was picked because it is not yet registered
    anywhere in the app and has a distinct silhouette; `clock-rotate-left` is
    already taken by Query History, and its look-alike `history` would read as a
    second history control sitting a few pixels from the first.

[^docker-layout]: The frontend stage's build context is the repo root
    (`docker-compose.yml`'s `build.context: .`) and `.dockerignore` does not
    exclude `CHANGELOG.md`, so the file is available to copy — it simply is not
    copied today, because `Dockerfile:12` copies only `frontend/`. Leaving
    `WORKDIR /build` and copying the file to `/CHANGELOG.md` is one line shorter
    and works, since `/build` is then the frontend directory and `../../../`
    from `/build/src/shell/` lands at `/`. It was rejected because that only
    works by coincidence: a reader of the Dockerfile cannot see that a file at
    the image root is what the import resolves to. Mirroring the repo layout
    makes the arithmetic self-evident and costs nothing — the stage is a
    throwaway builder whose only output is `dist`.

---

## Implementation Notes

**The `docker build --target frontend` check in `## Verification` could not be
run to a passing result — a pre-existing, unrelated failure.** `RUN npm run
build` fails its `tsc --noEmit` step inside the container on three errors, all
in files this plan never touches: `frontend/src/dock/SqlPreviewDialog.ts`
(`autoHeightMaxRows`, a `"heightchange"` event) and
`frontend/src/navigator/NavigatorTree.ts` (`expandNode`). Those APIs exist only
in the local, unreleased `typescript-ui` checkout that dev/build consume via
the `frontend/node_modules/@jimka/typescript-ui` symlink override — not in the
`@jimka/typescript-ui@0.4.1` published to the npm registry that `npm ci` installs
inside the Docker build. Confirmed pre-existing and unrelated to this branch:
the identical failure, at the identical two files, reproduces building
`--target frontend` straight from `main` with the *original* (unmodified)
Dockerfile — before `WORKDIR`, the `COPY frontend/ ./` layer, and the new
`COPY CHANGELOG.md /build/CHANGELOG.md` step, which all completed successfully
in both builds. So the Dockerfile restructuring itself (`## Architecture
Decisions`, "The Docker frontend stage mirrors the repo layout") is verified
structurally correct up to the point of the pre-existing failure; the full
`docker build` was not exercised past `RUN npm run build`. Unblocking it is a
library-release-gating concern outside this plan's scope (see
`plans/implemented/align-with-library-post-0.4.1.md`, the branch that
introduced the two now-unreleased APIs).
