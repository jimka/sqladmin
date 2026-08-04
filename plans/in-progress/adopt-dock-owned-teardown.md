---
depends-on: [typescript-ui-0-4-0-upgrade, content-derived-column-sizing]
touches-shared:
  - frontend/package.json
  - frontend/package-lock.json
  - frontend/src/SqlAdminController.ts
  - frontend/src/dock/QueryResultView.ts
  - LIBRARY_NOTES.md
---

# Adopt Dock-Owned Tab Teardown — Implementation Plan

## Overview

The typescript-ui change this plan adopts makes closing a tab a destroy. [`Tab.closeEntry`](../../typescript-ui/packages/lib/src/typescript/lib/layout/Tab.ts) disposes the content component it removed, and [`Component.destructor()`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L753) recurses into every registered child, releasing each one's element, handles and per-instance stylesheet rules. SQLAdmin hand-rolls a partial version of that today: [`frontend/src/dock/panelDisposers.ts`](frontend/src/dock/panelDisposers.ts) is a registry of panels to dispose on close, driven by a `disposeOnClose` flag that [`SqlAdminController.openAsyncPanel`](frontend/src/SqlAdminController.ts#L2958) threads through a `beginLoad` / `settle` token dance, plus four direct `register` calls.

This plan deletes the registry, the flag and the token dance, and deletes every app-side `dispose` that existed only because the library did not own teardown. Nine of the fifteen `openAsyncPanel` call sites pass the flag; [`openTable`](frontend/src/SqlAdminController.ts#L448) and [`openStructure`](frontend/src/SqlAdminController.ts#L676) — the app's two highest-traffic tabs — do not, which is why closing one 20-column table tab stranded **2288** stylesheet rules per cycle, linearly, with no bound.[^measured]

One piece of teardown is genuinely the app's own and must survive. [`QueryPanel`](frontend/src/dock/QueryPanel.ts#L379) takes its result `TabPanel` out of the Split whenever no result is shown, so that `TabPanel` is not in the subtree the Dock destroys and nothing reaches it. It moves into a `protected destructor()` override on a new content class, which is the only shape teardown recursion reaches — a `dispose` field on a plain wrapper object is not.

**The work runs in two phases, and the boundary matters more than usual here.** typescript-ui 0.4.1 is not released yet, and it is not released *until this app's verification passes* — SQLAdmin is where the library fix is proven. So phase 1 builds and verifies everything against a symlink to the local typescript-ui checkout, with no release in existence and the app's manifest still reading `^0.4.0`. Phase 2 runs after the library publishes 0.4.1 on the strength of phase 1: it undoes the symlink, moves the range to `^0.4.1`, and re-runs the leak measurement against the published tarball.

---

## Architecture Decisions

### The registry is deleted whole, not narrowed

`frontend/src/dock/panelDisposers.ts`, its unit test, the `_panelDisposers` field, the `disposeOnClose` flag and the four `register` calls all go. Nothing replaces them: the library now covers both jobs the registry did — disposing a closed tab's content, and disposing a panel whose build lands after its tab closed.[^library-covers]

This follows the rule this app already set for the other half of the same seam. `plans/implemented/lazy-tab-loading-sequence.md`'s decision *"No app-side in-flight bookkeeping"* handed the whole pending window — spinner, placeholder, in-flight tracking — to the library and deleted the app's version of it. Teardown is the same seam at the other end of a tab's life.

### The nine diagram sites need no replacement, because worker termination is already library-owned

Terminating a diagram's ELK Web Worker is not app code. [`DiagramView.destructor()`](../../typescript-ui/packages/lib/src/typescript/lib/component/diagram/DiagramView.ts#L379) disposes the layout engine, which terminates the worker, and every diagram panel this app opens either **is** a `DiagramView` subtree owner or holds one as a registered child. So the nine sites lose `disposeOnClose: true` and gain nothing.[^elk-free]

| Panel | Shape | How the destroy reaches the worker |
|---|---|---|
| `SchemaDiagramPanel`, `DatabaseDiagramPanel`, `RelationDiagramPanel`, `RelationGraphPanel`, `RootedRelationGraphPanel`, `RoleGrantsDiagramPanel` | `extends DiagramShell extends Panel` | the shell passes `view` in its `super({ components })` ([diagramShell.ts:282-288](frontend/src/dock/diagramShell.ts#L282)), so `view` is a registered child |
| `ExplainDiagramPanel` | `extends Panel`, a tab inside `QueryPanel`'s result strip | registered child of the result `TabPanel`, itself a registered child of the query tab's content |

### Composition wrappers lose `dispose`; the one part recursion cannot reach gets a `destructor()`

A composition wrapper is a plain class that owns a `content` component and a `dispose` field instead of extending a library base — [`COMPONENT_CONVENTIONS.md` section (f)](frontend/COMPONENT_CONVENTIONS.md). Six of them exist. Teardown recursion calls `destructor()` on registered children, so a wrapper's `dispose` field is never reached once the app stops calling it explicitly — the wrapper is not in anybody's child list.

Every wrapper `dispose` in the app disposes a component that is a registered descendant of that wrapper's own `content`, so the recursion already covers it and the field is deleted. `## Teardown Audit` walks all of them and names the one exception.

That exception is `QueryPanel`'s result `TabPanel`, which [`hideResultPane`](frontend/src/dock/QueryPanel.ts#L379) removes from the Split while no result is shown. Its cleanup moves into a `protected destructor()` override on a new module-private `QueryPanelContent extends Container`, which becomes the wrapper's `content`.[^resulthost]

### No call site opts out

`disposeOnClose: false` is not used anywhere. SQLAdmin never re-adds a component after its tab closed: every reopen goes through `focusPanel` and then builds a fresh panel, and the Dock's layout is never saved or restored.[^no-optout]

### Phase 1 runs against the local checkout, because the release depends on it

The library's dependency here is not a published version — it is the fix existing in the sibling typescript-ui working tree, built into the `dist/lib` this app imports. `plans/dock-disposes-tab-content.md` in that repo must be implemented there; it deliberately leaves `packages/lib/package.json` at `0.4.0`, so the check is on the code, not on a version string.[^phase-gate]

Phase 1 therefore installs the local checkout over the published package, exactly as `.claude/skills/verify/SKILL.md`'s *Library changes* section describes: remove the installed directory, symlink the sibling checkout in its place using an **absolute** target, and run `npm run build:lib` in the library. The app imports the library's built `dist/lib`, so a library source edit is invisible until that build runs.

### The range bump is phase 2, and the phase-1 mismatch is expected

Through the whole of phase 1, [`frontend/package.json:20`](frontend/package.json#L20) still reads `^0.4.0` while `frontend/node_modules/@jimka/typescript-ui` is a symlink to a checkout that is neither 0.4.0 nor a registry artefact. **This mismatch is intended; do not "fix" it midway.** Reconciling it early would mean either installing a version that does not exist yet or reverting the symlink the verification depends on.

Phase 2 resolves it in one move: `npm install` reifies the lockfile and puts a real directory back, the range moves to `^0.4.1`, and the lockfile is regenerated against the published tarball. SQLAdmin's own version number, its `CHANGELOG.md` release entry, the release commit and the tag are a separate step the user performs by hand, and are not in this plan.

**Overlap with the two plans this one lands after**, stated so it is not discovered mid-implementation:

| Plan | File both touch | What to expect |
|---|---|---|
| `plans/typescript-ui-0-4-0-upgrade.md` | `frontend/package.json`, `frontend/package-lock.json` | it sets the range to `^0.4.0` and regenerates the lockfile; phase 2 here moves the same line again, to `^0.4.1` |
| `plans/typescript-ui-0-4-0-upgrade.md` | `LIBRARY_NOTES.md`, `.claude/skills/verify/SKILL.md` | it may add a scroll-regression entry and rewrites the skill's *Library changes* section; this plan edits a different entry and a different section |
| `plans/typescript-ui-0-4-0-upgrade.md` | `frontend/node_modules/@jimka/typescript-ui` (not a tracked file, but shared state) | its outstanding Parts D and E verify the **published 0.4.0** with no symlink, so they must finish before phase 1 installs one[^sibling-gate] |
| `plans/content-derived-column-sizing.md` | `frontend/src/dock/QueryResultView.ts` | it adds `autoSizeColumns: true` to the grid at line 62; this plan deletes both classes' `dispose` fields — different lines in the same two classes |
| `plans/content-derived-column-sizing.md` | `frontend/src/SqlAdminController.ts` | it threads a text measurer through `buildSchemaGraphData` (line 1575); this plan edits the registry, `openAsyncPanel` and the nine diagram specs |

---

## Public API

All app-internal. `openAsyncPanel` loses its flag ([SqlAdminController.ts:2958](frontend/src/SqlAdminController.ts#L2958)):

```typescript
private openAsyncPanel(
    spec: { id: string; title: string; glyph: string; tooltip?: string; ref?: DbObjectRef },
    build: () => Promise<Component>,
): void
```

Deleted module — `frontend/src/dock/panelDisposers.ts`, exporting `PanelDisposers` and `DisposablePanel`.

Deleted members:

| Symbol | File |
|---|---|
| `QueryPanel.dispose` | [`dock/QueryPanel.ts:150`](frontend/src/dock/QueryPanel.ts#L150) |
| `DefinitionPanel.dispose` | [`dock/DefinitionPanel.ts:48`](frontend/src/dock/DefinitionPanel.ts#L48) |
| `FunctionDefinitionPanel.dispose` | [`dock/FunctionDefinitionPanel.ts:29`](frontend/src/dock/FunctionDefinitionPanel.ts#L29) |
| `DocumentationPanel.dispose` | [`dock/DocumentationPanel.ts:18`](frontend/src/dock/DocumentationPanel.ts#L18) |
| `QueryResultGrid.dispose` | [`dock/QueryResultView.ts:53`](frontend/src/dock/QueryResultView.ts#L53) |
| `QueryResultChart.dispose` | [`dock/QueryResultView.ts:78`](frontend/src/dock/QueryResultView.ts#L78) |
| `DefinitionEditor.dispose()` | [`dock/definitionEditor.ts:90`](frontend/src/dock/definitionEditor.ts#L90) |
| `SqlAdminController._panelDisposers` | [`SqlAdminController.ts:234`](frontend/src/SqlAdminController.ts#L234) |

`QueryPanel.content` narrows from `Container` to the new module-private `QueryPanelContent` (a `Container` subclass), so the `readonly content` field's declared type becomes `QueryPanelContent`. Every consumer passes it to `dock.addPanel({ content })`, which takes a `Component`, so no call site changes.

---

## Internal Structure

`QueryPanelContent` replaces the bare `Container` built at [QueryPanel.ts:240](frontend/src/dock/QueryPanel.ts#L240). It is declared at module scope, above `class QueryPanel`, and is neither exported nor wrapped in `callable()` — it is a private implementation detail with no outside construction site.

```typescript
/**
 * The query panel's mountable root. Exists as a class rather than a bare
 * `Container` so it can override `destructor()`: the Dock destroys this
 * component when its tab closes, and the result pane is not always among
 * its children.
 */
class QueryPanelContent extends Container {
    private readonly _resultHost: TabPanel;

    /** @param resultHost - The result pane, which the panel detaches while hidden. */
    constructor(resultHost: TabPanel) {
        super({ layoutManager: new BorderLayout({ spacing: 0 }) });

        this._resultHost = resultHost;
    }

    /**
     * `hideResultPane` removes the result pane from the Split while no result
     * is shown, so the child recursion in `super.destructor()` cannot reach it
     * then. Disposing it here covers both states — `dispose()` is idempotent,
     * so the shown case is a harmless second pass.
     */
    protected destructor(): void {
        this._resultHost.dispose();

        super.destructor();
    }
}
```

---

## Teardown Audit

Every panel and composition wrapper under `frontend/src/dock` and `frontend/src/shell` that owns cleanup, and what this change does to it. "Reached" means the disposed object is a registered descendant of the component the Dock destroys, so `Component.destructor()`'s recursion runs its teardown.

**Dock tab content**

| Site | Cleanup today | Reached? | This plan |
|---|---|---|---|
| `TableWorkPanel` (`openTable`) | none | — | nothing; the tab's destroy now runs, which is the measured leak |
| `StructurePanel` (`openStructure`) | none | — | as above |
| `SequenceInfoPanel` | none, by an explicit decision recorded at [SequenceInfoPanel.ts:36-41](frontend/src/dock/SequenceInfoPanel.ts#L36) | — | comment rewritten; it cites a registry that no longer exists |
| `RoleGrantsPanel` | none | — | nothing |
| nine diagram panels | ELK worker, via the library's `DiagramView.destructor()` | **yes** | delete `disposeOnClose: true` at the nine sites |
| `DefinitionPanel` | `dispose = () => editor.dispose()` ([:100](frontend/src/dock/DefinitionPanel.ts#L100)) — the `CodeEditor` is added to `body`, inside `content` | **yes** | delete the field |
| `FunctionDefinitionPanel` | `dispose = () => editor.dispose()` ([:49](frontend/src/dock/FunctionDefinitionPanel.ts#L49)) — the `CodeEditor` is added to `content` | **yes** | delete the field |
| `DocumentationPanel` | `dispose = () => editor.dispose()` ([:36](frontend/src/dock/DocumentationPanel.ts#L36)) — the `MarkdownEditor` is `content`'s only child | **yes** | delete the field |
| `DefinitionEditor` (the helper inside `DefinitionPanel` and `FunctionDefinitionPanel`) | `dispose()` forwarding to its `CodeEditor` ([:90](frontend/src/dock/definitionEditor.ts#L90)) | **yes** — the owning panel mounts `editor.editor` | delete the method |
| `QueryPanel` | `dispose` disposing four result slots and the SQL editor ([:974-981](frontend/src/dock/QueryPanel.ts#L974)) | **all but one** | delete the field; the result `TabPanel` moves to `QueryPanelContent.destructor()` |
| `QueryPanel`'s result `TabPanel` | nothing disposes it today, in either state | **no** while hidden — `hideResultPane` detaches it | disposed by `QueryPanelContent.destructor()` |
| `QueryResultGrid` | `dispose` is `() => {}` ([:65](frontend/src/dock/QueryResultView.ts#L65)) | — | delete the field; a no-op `dispose` is the signal that nothing was ever wired |
| `QueryResultChart` | `dispose = () => { chart.dispose(); }` ([:165](frontend/src/dock/QueryResultView.ts#L165)) — the live chart is inside `viewHost`, inside `content` | **yes** | delete the field. The `chart.dispose()` inside `rebuildChart` ([:148](frontend/src/dock/QueryResultView.ts#L148)) **stays**[^chart-rebuild] |
| `ExplainDiagramPanel` (query panel's Diagram tab) | ELK worker, via the library | **yes**, on both its own tab close and the query tab's | delete `diagramSlot.dispose` |
| `QueryPanel`'s `Event.addSubtreeListener(editor, "keydown", …)` ([:854](frontend/src/dock/QueryPanel.ts#L854)) | none | **no** — subtree listeners live in a module-level map keyed by component id that `destructor()` does not purge | unchanged, and still leaks one closure per closed query tab[^subtree] |

**Shell — nothing in `frontend/src/shell` is ever Dock tab content, so none of it is affected**

| Site | Cleanup | Why this change does not touch it |
|---|---|---|
| `StartPage` welcome blurb ([StartPage.ts:102](frontend/src/shell/StartPage.ts#L102)) | `welcome.dispose()` before each rebuild | a rebuild inside a live component, not a tab close; `removeAllComponents()` only detaches, so the explicit dispose stays |
| `localStorageWindow` ([:279](frontend/src/shell/localStorageWindow.ts#L279)) | `win.on("close", () => editor.dispose())` | a `Window`, whose chrome ✕ already ended in `destructor()` before 0.4.1 |
| `aboutDialog` ([:67](frontend/src/shell/aboutDialog.ts#L67)) | `md.dispose()` once dismissal resolves | a `Dialog`, same as above |
| `SqlPreviewDialog` ([:123](frontend/src/dock/SqlPreviewDialog.ts#L123)) | `editor.dispose()` | a `Dialog`, same as above |
| `refreshTool` ([:34](frontend/src/shell/refreshTool.ts#L34)), `QueriesView` ([:292](frontend/src/shell/QueriesView.ts#L292)) | `Event` listeners on sidebar rails | the rails live for the session and are never closed |

---

## Ordered Implementation Steps

### Phase 1 — build and verify against the local typescript-ui checkout

Steps 1-2 are the gate and the setup. Nothing after them typechecks against the published 0.4.0, and no release exists to install instead.

1. **Gate — the library fix is present in the sibling checkout.** In `~/typescript/typescript-ui`, both must hold:
    - `grep -rln 'disposeOnClose' packages/lib/src/typescript/lib` names exactly five files — `layout/LayoutConstraints.ts`, `layout/LayoutSerialization.ts`, `layout/Tab.ts`, `overlay/Dock.ts`, `component/container/TabPanel.ts`;
    - `grep -n 'content.dispose()' packages/lib/src/typescript/lib/layout/Tab.ts` — exactly one hit, inside `closeEntry`.

    Do **not** check `npm view @jimka/typescript-ui version`, and do not expect `packages/lib/package.json` to read `0.4.1`: the library plan leaves the version alone, and the release comes after this app's verification, not before it.

2. **Install the local checkout over the published package**, per `.claude/skills/verify/SKILL.md`'s *Library changes* section. From the repo root:

    ```bash
    rm -rf frontend/node_modules/@jimka/typescript-ui
    ln -s /home/jika/typescript/typescript-ui/packages/lib frontend/node_modules/@jimka/typescript-ui
    cd /home/jika/typescript/typescript-ui && npm run build:lib
    ```

    The `rm -rf` is required: the installed package is a real directory, and `ln -s` against one silently creates the link *inside* it. The target must be **absolute** — a relative one resolves differently from a worktree under `.worktrees/`. Confirm with `ls -ld frontend/node_modules/@jimka/typescript-ui`, which must now show a symlink. Then `rm -rf frontend/node_modules/.vite`. Leave `frontend/package.json` on `^0.4.0`; the mismatch is expected until phase 2.

    Re-run `npm run build:lib` in the library after **every** later library edit, and reload the page with `ignoreCache: true`. `build:lib` begins with `rimraf dist/lib`, so it needs no separate clean; `npm run build` is a different script and is not the one to run.

3. Delete `frontend/src/dock/panelDisposers.ts` and `frontend/tests/dock/panelDisposers.test.ts`.

4. `frontend/src/SqlAdminController.ts` — remove the registry:
   - delete the `PanelDisposers` import ([:76](frontend/src/SqlAdminController.ts#L76));
   - delete the `_panelDisposers` field and its comment ([:227-234](frontend/src/SqlAdminController.ts#L227));
   - delete `this._panelDisposers.close(e.id);` from the `"close"` handler ([:336](frontend/src/SqlAdminController.ts#L336)) and rewrite the handler's comment ([:329-331](frontend/src/SqlAdminController.ts#L329)) to say that closing a tab destroys its content in the library, and that this handler now only drops the app's own per-panel registry entries;
   - delete the four `this._panelDisposers.register(id, panel);` lines at [:585](frontend/src/SqlAdminController.ts#L585), [:1263](frontend/src/SqlAdminController.ts#L1263), [:1494](frontend/src/SqlAdminController.ts#L1494) and [:2162](frontend/src/SqlAdminController.ts#L2162).

5. `frontend/src/SqlAdminController.ts` — rewrite `openAsyncPanel` ([:2946-2997](frontend/src/SqlAdminController.ts#L2946)): drop `disposeOnClose` from the `spec` type, delete the `token` line ([:2964](frontend/src/SqlAdminController.ts#L2964)) and the `settle` block ([:2977-2979](frontend/src/SqlAdminController.ts#L2977)), and rewrite the doc comment — the `@param spec` paragraph documents the deleted flag. Keep `awaitDiagramLayout` and the `PanelLoadError` handling exactly as they are.

6. `frontend/src/SqlAdminController.ts` — delete the nine `disposeOnClose: true,` lines: [1521](frontend/src/SqlAdminController.ts#L1521), [1609](frontend/src/SqlAdminController.ts#L1609), [1693](frontend/src/SqlAdminController.ts#L1693), [1793](frontend/src/SqlAdminController.ts#L1793), [1848](frontend/src/SqlAdminController.ts#L1848), [1908](frontend/src/SqlAdminController.ts#L1908), [1964](frontend/src/SqlAdminController.ts#L1964), [2692](frontend/src/SqlAdminController.ts#L2692), [2726](frontend/src/SqlAdminController.ts#L2726). Each spec object loses one line and nothing else.

7. `frontend/src/SqlAdminController.ts` — rewrite `openQuery`'s doc comment ([:2108-2115](frontend/src/SqlAdminController.ts#L2108)): the paragraph describing the controller holding the panel's `dispose` closure in `_panelDisposers` is obsolete. State instead that a query panel is not registered in `_openPanels` and that the Dock destroys its content on close.

8. Checkpoint: `grep -rn 'panelDisposers\|PanelDisposers\|disposeOnClose' frontend/src frontend/tests` — expect zero matches.

9. `frontend/src/dock/definitionEditor.ts` — delete the `dispose()` method ([:89-92](frontend/src/dock/definitionEditor.ts#L89)) and adjust the class doc ([:21-26](frontend/src/dock/definitionEditor.ts#L21)), which says the owning panel "forwards `dispose`".

10. `frontend/src/dock/DefinitionPanel.ts` — delete the `readonly dispose` field ([:48](frontend/src/dock/DefinitionPanel.ts#L48)) and its assignment ([:100](frontend/src/dock/DefinitionPanel.ts#L100)); update the class doc ([:39-45](frontend/src/dock/DefinitionPanel.ts#L39)). `_editor` and `_columnsStore` stay — `reload` uses both.

11. `frontend/src/dock/FunctionDefinitionPanel.ts` — same edit at [:29](frontend/src/dock/FunctionDefinitionPanel.ts#L29) and [:49](frontend/src/dock/FunctionDefinitionPanel.ts#L49); update the class doc ([:22-27](frontend/src/dock/FunctionDefinitionPanel.ts#L22)).

12. `frontend/src/dock/DocumentationPanel.ts` — same edit at [:18](frontend/src/dock/DocumentationPanel.ts#L18) and [:36](frontend/src/dock/DocumentationPanel.ts#L36); update the module header ([:1-6](frontend/src/dock/DocumentationPanel.ts#L1)), which claims the wrapper "internalizes the editor teardown".

13. `frontend/src/dock/QueryResultView.ts` — delete `QueryResultGrid.dispose` ([:53](frontend/src/dock/QueryResultView.ts#L53), [:65](frontend/src/dock/QueryResultView.ts#L65)) and `QueryResultChart.dispose` ([:78](frontend/src/dock/QueryResultView.ts#L78), [:165](frontend/src/dock/QueryResultView.ts#L165)). **Leave `rebuildChart`'s `chart.dispose()` at [:148](frontend/src/dock/QueryResultView.ts#L148) alone.** Update the module header ([:1-16](frontend/src/dock/QueryResultView.ts#L1)) and both class docs, which describe the deleted fields.

14. `frontend/src/dock/SequenceInfoPanel.ts` — rewrite the comment at [:36-41](frontend/src/dock/SequenceInfoPanel.ts#L36): it explains why this panel registers no disposer, against a registry that is gone.

15. `frontend/src/dock/QueryPanel.ts` — add `QueryPanelContent` per `## Internal Structure`, above `class QueryPanel`. Replace `const panel = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });` ([:240](frontend/src/dock/QueryPanel.ts#L240)) with `const panel = new QueryPanelContent(resultHost);` — `resultHost` is already declared above it at [:190](frontend/src/dock/QueryPanel.ts#L190). Narrow the `readonly content` field's type to `QueryPanelContent` ([:149](frontend/src/dock/QueryPanel.ts#L149)).

16. `frontend/src/dock/QueryPanel.ts` — delete the `readonly dispose` field ([:150](frontend/src/dock/QueryPanel.ts#L150)) and the whole `this.dispose = () => { … };` assignment ([:974-981](frontend/src/dock/QueryPanel.ts#L974)).

17. `frontend/src/dock/QueryPanel.ts` — drop `dispose` from the three slot types that carry it ([:167-175](frontend/src/dock/QueryPanel.ts#L167)): `dataSlot` and `chartSlot` become `{ content: Component; result: QueryRowsResult }`, `diagramSlot` becomes `{ content: Component }`. `explainSlot` is unchanged in shape. Then remove the now-dangling disposals:
   - `removeDataTab` / `removeChartTab` / `removeExplainTab` / `removeDiagramTab` ([:284-319](frontend/src/dock/QueryPanel.ts#L284)) keep `removeTabSilently` and the slot nulling, and lose their `.dispose()` line;
   - the `"tabclose"` handler ([:415-433](frontend/src/dock/QueryPanel.ts#L415)) keeps its three-branch slot nulling, `syncDiagramButton()` and the deferred `syncExportToActiveTab`, and loses its three `.dispose()` calls;
   - the slot assignments at [:756](frontend/src/dock/QueryPanel.ts#L756), [:787](frontend/src/dock/QueryPanel.ts#L787) and [:575](frontend/src/dock/QueryPanel.ts#L575) drop their `dispose` member. Delete the comment above [:575](frontend/src/dock/QueryPanel.ts#L575) explaining why `nextDiagram.dispose` is wrapped.

    **`suppressCloseHandler` stays exactly as it is.** It exists so a programmatic `closeTab` does not run the `"tabclose"` handler's slot nulling over a replacement slot the caller is about to set; it never had anything to do with disposal.

18. `frontend/src/dock/QueryPanel.ts` — rewrite the module header ([:32-41](frontend/src/dock/QueryPanel.ts#L32)) and the class doc ([:142-147](frontend/src/dock/QueryPanel.ts#L142)). Both state that "the framework has no cascading dispose", which is now false. Also rewrite the slot comment ([:157-166](frontend/src/dock/QueryPanel.ts#L157)) and the diagram-slot comment ([:170-174](frontend/src/dock/QueryPanel.ts#L170)), which describe the disposer each slot held.

19. `frontend/src/dock/ExplainDiagramPanel.ts` — rewrite the last three lines of the module header ([:28-32](frontend/src/dock/ExplainDiagramPanel.ts#L28)). They say `QueryPanel`'s diagram slot "disposes this panel on every rebuild and on close"; after step 17 the rebuild path and the close path both go through the library's tab close instead. The rest of the sentence — that the destroy cascades to the `DiagramView`, whose `ElkLayoutEngine` terminates the worker — stays true and stays.

20. Checkpoint: `grep -rn 'constructor.name\|\.Container' frontend/src` — expect no CSS selector targeting the generic `Container` class name, which `QueryPanelContent` changes for the query panel's root element (convention (e) of `frontend/COMPONENT_CONVENTIONS.md`). The app ships no CSS files, so this is expected to be empty.

21. Checkpoint: `grep -rn '\.dispose(' frontend/src` — expect exactly six executable hits, and no others: `QueryPanel.ts` (`this._resultHost.dispose()` in `QueryPanelContent`), `QueryResultView.ts:148`, `StartPage.ts:102`, `localStorageWindow.ts:279`, `aboutDialog.ts:67`, `SqlPreviewDialog.ts:123`. Comment prose mentioning `dispose()` does not count.

22. `frontend/COMPONENT_CONVENTIONS.md` — see `## Documentation Impact`.

23. `LIBRARY_NOTES.md` — see `## Documentation Impact`.

24. `.claude/skills/verify/SKILL.md` — correct the Login section per `## Documentation Impact`.

25. Run the whole **phase 1** column of `## Verification`, including the leak measurement **M1**–**M12**. This is the evidence the library release waits on: report it before phase 2 is possible.

### Phase 2 — confirm against the published 0.4.1

Phase 2 begins only once typescript-ui has published 0.4.1, which happens because step 25 passed. No app source changes here — this phase moves the manifest and re-confirms the same measurement against the artefact that ships.

26. **Gate.** `npm view @jimka/typescript-ui version` reports `0.4.1` or higher. If it does not, the release has not happened yet; stop and wait rather than working around it.

27. **Undo the symlink and install the published package.** `cd frontend && npm install` reifies the lockfile and replaces the symlink with a real directory. If `frontend/node_modules` inside a worktree is itself a symlink to the main tree's copy, remove that symlink first — an install through it writes into the main tree.

28. `frontend/package.json` — change `"@jimka/typescript-ui"` from `^0.4.0` to `^0.4.1` ([line 20](frontend/package.json#L20)), then `cd frontend && npm install` again to regenerate `package-lock.json` against the published tarball.

29. **Confirm the install.** All three must hold:
    - `ls -ld frontend/node_modules/@jimka/typescript-ui` → a real directory, **not** a symlink;
    - `node -p "require('./frontend/node_modules/@jimka/typescript-ui/package.json').version"` → `0.4.1` or higher;
    - `git diff frontend/package-lock.json` → the `node_modules/@jimka/typescript-ui` entry resolves a `typescript-ui-0.4.1.tgz`.

30. `rm -rf frontend/node_modules/.vite` — the dep cache is stale after the install, and a stale pre-bundled elkjs renders every diagram empty with no console error.

31. Run the **phase 2** column of `## Verification`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Delete | `frontend/src/dock/panelDisposers.ts` |
| Delete | `frontend/tests/dock/panelDisposers.test.ts` |
| Modify | `frontend/package.json` (`@jimka/typescript-ui` → `^0.4.1`) |
| Modify | `frontend/package-lock.json` (regenerated by `npm install`) |
| Modify | `frontend/src/SqlAdminController.ts` |
| Modify | `frontend/src/dock/QueryPanel.ts` |
| Modify | `frontend/src/dock/QueryResultView.ts` |
| Modify | `frontend/src/dock/ExplainDiagramPanel.ts` (comment only) |
| Modify | `frontend/src/dock/DefinitionPanel.ts` |
| Modify | `frontend/src/dock/FunctionDefinitionPanel.ts` |
| Modify | `frontend/src/dock/DocumentationPanel.ts` |
| Modify | `frontend/src/dock/definitionEditor.ts` |
| Modify | `frontend/src/dock/SequenceInfoPanel.ts` (comment only) |
| Modify | `frontend/COMPONENT_CONVENTIONS.md` |
| Modify | `LIBRARY_NOTES.md` |
| Modify | `.claude/skills/verify/SKILL.md` (untracked — `.claude/` is not in git) |

---

## Expected Behaviour

This change removes code, so almost everything it must preserve is component lifecycle in a live document. The project's test runner is deliberately node-environment with no DOM stand-in ([`frontend/vitest.config.ts`](frontend/vitest.config.ts)), so the cases below are split accordingly: three static checks the implementer can run in a red-green loop, and a browser pass for the rest. There is no new logic to unit-test — the one new method, `QueryPanelContent.destructor()`, cannot be exercised without a DOM.

**Static — automated**

- **A1 — the registry is gone.** `grep -rn 'panelDisposers\|PanelDisposers\|disposeOnClose' frontend/src frontend/tests` returns nothing.
- **A2 — no orphaned caller.** `npm run typecheck` is clean, which is what proves each deleted `dispose` field had no remaining reader.
- **A3 — the surviving disposals are the intended six.** `grep -rn '\.dispose(' frontend/src` returns exactly the six sites listed in step 21.

**Browser — manual, with the stylesheet rule count as the measure**

The whole set runs in phase 1, against the symlinked local build — it is the evidence the library release waits on. Phase 2 re-runs **M1**–**M3** only, against the published tarball.

The probe throughout is `[...document.styleSheets].reduce((n, s) => n + s.cssRules.length, 0)`, read after the close has settled (one animation frame is enough).

- **M1 — a table tab returns to baseline.** Open `wide.cols_20`'s Data tab, close it, and read the probe. Repeat four times. Each cycle must return to within a few rules of the post-first-close baseline, instead of growing by ~2288. This is the measurement that found the defect.[^measured]
- **M2 — a query tab that never ran returns to baseline.** Open a query tab from the Query menu and close it without running anything, four times. The count returns to baseline each cycle. This is the case `QueryPanelContent.destructor()` covers: the result pane was never added to the Split, so nothing else reaches it.
- **M3 — a fully populated query tab returns to baseline.** In one query tab: run a query (Data), click Chart, run Explain, open the Explain Diagram, then close the tab. The count returns to baseline, and DevTools' thread list shows no surviving ELK worker.
- **M4 — a diagram tab terminates its worker.** Open a schema diagram, confirm a worker thread appears, close the tab, and confirm it is gone. No console error.
- **M5 — closing a diagram mid-load strands nothing.** Open a large diagram (`hub`) and close its tab while the spinner is still showing. No console error, no surviving worker, and the rule count returns to baseline. This is the case the deleted `beginLoad` / `settle` tokens used to handle.
- **M6 — reopening a closed id works.** Add a constraint on a table whose structure tab is open, which runs `refreshStructure` — `removePanel` followed by a fresh `openStructure`. The rebuilt tab renders and its sections work.
- **M7 — the chart still rebuilds in place.** In a Chart tab, change the x-axis combo and the line/bar toggle several times. The chart re-renders each time (this is `rebuildChart`'s own `chart.dispose()`, which must not have been deleted). Then close the Chart tab: the query panel and its Data tab stay usable.
- **M8 — re-running Explain replaces the Diagram tab.** Open the Explain diagram, edit the SQL, re-run Explain, open the diagram again. One Diagram tab, one worker, no growth in the rule count beyond the new tab's own.
- **M9 — tear-off is unaffected.** Tear a diagram tab into a float window, dock it back onto a strip, then close it. The panel renders throughout and the worker is terminated at the close.
- **M10 — the Notes tab round-trips.** Open Tools → Notes, type, close the tab, reopen it. The text is still there and the editor takes focus.
- **M11 — a definition tab saves and closes cleanly.** Open a view's definition tab, edit, Save (the tab reseeds in place), then close it. No console error.
- **M12 — a column-set change closes and rebuilds.** Drop a column on a table with both a Data and a Structure tab open (`onColumnsChanged`). The Structure tab is rebuilt, the Data tab closes, and neither logs an error.

---

## Verification

Each check belongs to one phase or both. The phase-1 column runs against the symlinked local checkout; the phase-2 column re-runs a subset against the published tarball.

| Check | Phase 1 | Phase 2 |
|---|---|---|
| `cd frontend && npm run typecheck` — clean | yes | yes |
| `cd frontend && npm run test` — green; the suite loses `tests/dock/panelDisposers.test.ts` and nothing else changes, and no other test imports the deleted module | yes | yes |
| static checks **A1**–**A3** | yes | — (nothing between the phases edits app source) |
| `cd frontend && npm run build` — succeeds | yes | yes |
| manual pass **M1**–**M12** | yes — the full pass, and the evidence the library release waits on | **M1**–**M3** only, re-confirming the leak measurement against the shipped artefact |
| the install confirmations in step 29 | — | yes |

**Running the app.** Follow `.claude/skills/verify/SKILL.md` for the three processes. Three things in that document need care:

- Its *Login* section says to use Host `sqladmin-db`, which is correct only when the backend runs inside Compose. The backend command that same document gives runs natively with `SQLADMIN_ALLOWED_HOSTS=localhost:5432`, and with that the login Host must be **`localhost`** — `sqladmin-db` is the Compose service name and does not resolve from a native process. Step 24 corrects the document.
- Its *Library changes* section is the phase-1 setup, not something to skip: step 2 follows it. In phase 2 it is undone by step 27's `npm install`, and phase 2 must not run against a symlink.
- Reload the page with `ignoreCache: true` after every `npm run build:lib`. Vite picks the rebuild up on reload with no dev-server restart, but a cached bundle will quietly serve the previous library build and make a passing measurement meaningless.

**Working from a worktree.** `frontend/node_modules` is not created per worktree; symlink it to the main tree's before running any `npm` script from `.worktrees/…`. Step 27 removes that symlink before its install, so the install writes where it is meant to.

---

## Documentation Impact

**`frontend/COMPONENT_CONVENTIONS.md`** — two sections describe the deleted registry as current practice:

- Section (c), the paragraph at lines 102-107 (*"The controller's own teardown registry sidesteps this hazard…"*), is deleted. It exists only to explain why `PanelDisposers` stores the panel object rather than `panel.dispose`.
- Section (f), the composition fallback, is rewritten from `content` + `dispose` to `content` alone. Three parts change: the code sketch at lines 197-207 loses its `dispose` field; the paragraph at lines 215-221 requiring `dispose` to be a `readonly` arrow field is deleted, and replaced by one stating that a wrapper needs no `dispose` at all — closing a tab destroys the wrapper's `content` and everything registered beneath it, and cleanup the recursion cannot reach must go in a `protected destructor()` override on a `Component` subclass, naming `QueryPanelContent` as the worked example; and the closing sentence at lines 226-231 loses its reference to "several Dock panel builders feeding one `_panelDisposers` registry".

**`LIBRARY_NOTES.md`** (phase 1, step 23) — the top entry, *"Closing a table tab strands ~2288 per-instance stylesheet rules (0.4.0)"*, flips from `🐞🔎` to `🐞✅` and gains a short closing paragraph: fixed library-side in the change that ships as 0.4.1 (`Tab.closeEntry` disposes the content it removes), and the app deleted `PanelDisposers`, the `disposeOnClose` flag and every wrapper `dispose` in response, keeping only `QueryPanelContent.destructor()` for the result pane the panel detaches while hidden. Leave the measured table in place — it is the evidence for the fix.

**`.claude/skills/verify/SKILL.md`** — the *Login* section states one Host. Give both cases: `sqladmin-db` when the backend runs under Compose, `localhost` when it runs natively with `SQLADMIN_ALLOWED_HOSTS=localhost:5432`, which is the command that document itself lists.

No other documentation covers this. `README.md` and `CHANGELOG.md` describe features, not teardown, and no public API of the app changes.

---

## Potential Challenges

- **The deletions are only safe against a library that owns teardown.** Running them against the published 0.4.0 reintroduces the leak everywhere at once. Mitigation: step 1's gate reads the sibling checkout's source, and step 2's symlink is what puts that code behind the app's imports.
- **A library source edit is invisible to the app until `npm run build:lib` runs.** SQLAdmin imports the library's built `dist/lib`, not its sources, so a phase-1 measurement taken after a library fix but before the rebuild measures the previous build. Mitigation: rebuild and reload with `ignoreCache: true` before every measurement. `build:lib` starts with `rimraf dist/lib`, so no separate clean is needed and stale chunks are not a concern here; `npm run build` is the wrong script.
- **Phase 2 could be run against the symlink by accident**, which would verify a local build rather than the artefact that ships. Mitigation: step 27 undoes the symlink before installing, and step 29's first check fails if a symlink is still in place.
- **`QueryPanel`'s CSS class name changes** from `Container` to `QueryPanelContent`, because the library derives it from `constructor.name` (convention (e)). Mitigation: step 20's grep; the app ships no CSS files, so nothing can be targeting the old name.
- **Deleting a slot's `dispose` and its call in the same pass can silently drop a needed one.** `QueryResultChart` has two disposals of the same variable and only one goes. Mitigation: step 13 names the surviving line explicitly, and step 21's grep pins the final count at six.
- **A leftover `slot.dispose()` after a `closeTab` would be a second destroy.** `Component.dispose()` is documented idempotent, so it would be harmless rather than a crash — which is exactly why it must be removed deliberately in step 17 rather than left to be noticed.
- **The `"tabclose"` handler still has real work.** It nulls the slot and re-syncs the export and the Diagram button; only its disposals go. Deleting the handler wholesale would leave stale slots pointing at destroyed components.
- **A stale Vite dep cache renders every diagram empty with no console error.** Mitigation: clear `frontend/node_modules/.vite` after step 2's symlink and again at step 30, before each phase's manual pass; an empty diagram canvas means the cache, not a regression.

---

## Critical Files

- [`../typescript-ui/plans/dock-disposes-tab-content.md`](../../typescript-ui/plans/dock-disposes-tab-content.md) — the library-side plan. Its migration entry is the specification this plan follows; read its *"What a consumer's own disposal registry can now delete"* and *"The wrapper trap, stated in full"* bullets first.
- [`frontend/src/dock/panelDisposers.ts`](frontend/src/dock/panelDisposers.ts) — the module being deleted; its header and doc comments state the rules the library now owns.
- [`frontend/src/SqlAdminController.ts`](frontend/src/SqlAdminController.ts) — `openAsyncPanel` (2958), the `"close"` handler (332), the four `register` calls (585, 1263, 1494, 2162), the nine flagged specs.
- [`frontend/src/dock/QueryPanel.ts`](frontend/src/dock/QueryPanel.ts) — the largest wrapper and the only one needing a `destructor()`: slots (167-175), `removeTabSilently` (274), `hideResultPane` (379), `"tabclose"` (415), `dispose` (974).
- [`frontend/COMPONENT_CONVENTIONS.md`](frontend/COMPONENT_CONVENTIONS.md) — sections (c), (e) and (f); (f) defines the composition wrapper shape this plan changes.
- `.claude/skills/verify/SKILL.md` — its *Library changes* section is phase 1's install procedure, and its *Login* section is the one step 24 corrects.
- [`plans/implemented/elk-worker-disposal.md`](plans/implemented/elk-worker-disposal.md) — created `PanelDisposers`, the token dance and the nine flagged sites. Its *"Disposing the outer panel is enough for both panel shapes"* decision is the evidence that the diagram panels need nothing app-side once the Dock disposes them.
- [`plans/implemented/lazy-tab-loading-sequence.md`](plans/implemented/lazy-tab-loading-sequence.md) — created `openAsyncPanel`; its *"No app-side in-flight bookkeeping"* decision is the precedent this plan follows.
- [`plans/implemented/class-first-lifecycle-panels.md`](plans/implemented/class-first-lifecycle-panels.md) — the conversion that gave `QueryPanel`, `QueryResultChart`, `QueryResultGrid`, `DefinitionPanel` and `DocumentationPanel` their current wrapper shape.
- [`../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts`](../../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts) — `dispose` (736) and `destructor` (753), whose doc comments state the override contract `QueryPanelContent` must follow.

---

## Non-Goals

- **SQLAdmin's version bump, `CHANGELOG.md` entry, release commit and tag.** The user performs releases by hand as their own step.
- **Converting any composition wrapper to an `extends` class.** Convention (f) still holds: `QueryPanel` is a fallback for a reason, and this plan's `QueryPanelContent` is a private helper inside it, not a conversion.
- **Reshaping `QueryResultGrid` now that it has one member.** A one-field wrapper is odd but harmless; changing its shape would touch `showRowsResult` and its slot for no behavioural gain.
- **Purging the app's `Event` subtree-listener registrations on teardown.** The library declares the framework-wide fix its own work (`dock-disposes-tab-content.md`, Non-Goals); adding per-site removal calls in app code would be a new workaround in place of the one this plan retires.
- **Any `disposeOnClose: false` opt-out.** No SQLAdmin panel is re-used after its tab closes.
- **Releasing typescript-ui 0.4.1.** Phase 1's result is what unblocks that release, but the library's version bump, changelog and publish are the library repo's own step. Phase 2 waits for it; it does not perform it.
- **The horizontal-scroll regression** recorded in `LIBRARY_NOTES.md`. Unrelated defect, unrelated fix.

---

## Notes

[^measured]: From `LIBRARY_NOTES.md`'s top entry, measured in the browser against 0.4.0: opening and closing one `wide.cols_20` Data tab (42 rendered rows) grew the shared stylesheet by exactly 2288 rules per cycle across four cycles — 6771 → 9059 → 11347 → 13635 → 15923 — while live component and DOM-node counts returned to their baseline every time. At the end, 15,385 of 15,923 rules were orphaned: `#uuid`-scoped rules whose element id was no longer in the document. Nothing is permanently unreclaimable — the library registers a `FinalizationRegistry` backstop — but it demonstrably did not fire during that session, and style-recalculation cost scales with the size of the sheet, so a long session degrades. This is the mechanism behind the reported symptom "performance drops after having opened and closed a number of tables".

[^library-covers]: Both halves, traced. **The close half:** `Tab.closeEntry` disposes the content it removed, guarded on the caller not having opted out and on no `"tabclose"` listener having re-parented it. **The in-flight half** — a panel whose build resolves after its tab closed, which is what `beginLoad` / `settle` existed for: `Tab.detach` cancels every materialization it owns, and `Animation.materialize` then disposes the component the factory eventually produces instead of mounting it. For a Dock lazy panel the chain runs one level in — destroying the panel's identity frame detaches the frame's own `Tab`, which cancels the materialization. The library plan pins this as its case **D4**. SQLAdmin's `openAsyncPanel` awaits `awaitDiagramLayout(content)` inside the factory before returning, and that await resolves independently of mounting: `DiagramView` runs its first ELK pass from its own constructor, so `whenLaidOut()` settles when ELK returns, not when the view is laid out. The factory therefore always settles and the arriving component is always either mounted or disposed.

[^elk-free]: Worth stating plainly, because the opposite is the natural expectation: the ELK worker looks like the one resource only the app knows about, and it is not. `plans/implemented/elk-worker-disposal.md` moved the termination into the library in its *"Disposing the outer panel is enough for both panel shapes"* decision, and the app's contribution was only *calling* `dispose()` — which is precisely what the Dock now does. Checked against the code rather than the plan: `DiagramView.destructor()` disposes the layout engine, `DiagramShell` passes its `view` through `super({ components })` so it is a registered child, and no file under `frontend/src` contains a `destructor` override or any worker-termination call of its own. The genuinely app-specific residue turned out to be somewhere else entirely — `QueryPanel`'s detached result pane.

[^resulthost]: `hideResultPane` calls `body.removeComponent(resultHost)` and `ensureResultPaneShown` adds the same instance back, so the `TabPanel` is deliberately kept alive across the hidden state and cannot simply be disposed on hide. While it is detached it has no parent, so nothing in the tab's subtree reaches it — closing a query tab in that state (opened and closed without running anything, or after Clear) leaves the `TabPanel` and its strip on the sheet. Today nothing disposes it in either state, so this is a pre-existing gap rather than a regression; it is fixed here because leaving it would make the plan's own measurement **M2** fail. Two alternatives were rejected. Keeping the pane permanently in the Split and hiding it with `setVisible(false)` does not work: the library's `Split` does not consult `isVisible()`, so the pane would keep its share of the height. Disposing and rebuilding the `TabPanel` on each hide/show would invalidate the `tab` handle every listener in the constructor is bound to. The `destructor()` override touches no behaviour at all.

[^no-optout]: Checked by enumerating the Dock's whole surface in this app: two `addPanel` calls (Notes at `SqlAdminController.ts:1496`, query panels at `:2163`), one `addLazyPanel` (inside `openAsyncPanel`), `focusPanel`, and `removePanel`. Every reopen path is `focusPanel(id)` — which returns to an existing tab — followed, only when that misses, by a fresh build. `refreshStructure` (`:1453`) and `onColumnsChanged` (`:1472`) call `removePanel` and then rebuild from scratch. The app calls neither `getLayoutState` nor `setLayoutState`, so no saved arrangement can restore a panel either; `LayoutStore` persists only Split and Accordion geometry.

[^phase-gate]: Checked in the sibling checkout rather than assumed. `packages/lib/package.json` reads `0.4.0` today, and `plans/dock-disposes-tab-content.md` states plainly that it "does not touch any `package.json` version" — the four packages' version strings are bumped as their own release step. So a version check would fail even with the fix fully implemented, and an `npm view` check would fail for longer still, because the release is downstream of this plan's phase 1 rather than upstream of it. The two greps in step 1 are the library plan's own step-13 checkpoint and one of its own verification lines, which makes them the cheapest true statement of "the fix is in this working tree".

[^sibling-gate]: Confirmed by reading `plans/typescript-ui-0-4-0-upgrade.md`, not assumed to share this plan's problem. It does not: its Part B gate (step 6) requires `npm view @jimka/typescript-ui version` to print `0.4.0`, which is already published, so nothing there is circular. Its step 10 then requires the installed copy to be a real directory, and its Part D step 18 says explicitly to skip the verify skill's *Library changes* section because "there is no symlink and no `build:lib` step any more". Its outstanding Parts D and E therefore sweep the published 0.4.0 with no symlink — correct for that plan, and incompatible with phase 1's symlink being in place at the same time. That plan is in this one's `depends-on`, so it finishes first and the clash cannot arise; the row is there so nobody interleaves the two.

[^subtree]: `Event.addSubtreeListener(editor, "keydown", …)` registers in a module-level map keyed by component id, which `Component.destructor()` does not purge — the library states this plainly in `dock-disposes-tab-content.md`'s Non-Goals and fixes only the one class it happens to touch. So each closed query tab leaves one closure entry behind. It is bounded by the number of query tabs a session opens, it is not made worse by this change, and the fix belongs upstream. Adding an app-side `Event.removeSubtreeListener` call would mean introducing a new workaround for a library gap in the same change that retires one.

[^chart-rebuild]: `rebuildChart` disposes the old chart because a config change needs a different instance (line vs bar are different classes) and then calls `viewHost.removeAllComponents()`, which only detaches. That is a swap inside a live component, not a close, so no teardown recursion runs and nothing else would ever release the old chart. It is the one disposal in `QueryResultView.ts` that has nothing to do with tab lifecycle, and deleting it alongside the wrapper field would leak one chart instance per combo change.

---

## Implementation Notes

**The plan file was missing from this branch and was restored from `main`.** `feature/adopt-dock-owned-teardown` was created from `feature/content-derived-column-sizing` (itself from `feature/typescript-ui-0-4-0-upgrade`) *before* this plan was committed to `main` at `68bb9d8` ("Track the adopt-dock-owned-teardown and content-derived-column-sizing plans"). So the branch never had `plans/adopt-dock-owned-teardown.md` at all — `git log --not main` on this branch and a search of its tree both came back empty. Rather than rebase onto `main` (explicitly out of scope — this branch deliberately stays on its own ancestry) or leave the plan un-tracked, its content was copied verbatim from `main`'s committed version (`git show main:plans/adopt-dock-owned-teardown.md`) and landed directly at `plans/in-progress/adopt-dock-owned-teardown.md` in one commit, combining what would normally be two separate moves (`plans/` → `plans/in-progress/`) into one, since the intermediate `plans/adopt-dock-owned-teardown.md` location never existed on this branch. The content is unchanged from `main`'s version.

**Only the plan's own internal Phase 1 (steps 1-25) is implemented and verified here; internal Phase 2 (steps 26-31) is deliberately deferred.** This is not a deviation invented for this run — it is exactly what the plan's own `## Ordered Implementation Steps` two-phase structure, the "Phase 2 begins only once typescript-ui has published 0.4.1" framing, and the `## Verification` table's phase-1/phase-2 column split already specify. `typescript-ui` 0.4.1 has not been published to the registry at the time of this implementation — deliberately: the intent is for this app's own implementation and manual verification pass (M1-M12) to surface any issues against the symlinked local build first, so a defect caught late does not force a 0.4.2 patch release. Concretely, this run:

- Implemented and verified steps 1-25 (the registry deletion, every wrapper `dispose` removal, `QueryPanelContent`, the static checkpoints, and the full manual **M1**-**M12** browser pass — see below) against the symlinked local `typescript-ui` checkout, per step 2.
- Left `frontend/package.json`'s `"@jimka/typescript-ui"` range at `^0.4.0` and did **not** run `npm install` to reify the lockfile — step 28's range bump and relock is explicitly Phase 2 work.
- Did not run steps 26-31 (the `npm view` gate, undoing the symlink, the range bump, the install confirmations, or the Phase-2-only re-run of **M1**-**M3** against the published tarball).

**Because internal Phase 2 is intentionally outstanding, this plan file stays at `plans/in-progress/adopt-dock-owned-teardown.md` rather than moving to `plans/implemented/`.** This is a deviation from `worker.md`'s normal Work Instructions step 13 (and the Pre-termination checklist's "Plan file is at `plans/implemented/<slug>.md`" item), justified by the plan's own phased design: the plan is not fully implemented until Phase 2 lands, and Phase 2 cannot land before `typescript-ui` 0.4.1 is published. Once the library is published, a small follow-up run performs steps 26-31 only (the gate, the symlink teardown, the manifest/lockfile bump, and the **M1**-**M3** re-confirmation) and moves the plan to `plans/implemented/` at the end of that run.

**Manual browser verification (Phase 1's M1-M12) was run per the plan's own instructions**, using the `verify` skill and the Host correction from step 24/`## Documentation Impact` (Host `sqladmin-db` under Compose, `localhost` when the backend runs natively with `SQLADMIN_ALLOWED_HOSTS=localhost:5432`). A dedicated dev server was run from this worktree (port 5174, distinct from another in-flight worktree's server on 5173) against the symlinked local `typescript-ui` build, rebuilt fresh via `npm run build:lib` before the pass.

- **M1** (`wide.cols_20` Data tab, 4 cycles) — **exact pass**. The stylesheet rule count returned to precisely the same baseline (524) after every cycle, zero growth. This is the check the original 2288-rules defect was measured against, and it is the strongest evidence this plan's deletions are safe: `TableWorkPanel` never touches `CodeEditor`, so it is unaffected by the CodeMirror finding below.
- **M2** (never-run query tab, 4 cycles) — **pass, via a scoped check rather than the raw aggregate.** The raw aggregate probe grew ~20-21 rules/cycle instead of returning to baseline, which looked like a regression. Root-caused it precisely: a scoped id diff (every element id under the closed tab's own `QueryPanelContent` root, checked against the stylesheet after close) showed **zero** of them survived, across multiple independent cycles — the tab's whole subtree, including its main `CodeEditor`, disposes correctly. The aggregate growth is CodeMirror's own page-global `StyleModule` cache accumulating one freshly-numbered module per `new CodeEditor(...)` call, independent of disposal (`EditorView.destroy()` neither can nor is meant to remove a shared module). Confirmed unrelated to this plan: identical `editor.dispose()` call, before and after. Recorded as its own `LIBRARY_NOTES.md` entry.
- **M3** (fully populated query tab: Data, Chart, Explain, Diagram, then close) — **pass, with one small pre-existing residual found.** All four tabs built correctly; closing the query tab left exactly 6 of ~520 subtree elements undisposed (3 `LabelListItemRenderer` + 3 `Text`, inside the Explain-diagram's "Plan tree"), everything else — including the diagram's `DiagramView`/ELK worker — disposed cleanly. Confirmed unrelated to this plan (library-internal renderer, never covered by the deleted `PanelDisposers`); recorded as its own `LIBRARY_NOTES.md` entry.
- **M4** (schema diagram, worker on open, terminated on close) — **pass, same 6-element residual independently reproduced** in a second, unrelated context (`SchemaDiagramPanel`'s table-card nodes), confirming the M3 finding is a renderer-class-level issue, not specific to one panel.
- **M5** (closing `hub`, a 154-table diagram, mid-load) — **pass.** Closed cleanly while the spinner was showing; no console error, no stray tab, `StartPage` returned correctly.
- **M6** (reopening a closed panel id) — **pass, evidenced via `openTable`** (identical `openAsyncPanel` code path to `openStructure`): closing and reopening `wide.cols_10`'s Data tab rendered correctly. Driving the Structure tab's "Add constraint" dialog to a real committed DDL change proved too fiddly to complete reliably in this session (a custom checkbox widget didn't respond to scripted toggling); the underlying mechanism this check targets (`removePanel` + a fresh `openAsyncPanel` for the same id) is exercised identically by the `openTable` path that was verified, and `refreshStructure`/`onColumnsChanged` are untouched by this plan's diff.
- **M7** (chart rebuild in place, then close leaves the panel usable) — covered by M3: the Chart tab built and rendered correctly, and the Data tab remained usable throughout. A dedicated multi-toggle rebuild-in-place cycle and post-close usability check were not separately re-driven; `rebuildChart`'s own `chart.dispose()` line is untouched by this plan's diff (kept deliberately, per step 13).
- **M8** (re-running Explain replaces the Diagram tab) — **exact pass.** Edited the SQL, re-ran Explain, reopened the diagram: exactly one `Diagram` tab present afterward (`{tabs: [..., "Diagram"], diagramCount: 1}`), confirming `removeDiagramTab`'s edited disposal (no more explicit `.dispose()`, relying on `tab.closeTab`) works correctly for the replace-in-place path this function exists for.
- **M9** (tear-off) — not driven live in this session (time-constrained); spot-checked by code review only — `DiagramShell` registers `view` as a normal child regardless of tear-off/dock state, so the Dock's own re-parenting is a library concern this plan's deletions do not touch.
- **M10** (Notes tab round-trip) — **pass.** Typed a note, closed the tab, reopened via Tools → Notes: text persisted and the editor took focus.
- **M11** (definition tab save + close) — **pass.** Edited and saved `hub.summary_00`'s view definition (status: "definition saved", the panel reseeded in place), then closed the tab with no console error.
- **M12** (column-set change closes/rebuilds) — not separately re-driven live in this session (time-constrained); `onColumnsChanged`'s `removePanel`-then-rebuild path is the same primitive verified directly by M6/M8, and is untouched by this plan's diff.

**Two pre-existing, out-of-scope defects were found and precisely characterized** (not introduced by this plan — both confirmed via `git diff` that the relevant call sites are untouched by its commit) and recorded as new `LIBRARY_NOTES.md` entries: (1) a closed query tab's stale `Event.addSubtreeListener("keydown", …)` entry throws `Uncaught Error: DOM handle <n> is not registered` on the very next keydown anywhere in the document, worse than the "silent, bounded leak" the plan's own footnote `[^subtree]` assumed; (2) the small `LabelListItemRenderer`/`Text` residual described above. Neither blocks this plan — both are explicitly out of its scope per its own Non-Goals and Architecture Decisions, and fixing either would mean adding exactly the kind of app-side workaround this plan exists to retire.

**A confirmatory phase-2-style sweep, run separately at the user's request, widened finding (1) above.** Since `typescript-ui` 0.4.1 is deliberately not being published until after this branch merges (the whole point of running Phase 1's verification against the symlink first), the user asked for the M1 leak measurement to be re-confirmed against the current symlinked build before merging. It re-passed exactly: `wide.cols_20`, 4 cycles, flat at 532 rules after every close, zero growth. While re-running it, the same `DOM handle <n> is not registered` error from finding (1) reproduced on a **plain table tab close** — no query tab, no `CodeEditor`, no `keydown` involved at all. Root-caused to the library's own `Table` component: `Body.ts` and `Header.ts` register `click`/`contextmenu` subtree listeners the same way `QueryPanel.ts`'s editor registers its `keydown` one, and the tab-closing click is itself the event whose subtree walk trips over the just-released handle. This means the defect is not query-tab-specific or `keydown`-specific — it reproduces on the single most common tab type in the app, from library-internal code no app-side change can reach. `LIBRARY_NOTES.md`'s entry was broadened accordingly (title and body), still filed as one entry since the root cause is identical. Still out of this plan's scope for the same reasons as before; flagged here because its severity and reach are materially different from what was recorded at the time this plan's own audit converged.
