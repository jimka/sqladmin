---
touches-shared:
  - ../typescript-ui/packages/lib/docs/reference/changelog.md
  - ../typescript-ui/packages/lib/docs/reference/migration.md
---

# elkjs 0.12.0 Upgrade — Implementation Plan

## Overview

Move the ELK layout engine from elkjs 0.10.2 to 0.12.0 in both repos that declare it. The library declares it twice in [`../typescript-ui/packages/lib/package.json:157`](../typescript-ui/packages/lib/package.json#L157) (a `devDependency`, so its own tests can run real ELK) and [`:204`](../typescript-ui/packages/lib/package.json#L204) (an **optional peer dependency**, so a consumer of `@jimka/typescript-ui/component/diagram` installs ELK itself). The app declares it once, at [`frontend/package.json:21`](frontend/package.json#L21). All three ranges go to `^0.12.0`.[^pin]

**No TypeScript, no Vite config, and no type-shim change is needed.**[^no-source-change] The work is three range edits across two package manifests, two installs, and the paperwork that follows: elkjs relicensed from `EPL-2.0` to `EPL-2.0 OR GPL-3.0-or-later`, so both third-party notice files need updating, and the library's peer-range move is an install-breaking change for its own consumers, so it needs a changelog and migration entry.

Two mechanical traps sit in the app-side install and are handled by explicit steps below: a plain `npm install` in `frontend/` now fails, and the install silently replaces the hand-made symlink through which the app consumes the local library build.

---

## Architecture Decisions

### Both repos move in one change, library first

The library's optional peer range and the app's dependency range are bumped together in a single branch per repo. Leaving the library at `^0.10.0` while the app moves to `^0.12.0` is not a valid intermediate state.[^both-repos]

Library steps run before app steps, with an `npm run build:lib` checkpoint in `/home/jika/typescript/typescript-ui` before the app typechecks. This mirrors the cross-repo ordering of [`plans/implemented/fk-diagram-cardinality-and-index-coverage.md`](plans/implemented/fk-diagram-cardinality-and-index-coverage.md), whose step 5 is the same checkpoint for the same reason: the app typechecks against the library's built, symlinked `dist/lib`, not its sources.

### No source, config, or type-shim change

Nothing under `packages/lib/src/typescript/lib/component/diagram/` changes, `frontend/src/dock/elkWorkerFactory.ts` does not change, and `frontend/vite.config.ts` does not change.[^no-source-change] The `optimizeDeps.include: ["elkjs/lib/elk.bundled.js"]` entry at [`frontend/vite.config.ts:49`](frontend/vite.config.ts#L49) stays exactly as it is — elkjs 0.12.0 still ships that file and it is still a CommonJS/UMD bundle, so the pre-bundling that entry forces is still required.

The **dep-optimizer cache** is a different matter and does get cleared once. `frontend/node_modules/.vite/deps/` holds the pre-bundled copy of elkjs; it must be rebuilt from the new install, and a stale copy renders the diagram empty with no error message.[^vite-cache]

### The app-side install needs `--legacy-peer-deps`, and both symlinks must be restored after it

`npm install` in `frontend/` fails once elkjs is `^0.12.0`. The failure is npm's `ERESOLVE` — a hard error npm raises when an installed package's declared peer requirement cannot be satisfied by the tree it is about to write. The app's lockfile pins `@jimka/typescript-ui@0.2.0` **from the registry**, and that published version declares `peerOptional elkjs@^0.10.0`, which elkjs 0.12.0 does not satisfy. The install therefore runs as `npm install --legacy-peer-deps`.[^legacy-peer]

That install also **replaces the symlink** at `frontend/node_modules/@jimka/typescript-ui`, which normally points at the local library checkout, with the published 0.2.0 tarball.[^symlink] Two symlinks must hold after any install in this repo; restore whichever npm replaced:

| Symlink | Must point to | Restore with |
|---|---|---|
| `frontend/node_modules/@jimka/typescript-ui` | `/home/jika/typescript/typescript-ui/packages/lib` | `rm -rf <path> && ln -s <target> <path>` |
| `<worktree>/frontend/node_modules` (worktree only) | `/home/jika/typescript/sqladmin/frontend/node_modules` | `ln -s <target> <path>` |

The second row applies only when working inside a `.worktrees/<slug>` checkout, where `frontend/` has no install of its own.

### The notices record the dual license; no GPL text is added

Both notice files gain the full SPDX expression `EPL-2.0 OR GPL-3.0-or-later` and a sentence stating that the GPL option is not exercised here. Neither file gains GPL-3.0 license text, and the grouping heading `### Eclipse Public License 2.0` at [`../typescript-ui/packages/lib/THIRD-PARTY-NOTICES.md:202`](../typescript-ui/packages/lib/THIRD-PARTY-NOTICES.md#L202) stays as it is.[^dual-license]

The existing project rule that elkjs stays an unbundled, external, optional peer of the library is what keeps this a paperwork change rather than a licensing problem, and it is unchanged: [`../typescript-ui/packages/lib/vite.lib.config.ts:96`](../typescript-ui/packages/lib/vite.lib.config.ts#L96) keeps `/^elkjs(\/|$)/` in `rollupOptions.external`.

### The library's peer widening is filed as a breaking change

The bump gets a `**Breaking:**` entry in the library changelog's in-progress `## 0.3.0` section plus a subsection in the migration guide, because a consumer that upgrades the library without also upgrading elkjs cannot install.[^breaking] The `^0.10.0` at [`../typescript-ui/packages/lib/docs/reference/changelog.md:328`](../typescript-ui/packages/lib/docs/reference/changelog.md#L328) is **not** edited — it records what 0.1.0 actually shipped.[^changelog-history]

---

## Ordered Implementation Steps

### Library — `/home/jika/typescript/typescript-ui` (do these first)

1. **`packages/lib/package.json`** — change `"elkjs": "^0.10.0"` to `"^0.12.0"` on **both** lines: `devDependencies` (line 157) and `peerDependencies` (line 204). Leave `peerDependenciesMeta.elkjs.optional` (lines 206–208) untouched — elkjs stays optional.
   Check: `grep -n '"elkjs"' packages/lib/package.json` → exactly two hits, both `^0.12.0`.

2. **Install** from the monorepo root (the root holds the lockfile and the workspaces): `npm install`.
   Checks: `grep '"version"' node_modules/elkjs/package.json` → `0.12.0`; `git status --short` → only `packages/lib/package.json` and `package-lock.json` are modified; `git diff package-lock.json` → the changed hunks are the `node_modules/elkjs` entry (now `0.12.0`, with `"license": "EPL-2.0 OR GPL-3.0-or-later"`) and the `packages/lib` workspace entry's recorded elkjs ranges, nothing else; `ls node_modules/elkjs/lib/elk.bundled.js node_modules/elkjs/lib/elk-worker.min.js` → both exist (these are the two entry points the library and the app reference).

3. **`packages/lib/THIRD-PARTY-NOTICES.md`** — rewrite the license sentence of the elkjs bullet (lines 204–207). Keep the `### Eclipse Public License 2.0` heading (line 202) and the "optional peer dependency … neither bundled into nor modified" paragraph (lines 209–211) as they are.

   ```markdown
   - **elkjs** — the Eclipse Layout Kernel (JavaScript), © Kiel University and
     contributors, licensed under `EPL-2.0 OR GPL-3.0-or-later`: the Eclipse Public
     License 2.0, with GPL-3.0-or-later offered as a Secondary License. This
     package neither bundles elkjs nor combines it with GPL-covered code, so the
     EPL-2.0 terms are the ones that govern here. Full text:
     <https://www.eclipse.org/legal/epl-2.0/> (also shipped as `LICENSE.md` in the
     `elkjs` package, which names the Secondary License); the Secondary License
     text is at <https://www.gnu.org/licenses/gpl-3.0-standalone.html>.
   ```

4. **`packages/lib/docs/reference/changelog.md`** — in the `## 0.3.0` → `### Breaking changes` section, add the entry below **before** the closing `See [Migration](...)` pointer (currently line 14). Do not touch line 328.

   ```markdown
   **Breaking:** the optional `elkjs` peer dependency moved from `^0.10.0` to
   `^0.12.0`. A consumer of `@jimka/typescript-ui/component/diagram` that stays on
   elkjs 0.10.x now fails to install with an `ERESOLVE` peer conflict; bump elkjs
   alongside the library. No `layoutOptions` key changed — ELK 0.12 only added
   layout options — but laid-out coordinates can shift, so re-check any diagram
   whose spacing was tuned by eye.
   ```

5. **`packages/lib/docs/reference/migration.md`** — add this subsection at the end of `## Upgrading from 0.2.x to 0.3.0`, immediately before `## Versioning policy` (currently line 237). The `<version>` placeholder matches the form already used by `## Upgrade procedure`.

   ````markdown
   ### The optional `elkjs` peer moved to `^0.12.0`

   Affects only consumers of `@jimka/typescript-ui/component/diagram`. Install the
   new elkjs together with the library, or npm rejects the install with an
   `ERESOLVE` peer conflict:

   ```bash
   npm install @jimka/typescript-ui@<version> elkjs@^0.12.0
   ```

   No `layoutOptions` key changed — ELK 0.12 only added layout options. Laid-out
   coordinates can still differ slightly, so give any diagram whose spacing you
   tuned by eye a visual check.
   ````

6. **Confirm no diagram source needs editing.** `grep -rn 'elkjs/lib/' packages/lib/src/typescript/lib/component/diagram/` → exactly four hits, none of them edited: the two real imports at `ElkLayoutEngine.ts:593` and `:618`, plus one comment each in `elkjs.d.ts:4` and `DiagramView.ts:110`. The `workerUrl` / `terminateWorker` doc comments in `elkjs.d.ts` and `ElkLayoutEngine.ts` stay as written; 0.12.0's worker-construction path is code-identical.[^no-source-change]

7. **Checkpoint — tests.** From the monorepo root: `npm test` (runs `typecheck:test` then vitest). All green. The load-bearing cases are the five real-elkjs tests in `packages/lib/tests/component/diagram/DiagramView.createEngine.test.ts` — they construct real ELK, and two of them (`R1`/`R2`) pin the disposal guard against elkjs's own worker internals.

8. **Checkpoint — build.** From the monorepo root: `npm run build:lib`. Must succeed, and the elkjs import must stay external rather than being inlined:
   `grep -c 'elkjs/lib/elk.bundled.js' packages/lib/dist/lib/component/diagram.es.js` → `1`.

### App — `/home/jika/typescript/sqladmin`

9. **`frontend/package.json:21`** — `"elkjs": "^0.10.0"` → `"elkjs": "^0.12.0"`. Leave `"@jimka/typescript-ui": "^0.2.0"` on line 20 alone (see [Non-Goals](#non-goals)).

10. **Install** — `cd frontend && npm install --legacy-peer-deps`. The flag is required; a plain `npm install` exits with `ERESOLVE`.[^legacy-peer]
    Checks: `grep '"version"' frontend/node_modules/elkjs/package.json` → `0.12.0`; `git diff frontend/package-lock.json` shows the `node_modules/elkjs` entry at version `0.12.0` with `"license": "EPL-2.0 OR GPL-3.0-or-later"`.

11. **Restore both symlinks** per the table in [Architecture Decisions](#the-app-side-install-needs---legacy-peer-deps-and-both-symlinks-must-be-restored-after-it). Step 10 replaces the `@jimka/typescript-ui` one, and in a worktree it may also replace the `node_modules` one.
    Check: `ls -l frontend/node_modules/@jimka/typescript-ui` → a symlink to `/home/jika/typescript/typescript-ui/packages/lib`.

12. **Clear the Vite dep-optimizer cache** — `rm -rf frontend/node_modules/.vite`. Needed before the dev-server pass in step 18; steps 16 and 17 do not depend on it.

13. **`THIRD-PARTY-NOTICES.md`** — replace the elkjs section at lines 142–150 with:

    ```markdown
    ### elkjs 0.12.0 — Eclipse Layout Kernel (JavaScript)

    © Kiel University and contributors, licensed under `EPL-2.0 OR
    GPL-3.0-or-later`: the Eclipse Public License 2.0, with GPL-3.0-or-later
    offered as a Secondary License. SQLAdmin does not combine elkjs with
    GPL-covered code, so it is received and redistributed under the EPL-2.0
    terms. Unlike `@jimka/typescript-ui`'s own optional, dynamically imported use
    of `elkjs`, SQLAdmin's Vite build bundles it unmodified into
    `dist/assets/elk.bundled-*.js`.

    - Source: <https://github.com/kieler/elkjs>
    - Full license text: <https://www.eclipse.org/legal/epl-2.0/>
    - Secondary license: <https://www.gnu.org/licenses/gpl-3.0-standalone.html>
    ```

14. **`THIRD-PARTY-NOTICES.md` inventory row (line 287)** — `| elkjs | 0.10.2 | EPL-2.0 |` becomes `| elkjs | 0.12.0 | EPL-2.0 OR GPL-3.0-or-later |`. Edit this one row by hand; do not run `scripts/generate_third_party_notices.py`, which also rebuilds the Python table and needs the backend virtualenv.
    Check that the hand-edit matches what the generator would emit:
    ```bash
    cd frontend && npm query ':not(.dev)' | python3 -c \
      "import json,sys; print([(p['name'],p['version'],p['license']) for p in json.load(sys.stdin) if p['name']=='elkjs'])"
    ```
    → `[('elkjs', '0.12.0', 'EPL-2.0 OR GPL-3.0-or-later')]`.

15. **`TODO.md`** — extend the existing `frontend/package.json`'s `"@jimka/typescript-ui": "^0.2.0"` loose-end bullet (starts at line 58) with a closing paragraph inside the same bullet:

    ```markdown
      The `elkjs` bump to `^0.12.0` adds a second, install-level face of the same
      gap: the published `0.2.0` declares `peerOptional elkjs@^0.10.0`, so a plain
      `npm install` in `frontend/` now hard-errors with `ERESOLVE` and has to run
      as `npm install --legacy-peer-deps` until a typescript-ui release carrying
      the `^0.12.0` peer is published. `npm ci` is unaffected — it replays the
      committed lockfile — so the Dockerfile and release workflow are no more
      broken than they already were.
    ```

16. **Checkpoint — typecheck and tests.** `cd frontend && npm run typecheck && npm test`. Both must pass unchanged; no app test touches elkjs.

17. **Checkpoint — production build.** `cd frontend && npm run build`, then `ls frontend/dist/assets | grep -i elk` → an `elk.bundled-*.js` chunk exists. If the emitted basename is no longer `elk.bundled-*.js`, update the path named in the notice text from step 13 to match what the build actually emits.

18. **Manual pass over every diagram surface** — see [Expected Behaviour](#manual-verify--every-diagram-surface). This is the substantive verification for this plan; layout coordinates can move even though the option set did not.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `../typescript-ui/packages/lib/package.json` (devDependencies + peerDependencies `elkjs` → `^0.12.0`) |
| Modify | `../typescript-ui/package-lock.json` (regenerated by `npm install`) |
| Modify | `../typescript-ui/packages/lib/THIRD-PARTY-NOTICES.md` (elkjs license expression) |
| Modify | `../typescript-ui/packages/lib/docs/reference/changelog.md` (`## 0.3.0` breaking entry) |
| Modify | `../typescript-ui/packages/lib/docs/reference/migration.md` (0.2.x → 0.3.0 subsection) |
| Modify | `frontend/package.json` (`elkjs` → `^0.12.0`) |
| Modify | `frontend/package-lock.json` (regenerated by `npm install --legacy-peer-deps`) |
| Modify | `THIRD-PARTY-NOTICES.md` (elkjs notice section + inventory row) |
| Modify | `TODO.md` (extend the `^0.2.0` loose-end bullet) |

---

## Expected Behaviour

### Unit-testable — existing suites only, no new tests[^no-new-tests]

- The library's `packages/lib/tests/component/diagram/DiagramView.createEngine.test.ts` passes unchanged against elkjs 0.12.0. Its `elkWorkerUrl` case asserts that elkjs's own warning contains the string `Web worker requested`; that string is still present in 0.12.0's `lib/elk.bundled.js`.
- The library's `ElkLayoutEngine.test.ts` passes unchanged. It replaces elkjs with a `MockELK` via `vi.mock('elkjs/lib/elk.bundled.js', …)`, so the installed version cannot affect it. Its assertions on `elk.nodeSize`, `elk.port.side`, `elk.padding`, and `elk.hierarchyHandling` remain valid ids in 0.12.0.
- No library or app test asserts an elkjs version number, and no test asserts real ELK coordinates — `DiagramView.test.ts` drives a `StubEngine`. So a coordinate shift cannot turn a test red; only the manual pass can catch it.
- The app's `frontend` suite passes unchanged.

### Manual-verify — every diagram surface

Run the backend and `cd frontend && npm run dev` (after step 12's cache clear). **Log in with Host `sqladmin-db`, not `localhost`** — the backend's allow-list is `db:5432,sqladmin-db:5432` — database `sqladmin`, user/password `sqladmin`/`sqladmin`. Every row must lay out and render; each is a distinct graph builder or layout direction.

| Surface | How to open | Must show |
|---|---|---|
| Schema diagram | Navigator → right-click a schema → **Schema diagram** | tables laid out left→right, FK edges with crow's-foot ends |
| Database diagram — Overview | right-click the database → **Database diagram** | one node per schema, cross-schema edges |
| Database diagram — Tables | in that panel, switch mode to **Tables** and pick a root | the cross-schema table graph; direction / depth / prune controls still work |
| Relation-rooted diagram | right-click a table → **Relations** | root-centred graph; hide / prune / direction controls still work |
| Schema dependency graph | right-click a schema → **Dependency graph** | dependency edges across the schema's objects |
| Relation dependency graph | right-click a view or table → **Dependencies** | that object's dependency graph |
| Schema inheritance graph | right-click a schema → **Inheritance graph** | top-down (`elk.direction: DOWN`) tree |
| Relation inheritance graph | right-click a table → **Inheritance** | that table's inheritance tree |
| Role membership graph | Roles tree → right-click a role → **Show membership graph** | the role at the centre, member roles around it |
| Role grants graph | Roles tree → right-click a role → **Show grants graph** | the role plus one node per table it holds a privilege on |
| Explain diagram | Query panel → run an Explain → the **Explain diagram** toolbar button | top-down plan tree |

Additional manual checks:

- **No empty diagram.** An empty canvas where nodes are expected is the signature of the elkjs pre-bundling failure, not of a layout regression — re-check that step 12 ran and that `frontend/node_modules/.vite/deps/` holds a freshly built `elkjs_lib_elk__bundled__js.js`.
- **Worker still terminates.** Close a diagram tab; no new console error appears. (One pre-existing, harmless `DOM handle N is not registered` error can fire when a tab is closed mid-animation — it is already recorded in `TODO.md` and is not a regression from this bump.)
- **Spacing is still readable.** Coordinates may differ from 0.10.2. Overlapping nodes, edges routed through nodes, or a diagram that no longer fits its initial view are regressions worth reporting; a small uniform shift is not.

---

## Verification

Run in this order; each command's working directory is given.

| # | Where | Command | Expect |
|---|---|---|---|
| 1 | `/home/jika/typescript/typescript-ui` | `grep -n '"elkjs"' packages/lib/package.json` | two hits, both `^0.12.0` |
| 2 | `/home/jika/typescript/typescript-ui` | `grep '"version"' node_modules/elkjs/package.json` | `0.12.0` |
| 3 | `/home/jika/typescript/typescript-ui` | `npm test` | green, including the five real-elkjs tests in `packages/lib/tests/component/diagram/DiagramView.createEngine.test.ts` |
| 4 | `/home/jika/typescript/typescript-ui` | `npm run build:lib` | succeeds; `grep -c 'elkjs/lib/elk.bundled.js' packages/lib/dist/lib/component/diagram.es.js` → `1` |
| 5 | `sqladmin/frontend` | `grep '"version"' node_modules/elkjs/package.json` | `0.12.0` |
| 6 | `sqladmin/frontend` | `ls -l node_modules/@jimka/typescript-ui` | a symlink to `/home/jika/typescript/typescript-ui/packages/lib` |
| 7 | `sqladmin/frontend` | `npm run typecheck` | clean (fails here if row 6's symlink is missing) |
| 8 | `sqladmin/frontend` | `npm test` | green, unchanged |
| 9 | `sqladmin/frontend` | `npm run build` | succeeds; `ls dist/assets \| grep -i elk` shows an `elk.bundled-*.js` chunk |
| 10 | `sqladmin` | `grep -rn '0\.10\.' THIRD-PARTY-NOTICES.md frontend/package.json` | zero matches (today it finds exactly the three sites steps 9, 13, and 14 change) |
| 11 | browser | the manual pass | every row of [Manual-verify — every diagram surface](#manual-verify--every-diagram-surface) renders |

Row 11 is the substantive check. Rows 1–10 only establish that the bump is wired consistently; none of them can see ELK's actual layout output.

---

## Documentation Impact

No public API changes, so no API doc page moves. The documentation work is entirely the packaging paperwork already listed in the steps:

- `../typescript-ui/packages/lib/docs/reference/changelog.md` — breaking entry under `## 0.3.0`.
- `../typescript-ui/packages/lib/docs/reference/migration.md` — subsection under `## Upgrading from 0.2.x to 0.3.0`.
- Both `THIRD-PARTY-NOTICES.md` files — the license expression.
- `TODO.md` — the extended loose-end bullet.

`../typescript-ui/packages/lib/docs/components/DiagramView.md` and `docs/components/index.md` mention elkjs but state no version (`npm install elkjs`), so they need no edit. Neither does the app's `README.md:35`, which links elkjs without a version.

---

## Potential Challenges

- **The app install fails outright without `--legacy-peer-deps`.** Mitigated by step 10 naming the flag; the reason and its blast radius are in the footnote and in `TODO.md`.
- **The install silently downgrades the app to the published library.** Mitigated by step 11 restoring the symlink; if it is missed, step 16's typecheck fails on the missing `elkWorkerFactory` / disposal API rather than failing silently.
- **A stale Vite dep cache renders diagrams empty with no error.** Mitigated by step 12 and by the "No empty diagram" manual check, which names the cause so it is not mistaken for a layout regression.
- **Layout coordinates may shift.** Nothing automated covers real ELK output, so the manual table is the only net. Treat overlaps and off-screen content as regressions; treat uniform shifts as expected.
- **Running the notices generator would produce unrelated diff.** Mitigated by step 14 hand-editing the single row and pinning it with an `npm query` check that needs no Python virtualenv.

---

## Critical Files

- [`plans/implemented/fk-diagram-cardinality-and-index-coverage.md`](plans/implemented/fk-diagram-cardinality-and-index-coverage.md) — the cross-repo plan structure and the `build:lib`-before-app-typecheck ordering this plan mirrors.
- [`plans/implemented/elk-worker-adoption.md`](plans/implemented/elk-worker-adoption.md) — why the app declares elkjs directly, and why `optimizeDeps` covers `elk.bundled.js` but not the worker asset. Its footnote on version alignment is the precedent for moving both ranges together.
- [`../typescript-ui/packages/lib/package.json`](../typescript-ui/packages/lib/package.json) — the three elkjs entries (dev, peer, peer-meta).
- [`../typescript-ui/packages/lib/src/typescript/lib/component/diagram/elkjs.d.ts`](../typescript-ui/packages/lib/src/typescript/lib/component/diagram/elkjs.d.ts) — the local type shim mapped through `packages/lib/tsconfig.json` `paths`; read it to confirm its `workerUrl` / `terminateWorker` comments still describe 0.12.0.
- [`../typescript-ui/packages/lib/tests/component/diagram/DiagramView.createEngine.test.ts`](../typescript-ui/packages/lib/tests/component/diagram/DiagramView.createEngine.test.ts) — the only tests that run real elkjs, and therefore the only automated signal this bump can trip.
- [`frontend/vite.config.ts`](frontend/vite.config.ts) — the `optimizeDeps.include` comment explaining the empty-diagram failure mode.
- [`frontend/src/dock/elkWorkerFactory.ts`](frontend/src/dock/elkWorkerFactory.ts) — the `elkjs/lib/elk-worker.min.js` reference that resolves against the app's own install.

---

## Non-Goals

- **Bumping `"@jimka/typescript-ui": "^0.2.0"` in `frontend/package.json`.** There is nothing to bump to — the registry has only `0.1.0`, `0.1.1`, and `0.2.0`, and the local checkout is still versioned `0.2.0`. This plan records the extra consequence in `TODO.md` instead.[^tsui-range]
- **Publishing a typescript-ui release.** The changelog and migration entries land in the in-progress `## 0.3.0` section; deciding and cutting that release is separate work.
- **Any `frontend/vite.config.ts` change.** The existing elkjs `optimizeDeps.include` entry remains correct; only the cache is cleared.
- **Adopting any of ELK's ten newly added layout options.** They are available after this bump; using them is the sibling `diagram-edge-merging-and-node-spacing.md`'s business.
- **Tuning layout, spacing, edge merging, focus, depth limits, or edge interaction** — the four sibling plans `diagram-layout-settled-and-root-focus.md`, `diagram-edge-merging-and-node-spacing.md`, `diagram-edge-interaction.md`, and `diagram-depth-limit-and-expand-indicator.md` own those.
- **A `CHANGELOG.md` entry in the app.** SQLAdmin's changelog is written at release time; `plans/implemented/elk-worker-disposal.md` set that precedent.
- **Vendoring elkjs into the library bundle.** It stays external and unbundled, which is what keeps the dual license a paperwork matter.[^dual-license]
- **Regenerating the Python inventory in `THIRD-PARTY-NOTICES.md`.** Only the one elkjs row changes.

---

## Notes

[^pin]: `^0.12.0` in all three places, per the user's decision: this is a pre-1.0.0 project, so the ranges track one minor line rather than admitting a permissive multi-range. A wider range (`>=0.10.0 <0.13.0`) would let the app and the library resolve different elkjs minors from one install, and the app's `new URL("elkjs/lib/elk-worker.min.js", import.meta.url)` worker resolves against the app's copy while the library's `import("elkjs/lib/elk.bundled.js")` resolves against whatever the consumer installed — so a split resolution puts a worker and a main-thread bundle from different ELK versions in the same page.

[^both-repos]: npm treats an *optional* peer as optional in presence only. When the peer **is** installed at a version outside the declared range, npm enforces the range and fails the install. Verified directly for this pair: a scratch project declaring `@jimka/typescript-ui@^0.2.0` plus `elkjs@^0.12.0` fails with `ERESOLVE … Conflicting peer dependency: elkjs@0.10.2 … peerOptional elkjs@"^0.10.0" from @jimka/typescript-ui@0.2.0`. The same trap was hit and recorded once before, from the other direction, in `../typescript-ui/plans/implemented/prepare-0-1-0-release.md` ("elkjs peer ERESOLVE — the plan's 'optional peer won't hard-error' premise was wrong"), where the resolution was likewise to move the app's range rather than to widen the library's peer.

[^no-source-change]: Verified against the unpacked 0.12.0 tarball, compared with the installed 0.10.2. (1) Both entry points still ship: `lib/elk.bundled.js` (the library's dynamic import, mapped through `packages/lib/tsconfig.json` `paths` onto the local `elkjs.d.ts` shim) and `lib/elk-worker.min.js` (the app's `elkWorkerFactory` reference). (2) `main` and `types` are unchanged (`lib/main`). (3) elkjs declares no `dependencies` and no `peerDependencies` of its own. (4) `lib/elk-api.js` differs from 0.10.2 only in its license header; the worker-construction path — including the `require.resolve('web-worker')` probe that `elkjs.d.ts` and `ElkLayoutEngineOptions.workerUrl` describe — is code-identical, and the `Web worker requested but 'web-worker' package not installed` warning string a library test asserts on is still present. (5) The `org.eclipse.elk.*` option registry grew from 316 ids to 326 with **nothing removed or renamed**: eight `layered.considerModelOrder.groupModelOrder.*` options, `layered.layerUnzipping.minimizeEdgeLength`, and `layered.nodePlacement.networkSimplex.nodeFlexibility.recomputeNodePlacement`. Every id either repo passes today is still present in 0.12.0 — checked one by one: `elk.algorithm`, `elk.direction`, `elk.spacing.nodeNode`, `elk.layered.spacing.nodeNodeBetweenLayers`, `elk.portConstraints` (app: `data/buildSchemaDiagram.ts`, `data/buildDatabaseDiagram.ts`, `data/buildRoleMembershipDiagram.ts`, `data/buildRoleGrantsDiagram.ts`, `data/buildExplainDiagram.ts`, `SqlAdminController.ts:173`/`:176`) and `elk.padding`, `elk.hierarchyHandling`, `elk.port.side`, `elk.nodeSize` (library `ElkLayoutEngine.ts` and its tests).

[^legacy-peer]: The `ERESOLVE` was reproduced, and so was the fix: `npm install --legacy-peer-deps` completes, and a later `npm ci` against the lockfile it writes also completes — so the `npm ci` in `Dockerfile:10` and the release workflow are not newly broken. The flag is passed on the command line for this one install and **not** written into an `.npmrc`: a persistent `legacy-peer-deps=true` would silence every future peer conflict in the repo, including real ones. The lockfile keeps recording `peerOptional elkjs@^0.10.0` under the `@jimka/typescript-ui` entry, because that field is copied from the published tarball's manifest; it stops disagreeing with reality only when a typescript-ui release carrying the `^0.12.0` peer is published, which is why step 15 records it in `TODO.md`.

[^symlink]: Reproduced in a scratch project: with `node_modules/@jimka/typescript-ui` replaced by a symlink to the local checkout, `npm install --legacy-peer-deps` after an elkjs bump reported "changed 2 packages" and left a real directory holding the published 0.2.0 in place of the symlink. npm reifies the tree its lockfile describes, and this lockfile describes a registry tarball. If the symlink is not restored, the app silently builds against the published library, which predates `elkWorkerFactory` and the Worker disposal path.

[^vite-cache]: Vite hashes the lockfile into its dep-optimizer cache key, so it normally re-optimizes on its own after an install. The one-line `rm -rf frontend/node_modules/.vite` is cheap insurance on the exact artefact that matters — `frontend/node_modules/.vite/deps/elkjs_lib_elk__bundled__js.js`, the pre-bundled CommonJS→ESM copy of elkjs. When that copy is stale or missing, `elk.bundled.js`'s `default` export is `undefined`, `new ELK()` throws inside the library, and the library's layout `catch` swallows it — the diagram renders empty with nothing in the console. This project has already been burned by the empty-diagram symptom (see the comment at `frontend/vite.config.ts:38-49`), so the cheap clear is worth one cold dep-optimize.

[^dual-license]: elkjs 0.12.0's manifest declares `"license": "EPL-2.0 OR GPL-3.0-or-later"`, and its source headers carry `SPDX-License-Identifier: EPL-2.0 OR GPL-3.0-or-later` plus the Eclipse "Secondary Licenses" paragraph. Its shipped `LICENSE.md` is still the EPL-2.0 text, differing from 0.10.2's copy in exactly one place: the Secondary-Licenses placeholder is filled in with "GNU General Public License v3.0 or later". Under EPL-2.0 that secondary option becomes available only when the Program is combined with GPL-covered work; neither repo does that, so the EPL-2.0 terms govern and no GPL-3.0 text needs to travel with either distribution. This also means nothing about the existing arrangement has to change: elkjs stays external and unbundled in the library (`vite.lib.config.ts` `rollupOptions.external`), and the app bundles it unmodified under EPL-2.0 exactly as before.

[^breaking]: `../typescript-ui/packages/lib/docs/reference/migration.md` states that breaking changes requiring updates get an entry on that page so a consumer can read the entry for the version they are moving to. A peer-range move requires a dependency update rather than a code update, but it is install-blocking — the strongest kind of upgrade break — so it is filed the same way the 0.2.0 and 0.3.0 breaks are: a bold `**Breaking:**` changelog entry plus a migration subsection.

[^changelog-history]: `changelog.md:328` sits under `## 0.1.0` and reads "**Optional peer:** `elkjs` (`^0.10.0`)". That is a true statement about what 0.1.0 shipped. Editing it would make the release history describe a package that never existed. The current range is stated in the new `## 0.3.0` entry instead.

[^no-new-tests]: This plan adds no logic, so there is nothing to red-green. The behaviour at risk — real ELK's output and its worker plumbing — is already covered as well as it can be: the five real-elkjs tests in `DiagramView.createEngine.test.ts` exercise construction, the `workerUrl` warning, and both disposal guards, and coordinates are deliberately not asserted anywhere (`DiagramView.test.ts` drives a `StubEngine`) because pinning ELK's exact output would make every upstream bump a test rewrite. That trade is what pushes the real verification into the manual surface table.

[^tsui-range]: `npm view @jimka/typescript-ui versions` returns `0.1.0`, `0.1.1`, `0.2.0`, and `../typescript-ui/packages/lib/package.json` is still at `0.2.0` — so there is no published version whose peer range admits elkjs 0.12.0, and no version number the app could point at. `TODO.md` already tracks the wider problem (the published `0.2.0` carries neither `elkWorkerFactory` nor the Worker disposal path); step 15 adds the install-level consequence to that same bullet rather than opening a second entry for one root cause.

---

## Implementation Notes

**Symlink target redirected to the typescript-ui worktree, not the main tree.**
The plan's "Architecture Decisions" section (and the table under "The app-side
install needs `--legacy-peer-deps`...") directs
`frontend/node_modules/@jimka/typescript-ui` to be restored pointing at
`/home/jika/typescript/typescript-ui/packages/lib` — the main typescript-ui
checkout. This run executed under parallel worktree orchestration: both repos'
work happened in pre-created sibling worktrees
(`sqladmin/.worktrees/elkjs-0-12-upgrade` and
`typescript-ui/.worktrees/elkjs-0-12-upgrade`) so that the main typescript-ui
tree — which the user may be using concurrently for other work — is never
touched. The symlink was therefore pointed at
`/home/jika/typescript/typescript-ui/.worktrees/elkjs-0-12-upgrade/packages/lib`
instead. This produces an identical verified outcome: the sqladmin worktree's
typecheck, tests, and production build all ran against exactly the library
state this plan produces (elkjs peer bumped to `^0.12.0`, notices and
changelog/migration updated), just isolated from the main checkout. No other
part of the plan changed.

**App-side install used a clean install rather than the wholesale
`node_modules` symlink.** The plan's own single-repo workflow assumes
`frontend/node_modules` already exists in the tree being worked in. This
worktree started with no `frontend/node_modules` at all. Rather than
symlinking it wholesale from the main sqladmin tree's `frontend/node_modules`
and then running `npm install --legacy-peer-deps` on top (which would mutate
the main tree's real `node_modules` directory through the symlink, since npm
writes through it), a plain `npm install --legacy-peer-deps` was run directly
inside the worktree's `frontend/`, producing the worktree's own independent
`node_modules`. This keeps the main sqladmin tree completely untouched, at the
cost of a slower first install; the plan's step 10 checks (elkjs resolves to
`0.12.0`, and the lockfile's elkjs entry is correct) passed identically either
way.

**The app lockfile carries one hunk outside the elkjs entry.** Step 10's check
inspected only the elkjs entry, so this went unremarked at commit time:
`frontend/package-lock.json` also flips `node_modules/typescript` from
`"devOptional": true` to `"dev": true`. It is not caused by the elkjs bump —
replaying `npm install --legacy-peer-deps` against the *unmodified* base
manifest reproduces exactly this flip and nothing else. The cause is the
plan-mandated `--legacy-peer-deps` flag: it makes npm ignore peer edges, so
`typescript` stops being reachable through `lexical`'s optional
`typescript >=5.2` peer and is no longer recorded as optional. It is inert here
— no `--omit=dev` exists anywhere in the repo, and `npm ci` against the
committed lockfile still installs `typescript`, so the Dockerfile build is
unaffected — and it is left in place deliberately, because hand-reverting the
line would desync the lockfile from what npm actually produces. An install
without the flag will flip it back.

**Outcome of step 18's manual diagram pass.** The pass was performed, driving a
real browser session against this worktree's own dev server and a dedicated
backend instance with a seeded database. Every surface rendered, with no
empty-canvas failures and no worker or console errors on tab close: the schema
diagram (checked both on a two-table schema and on a 154-table stress case),
the database diagram in Overview and in rooted cross-schema Tables mode, the
relation-rooted diagram, the schema and relation dependency graphs, the
role-membership graph, the role-grants graph, and the Explain diagram. Two
limitations are worth recording rather than glossing. First, the schema and
relation inheritance graphs were opened and rendered without error, but the
seed database declares no table-inheritance relationships (`select count(*)
from pg_inherits` is 0), so those two confirmed only the empty/trivial-graph
path — a populated inheritance graph was not exercised under elkjs 0.12.0.
Second, the pass recorded rendering success and the absence of errors, but did
not record an explicit judgement on step 18's spacing criterion (no overlapping
nodes, no edges routed through nodes, the diagram still fitting its initial
view). Coordinate drift is the one risk this bump carries that no automated
check in either repo can see, so that judgement is worth making deliberately
before merge.
