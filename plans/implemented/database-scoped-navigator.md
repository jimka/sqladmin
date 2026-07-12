# Database-Scoped Navigator — Implementation Plan

## Overview

The app connects to exactly one database per session, yet the navigator's top
level is a lazy "Databases" list that fetches `pg_database` and shows every
connectable database (the logged-in one plus stock `postgres`). Since only the
logged-in database is ever usable, this level is dead weight and one extra click
between the user and their schemas.

This plan collapses that level: the sidebar rail is renamed **"Database"**
(singular) and its tree is rooted directly at the logged-in database's *schemas*
— no database-selection node. When the database has a single schema, that schema
is auto-expanded on load. Separately, the shell's lower-left status message,
today `Connection: default`, is changed to show the logged-in database name.

The change is entirely frontend and app-side (no `@jimka/typescript-ui` library
edits, no backend edits). It touches three files:
[`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts#L186),
[`frontend/src/shell/DatabaseExplorerView.ts`](frontend/src/shell/DatabaseExplorerView.ts#L23),
and [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts#L190).

---

## Architecture Decisions

### Source of truth for the logged-in database is `Session.database`

The backend's `/api/login` (and `/api/whoami`) response is the
[`Session`](frontend/src/data/api.ts#L51) shape `{ connectionId, csrfToken,
username, database }`. `database` is the connected database name;
`connectionId` is the opaque server-side pool handle (today literally
`"default"`). The bootstrap already forwards both:
[`SqlAdminApp.ts:27`](frontend/src/SqlAdminApp.ts#L27) calls
`new SqlAdminController(session.connectionId, session.username, session.database)`.
So the database name is **already in the controller's constructor** — it is
merely not stored as a field today (only used to build the identity tooltip at
[`SqlAdminController.ts:73`](frontend/src/SqlAdminController.ts#L73)). We store
it and expose it, feeding both the navigator root and the lower-left label. **No
new fetch and no backend change is needed** to learn the database name.

### The lower-left `'default'` is the connection id, printed at one line

The lower-left status text is set once in the controller constructor:
[`SqlAdminController.ts:227`](frontend/src/SqlAdminController.ts#L227)
`this.statusBar.setMessage(\`Connection: ${connectionId}\`)`. Because
`connectionId` is `"default"`, the bar reads `Connection: default`. This is the
exact symbol to change — swap `connectionId` for the database name. (The
`"default"` string itself is never hardcoded in the frontend; it is the
constructor's *default parameter value* at
[`SqlAdminController.ts:190`](frontend/src/SqlAdminController.ts#L190), used only
by DOM-less test callers — leave it as-is.)

### Removing the database level does not change how schemas load — it just re-roots them

Schema loading is already a standalone function keyed on `(conn, database)`:
[`loadSchemas(conn, database)`](frontend/src/navigator/NavigatorTree.ts#L217)
→ `getSchemas` → `schemaNode(...)`. Today it is reached lazily as a database
node's `loadChildren`. The only wiring change is to make the tree's **top
level** be `loadSchemas(conn, database)` instead of `loadDatabases(conn)`. The
`schemaNode` → `categoryNode` → `objectLeaf` machinery below the schema is
untouched — schema nodes already carry `database` on their `DbObjectRef`
(`{ connectionId, database, schema, kind: "schema" }`), so every object leaf's
`ref` stays fully qualified exactly as before.

### Auto-expand uses the existing `Tree.revealByPredicate` — the only public expand API

`Tree` exposes **no** public "expand this node" method; `_onToggle` /
`_loadAndExpand` are private. The one public method that mutates the expanded
set is
[`revealByPredicate(predicate)`](frontend/src/navigator/NavigatorTree.ts) (in
the library at `component/tree/Tree.ts`), which finds the first node whose
`data`/node satisfies `predicate`, **expands every *ancestor* on the path to it
(not the match itself)**, lazily loading branches as it descends, and scrolls
the match into view. To expand the single schema node we therefore reveal one of
its *children*: after re-rooting, the top level is the sole schema node (which
carries `data`), and its children are the category group nodes (Tables / Views /
Materialized Views), which are the **only nodes in the tree with no `data`**
(see [`categoryNode`](frontend/src/navigator/NavigatorTree.ts#L245) — it sets no
`data`). So `revealByPredicate(data => data === undefined)` matches the schema's
first category, expanding exactly the schema node (one level, revealing its
category folders) and no deeper. If the single schema is empty (no objects), the
walk finds no match and nothing expands — correct, there is nothing to show.
`revealByPredicate` loads the schema's objects exactly once (it caches into
`children` + `_loadedNodes`), so a later manual expand does not refetch.

### Preserve the "Show database diagram" entry point on the schema context menu

Today the database node's right-click menu is the *only* way to open the
whole-database ER diagram:
[`NavigatorTree.ts:113`](frontend/src/navigator/NavigatorTree.ts#L113)
(`ref.kind === "database"` →
`controller.openDatabaseDiagram(ref, node)`). Removing the database node would
silently drop that feature. Rather than add sidebar-header plumbing, we move the
item onto the **schema** node's context menu, synthesizing the database ref from
the schema's own ref: `{ connectionId: ref.connectionId, database: ref.database,
kind: "database" }`.
[`openDatabaseDiagram(ref, _node?)`](frontend/src/SqlAdminController.ts#L511)
already accepts an optional node and reads `ref.database`, so this needs no
controller change beyond the getter. This keeps the whole-database diagram one
right-click away without reintroducing a database tree level.

### Keep `getDatabases` / the `/databases` route in place (unused, minimal blast radius)

After re-rooting, the frontend no longer calls
[`getDatabases`](frontend/src/data/api.ts#L136), and the backend
`GET /api/{connection_id}/databases` route + `ListDatabasesQuery` become
unreferenced by the app. Deleting them is out of scope: it widens the diff into
`api.ts`, `backend/app/main.py`, and `backend/app/operations/` for no functional
gain, and the route is a reasonable multi-DB seam to leave dormant. We simply
stop importing `getDatabases` in `NavigatorTree.ts`; the export in `api.ts`
stays (it still mirrors a live backend route). See **Non-Goals**.

---

## Public API

Controller gains one read accessor (mirrors the existing `connectionId` getter),
backed by a stored field set from the already-present constructor parameter:

```ts
// SqlAdminController
private readonly _database: string | undefined; // from the `database` ctor param

/** The connected database name (from the authenticated session), or undefined
 *  for DOM-less callers that omit it. Feeds the navigator root and status bar. */
get database(): string | undefined;
```

No other signatures change. `NavigatorTree`'s constructor still takes only
`controller`; it now also reads `controller.database`.

---

## Internal Structure

`NavigatorTree` after the change (private fields + refresh):

```ts
export class NavigatorTree extends Tree implements ExplorerTree {
    private readonly controller: SqlAdminController;
    private readonly conn:       string;
    private readonly database:   string; // controller.database ?? "" (always set in-app)
    private readonly contextMenu = Menu();

    // ...constructor: this.database = controller.database ?? "";

    // (Re)load the top level as the logged-in database's SCHEMAS (no database
    // level); auto-expand a lone schema. Public arrow field — held by reference
    // by refreshTool/bindRefreshShortcut.
    refresh = (): void => {
        void loadSchemas(this.conn, this.database)
            .then(nodes => {
                this.setNodes(nodes);
                // A single-schema database: expand that schema so its category
                // folders show immediately. revealByPredicate expands the
                // match's ANCESTORS, so match the schema's first (data-less)
                // category node to expand exactly the schema, one level.
                if (nodes.length === 1) {
                    void this.revealByPredicate(data => data === undefined);
                }
            })
            .catch(error => this.controller.notifyError(error));
    };
}
```

`loadDatabases` and `databaseNode` are deleted. `loadSchemas`, `schemaNode`,
`loadObjects`, `categoryNode`, `objectLeaf` are unchanged.

---

## Ordered Implementation Steps

1. **`frontend/src/SqlAdminController.ts` — store and expose the database name.**
   - Add a field beside `_connectionId`
     ([~L129](frontend/src/SqlAdminController.ts#L129)):
     `private readonly _database: string | undefined;`
   - In the constructor body ([~L191](frontend/src/SqlAdminController.ts#L191)),
     after `this._connectionId = connectionId;`, add
     `this._database = database;`.
   - Add a getter next to `get connectionId()`
     ([~L237](frontend/src/SqlAdminController.ts#L237)):
     ```ts
     get database(): string | undefined {
         return this._database;
     }
     ```

2. **`frontend/src/SqlAdminController.ts` — relabel the lower-left status.**
   - Change [L227](frontend/src/SqlAdminController.ts#L227) from
     `this.statusBar.setMessage(\`Connection: ${connectionId}\`);` to
     `this.statusBar.setMessage(\`Database: ${database ?? connectionId}\`);`
     (fall back to the connection id only for the DOM-less path that omits
     `database`).

3. **`frontend/src/shell/DatabaseExplorerView.ts` — rename the rail.**
   - Change [L23](frontend/src/shell/DatabaseExplorerView.ts#L23)
     `treeLabel: "Databases"` → `treeLabel: "Database"`. Leave `treeGlyph:
     "database"` and the class name `DatabaseExplorerView` unchanged.

4. **`frontend/src/navigator/NavigatorTree.ts` — re-root the tree at schemas.**
   - Update the import at [L15](frontend/src/navigator/NavigatorTree.ts#L15):
     drop `getDatabases`, keep `getObjects, getSchemas`.
   - Add a `private readonly database: string;` field
     ([~L67](frontend/src/navigator/NavigatorTree.ts#L67)) and set it in the
     constructor after `this.conn = controller.connectionId;`
     ([L73](frontend/src/navigator/NavigatorTree.ts#L73)):
     `this.database = controller.database ?? "";`.
   - Rewrite the `refresh` arrow field
     ([L195–199](frontend/src/navigator/NavigatorTree.ts#L195)) to call
     `loadSchemas(this.conn, this.database)`, `setNodes(nodes)`, and the
     single-schema `revealByPredicate(data => data === undefined)` guard shown in
     **Internal Structure**.
   - Delete `loadDatabases`
     ([L202–206](frontend/src/navigator/NavigatorTree.ts#L202)) and
     `databaseNode` ([L208–215](frontend/src/navigator/NavigatorTree.ts#L208)).
   - Update the file header comment
     ([L1–8](frontend/src/navigator/NavigatorTree.ts#L1)) and the `refresh`
     doc-comment ([L191–194](frontend/src/navigator/NavigatorTree.ts#L191)):
     "databases -> schemas -> …" becomes "schemas -> …", and "(Re)load the
     top-level databases" becomes "(Re)load the top-level schemas".

5. **`frontend/src/navigator/NavigatorTree.ts` — fix the context menu.**
   - Delete the `ref.kind === "database"` branch
     ([L112–119](frontend/src/navigator/NavigatorTree.ts#L112)) — there is no
     database node any more.
   - In the `ref.kind === "schema"` branch
     ([L124–132](frontend/src/navigator/NavigatorTree.ts#L124)), append a
     "Show database diagram" item so the whole-database ER diagram stays
     reachable:
     ```ts
     { text: "Show database diagram", glyph: "diagram-project",
       action: () => void this.controller.openDatabaseDiagram(
           { connectionId: ref.connectionId, database: ref.database, kind: "database" }) },
     ```
     (Add it after the three existing schema items.)

6. **Regression sweep.** From `frontend/`:
   - `grep -rn 'getDatabases\|loadDatabases\|databaseNode' src/` — expect **zero**
     matches (the `api.ts` export intentionally stays, so run this scoped to
     `src/navigator/`; `src/data/api.ts` keeping `getDatabases` is expected).
   - `grep -rn '"Databases"' src/` — expect zero (rail relabeled; the Alt+D menu
     item text `"Databases"` in `SqlAdminShell.ts`/`shortcutRegistry.ts` is a
     *rail switcher* accelerator, out of scope — confirm those are the only
     survivors and leave them).
   - `grep -rn "kind === \"database\"" src/navigator/` — expect zero.

7. **Typecheck & test.** From `frontend/`: `npm run typecheck && npm test`.

---

## Files to Create / Modify / Delete

| Action | File |
|--------|------|
| Modify | `frontend/src/SqlAdminController.ts` (store `_database`, add `database` getter, relabel status line) |
| Modify | `frontend/src/navigator/NavigatorTree.ts` (re-root at schemas, auto-expand, context-menu edits, drop `loadDatabases`/`databaseNode`) |
| Modify | `frontend/src/shell/DatabaseExplorerView.ts` (`treeLabel` → `"Database"`) |

No files created or deleted; no backend or library files touched.

---

## Expected Behaviour

Manual-verify (UI/geometry/events — the vitest harness is DOM-less and cannot
mount the Tree or StatusBar):

- **Rail title.** The sidebar's object-explorer accordion section header reads
  **"Database"** (singular), with the database glyph — not "Databases".
- **Root level = schemas.** On login, the Database tree's top-level rows are the
  logged-in database's schemas (e.g. `analytics`, `customers`, `hr`, …). There
  is **no** database row above them and **no** `postgres` database listed.
- **Multi-schema database.** Top-level schema nodes render collapsed; expanding
  one lazily loads its Tables/Views/Materialized Views category folders exactly
  as before. Object leaves open, right-click menus, diagrams, and FK reveal all
  still work (object refs remain fully qualified with `database`).
- **Single-schema database.** If the database has exactly one schema, that schema
  node is expanded on load, showing its category folders immediately (categories
  themselves stay collapsed). An empty single schema expands to nothing (no
  error).
- **Lower-left status.** The status bar's left zone initially reads
  `Database: <name>` (e.g. `Database: sqladmin`), not `Connection: default`.
  (As today, a subsequent per-operation `setMessage` transiently overwrites the
  left zone — unchanged behavior; the right-zone identity badge is untouched.)
- **Database diagram still reachable.** Right-clicking any schema node offers
  "Show database diagram", which opens the whole-database ER diagram (all
  schemas) — the action formerly on the database node.
- **Refresh.** The rail's Refresh tool (and Alt+R while the rail is focused)
  reloads the schema list and re-applies the single-schema auto-expand.

Unit-testable: none of the above is exercisable without the DOM; there are no
pure functions added or changed (the delta is tree wiring, a status string, and
a getter). Verify by driving the app.

---

## Verification

1. `cd frontend && npm run typecheck` — clean.
2. `cd frontend && npm test` — existing suites green (no test references
   `getDatabases`/`loadDatabases`/the `"Databases"` label; the change adds no
   pure logic to unit-test).
3. Run the regression greps in Step 6.
4. Manual smoke (per **Expected Behaviour**): with the seed DB up
   (`docker compose up -d db`), backend running, and `npm run dev`, log into
   database `sqladmin`. Confirm: rail titled "Database"; top level is the
   schemas of `sqladmin` (no database/`postgres` row); lower-left reads
   `Database: sqladmin`; a schema's objects still open; right-click a schema →
   "Show database diagram" opens. To exercise the single-schema auto-expand,
   log into a database exposing exactly one schema (e.g. a database with only
   `public`) and confirm that schema is expanded on load.

No library rebuild is required — the change is app-side only, so `build:lib` is
not involved.

---

## Potential Challenges

- **Status line is transient.** The lower-left `Database: <name>` is set once and
  is overwritten by the next `statusBar.setMessage` (per-operation feedback).
  This matches today's `Connection: default` behavior; making it persistent
  (e.g. a right-zone widget) is out of scope. Mitigation: none needed — the
  requirement is to replace the displayed `'default'`, which Step 2 does.
- **`revealByPredicate` predicate specificity.** `data => data === undefined`
  relies on category nodes being the *only* data-less nodes. This holds:
  `categoryNode` is the sole builder that omits `data` (schema nodes, database
  refs, and object leaves all set it). Mitigation: the guard runs only when
  `nodes.length === 1`, so it can only match under the single schema; a comment
  pins the invariant.
- **`controller.database` optionality.** The getter is `string | undefined`
  (the ctor param is optional for DOM-less tests). In the running app it is
  always the session database, so `NavigatorTree` uses `?? ""`; that fallback
  never executes in-app. Mitigation: documented at the read site.

---

## Critical Files

- [`frontend/src/navigator/NavigatorTree.ts`](frontend/src/navigator/NavigatorTree.ts)
  — the tree builder being re-rooted; note `schemaNode`/`categoryNode`/`objectLeaf`
  stay as-is.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts)
  — `connectionId` getter (L237) is the template for the new `database` getter;
  status line at L227; `openDatabaseDiagram` at L511.
- [`frontend/src/shell/treeExplorerView.ts`](frontend/src/shell/treeExplorerView.ts)
  — the shared accordion assembly; `treeLabel` flows into the section header.
- [`frontend/src/data/api.ts`](frontend/src/data/api.ts) — `Session` shape (L51,
  source of `database`); `getSchemas` (L141) is the still-used loader;
  `getDatabases` (L136) becomes app-unused but stays.
- The library `Tree` (`@jimka/typescript-ui/component/tree`) `revealByPredicate`
  contract — expands ancestors of the match, loading lazily.

---

## Non-Goals

- **No backend change.** `GET /api/{connection_id}/databases` and
  `ListDatabasesQuery` (`backend/app/operations/list_databases.py`) are left in
  place, unused by the app — deleting them is a separate cleanup with no
  functional benefit here and would widen the diff into backend routing.
- **No removal of `getDatabases` from `api.ts`.** It still mirrors the live
  backend route; only its import in `NavigatorTree.ts` is dropped.
- **No persistent database indicator.** The lower-left remains the existing
  transient left-zone message; no new always-on database widget is added.
- **No multi-database UI.** This deliberately assumes one database per session
  (the app's current model); re-introducing a database picker is not in scope.
- **No rename of the `DatabaseExplorerView` class, its file, the `database`
  glyph, or the Alt+D "Databases" *rail-switcher* menu item** — only the
  visible accordion section title changes to "Database".
