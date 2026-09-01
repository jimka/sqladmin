---
name: verify
description: Launch and drive the sqladmin app in a browser to verify a change end-to-end.
---

# Verifying sqladmin changes

## Stack

Three processes; check whether they are already up before starting anything:

```bash
docker compose ps
ss -ltnp | grep -E ':5432|:8000|:5173'
```

- Postgres — `docker compose up -d db` (:5432)
- Backend — `cd backend && SQLADMIN_ALLOWED_HOSTS=localhost:5432 poetry run uvicorn app.main:app --reload --port 8000` (:8000)
- Frontend — `cd frontend && npm run dev` (Vite on :5173)

## Library changes

`@jimka/typescript-ui` is an ordinary installed package from the npm registry —
`frontend/node_modules/@jimka/typescript-ui` is a real directory that `npm
install` put there, and that published copy is what the app runs against. A
library change reaches the app by being released and the range bumped, not by
being saved.

To test an **unreleased** library build, override the install with a symlink to
the sibling checkout, which the app then imports the **built** `dist/lib` of:

```bash
# The rm is required: the installed package is a real directory, and `ln -s`
# against one silently creates the link *inside* it (…/typescript-ui/lib) —
# leaving the published copy in place and your library change invisible.
rm -rf frontend/node_modules/@jimka/typescript-ui
ln -s ~/typescript/typescript-ui/packages/lib frontend/node_modules/@jimka/typescript-ui
cd ../typescript-ui && npm run build:lib   # NOT `npm run build`
```

The target is absolute on purpose — a relative one resolves differently from a
worktree under `.worktrees/` than from the main tree. Confirm the override took:
`ls -ld frontend/node_modules/@jimka/typescript-ui` must show a symlink, not a
directory.

Then reload the page with `ignoreCache: true`. Vite picks the rebuild up on reload;
no dev-server restart needed — `fs.strict: false` and `resolve.dedupe` in
`frontend/vite.config.ts` are there to make this symlink serve at all.

Undo it with `cd frontend && npm install`, which reifies the lockfile and puts
the published copy back. Never verify a release against the symlink: it exercises
a local build, not the artefact that ships.

## Login

The login form defaults Host to `localhost`, which the backend may reject with
"Host not allowed" depending on how it's running — the Host that works depends
on where Postgres is reachable *from the backend process*, not from your shell:

- **Backend inside Compose** (`docker compose up -d backend` or similar): use
  Host **`sqladmin-db`** — the Compose service name, which only resolves
  inside the Compose network.
- **Backend running natively**, as in the `## Stack` command above
  (`SQLADMIN_ALLOWED_HOSTS=localhost:5432 poetry run uvicorn …`): use Host
  **`localhost`** — `sqladmin-db` does not resolve from a native process, and
  that env var is what allowlists `localhost:5432` in the first place.

Either way: Database `sqladmin`, user `sqladmin`, password `sqladmin`. The
session is a cookie, so it survives a reload — but the Dock tabs do not, so a
reload means re-opening whatever panel you were driving.

## Driving it (chrome-devtools MCP)

The a11y snapshot covers most of the UI, but two things need `evaluate_script`:

- **Right-click menus** — no right-click tool. Dispatch the sequence
  `pointerdown, mousedown, pointerup, mouseup, contextmenu` with `button: 2` on
  the target element, then `take_snapshot` to get the menu's uids.
- **Submenus** ("Show ▸ Structure") open on **hover**, not click — use `hover`
  on the parent item, then snapshot.

Tree nodes expand on **double-click**.

Useful `evaluate_script` handles: `.StructurePanel` (the `autoScroll` scroll host),
`.AccordionPanel`, `.AccordionHeader` (headers carry their label as `textContent`;
click the inner `button` to toggle a section).

## Gotchas

- Accordion open/close animates for **200ms**. Wait ≥600ms after a toggle before
  measuring geometry, or you read mid-transition values.
- The Structure panel only overflows at a short viewport. At 1500x800 all four
  sections fit; `resize_page` to ~380 tall to force the scrollbar.
