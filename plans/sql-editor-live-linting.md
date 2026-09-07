---
touches-shared: [frontend/src/dock/QueryPanel.ts, frontend/src/dock/definitionEditor.ts, frontend/src/dock/DefinitionPanel.ts]
---

# Live SQL Linting in the Query and Definition Editors — Implementation Plan

## Overview

`CodeEditor` gained a `lint` option in the unreleased `@jimka/typescript-ui` build this app currently symlinks.[^unreleased-dependency] With `lint: true`, the editor shows **diagnostics** — a wavy red underline on the offending text plus a marker in a gutter beside the line — for places where the language's grammar failed to parse. The option defaults to `false`, and no SQL editor in this app passes it today.

This plan turns `lint: true` on for two of the app's six SQL surfaces: the main query editor at [frontend/src/dock/QueryPanel.ts:240](frontend/src/dock/QueryPanel.ts#L240), and the shared definition editor at [frontend/src/dock/definitionEditor.ts:62](frontend/src/dock/definitionEditor.ts#L62) — the latter only for its `DefinitionPanel` owner, which needs a new constructor option to distinguish it from its `FunctionDefinitionPanel` sibling. The other four surfaces stay off, each for a stated reason (see the decision table below).

The code change is two call-site edits plus a one-field options bag on `DefinitionEditor` — no styling work and no new dependency. The library already themes the squiggle and the diagnostic tooltip from `--ts-ui-*` tokens this app inherits.[^lint-mechanics]

---

## Architecture Decisions

### Lint goes on the surfaces where a person writes SQL, not on the ones that display it

The library's `"sql"` language parses with a generic SQL grammar rather than a PostgreSQL one. So a SQL editor gets `lint: true` when the user can edit the text **and** the app is not itself seeding that editor with text that generic grammar mis-parses. Every call site, and its verdict:

| Surface | Mode | What the text is | Lint |
|---|---|---|---|
| [QueryPanel.ts:240](frontend/src/dock/QueryPanel.ts#L240) — main query editor | editable | whatever the user types | **on** |
| [definitionEditor.ts:62](frontend/src/dock/definitionEditor.ts#L62) via [DefinitionPanel.ts:69](frontend/src/dock/DefinitionPanel.ts#L69) | editable | a view/matview `SELECT` body | **on** |
| [definitionEditor.ts:62](frontend/src/dock/definitionEditor.ts#L62) via [FunctionDefinitionPanel.ts:47](frontend/src/dock/FunctionDefinitionPanel.ts#L47) | editable | `pg_get_functiondef` — always dollar-quoted | off |
| [SqlPreviewDialog.ts:120](frontend/src/dock/SqlPreviewDialog.ts#L120) — DDL preview | editable | app-generated DDL; the CREATE FUNCTION flow is dollar-quoted | off |
| [QueryPanel.ts:1142](frontend/src/dock/QueryPanel.ts#L1142) — Explain plan viewer | read-only | an EXPLAIN plan, which is not SQL | off |
| [IndexInfoPanel.ts:91](frontend/src/dock/IndexInfoPanel.ts#L91) — index definition | read-only | `pg_get_indexdef`, server-generated | off |

Two facts drive the "off" rows. A **dollar-quoted** body — PostgreSQL's `$$ … $$` / `$tag$ … $tag$` string form, which every routine definition uses — is flagged as an error by that grammar, so the function definition tab and the CREATE FUNCTION preview would both show a permanent false error on text the user never typed.[^dialect-gap] An EXPLAIN plan is not SQL at all and parses as errors, and neither read-only viewer lets the user act on a diagnostic anyway.[^measured-diagnostics]

[TypeInfoPanel.ts](frontend/src/dock/TypeInfoPanel.ts) has no `CodeEditor` — its centre pane is a `Table`; the file only mentions `CodeEditor` in a comment comparing itself to `IndexInfoPanel`. Nothing to decide there.

### `DefinitionEditor` gains a `lint` option so its two owners can differ

`DefinitionEditor` is shared by `DefinitionPanel` and `FunctionDefinitionPanel`, which land on opposite sides of the table above. Its constructor takes a fourth parameter, an options bag with one `lint` field defaulting to `false`; `DefinitionPanel` passes `{ lint: true }` and `FunctionDefinitionPanel` is left unchanged.[^definition-editor-option]

### Record the generic-SQL grammar gap in `LIBRARY_NOTES.md`, don't work around it in the app

The library's built-in `"sql"` language parses with generic SQL, so three PostgreSQL constructs — `@>`, `<@`, and dollar quoting — are reported as errors even though they are correct.[^dialect-gap] This plan ships against that grammar and logs the gap as a library friction in `LIBRARY_NOTES.md`, the file this app already keeps for exactly that purpose. It does **not** register a PostgreSQL grammar inside sqladmin.[^no-app-grammar]

### Verify under the symlink override; the version pin moves at release time

The published `@jimka/typescript-ui` 0.8.0 has no `lint` option, and `frontend/package.json` pins `^0.8.0`. Implementation and manual verification run against the symlinked local library build, per the `verify` skill. Bumping the pin belongs to the release step in [release-steps.md](release-steps.md), not to this plan.[^unreleased-dependency] This mirrors [plans/implemented/align-with-library-post-0.4.1.md](plans/implemented/align-with-library-post-0.4.1.md), which adopted `CodeEditor.autoHeightMaxRows` the same way — against the symlinked build, with the pin left alone.

---

## Public API

No exported library API changes. One app-internal signature change, with two call sites:

```ts
// frontend/src/dock/definitionEditor.ts
export interface DefinitionEditorOptions {
    lint?: boolean;          // default false
}

export class DefinitionEditor {
    constructor(
        definition: string,
        onSave: (text: string) => void | Promise<void>,
        onRefresh: () => void,
        options?: DefinitionEditorOptions,
    );
}
```

The `CodeEditor` surface used is one option, already present in the symlinked build's `CodeEditorOptions`:

```ts
new CodeEditor(value?: string, options?: { language?: string; readOnly?: boolean; lint?: boolean; ... })
```

---

## Ordered Implementation Steps

1. **`frontend/src/dock/definitionEditor.ts`** — above the class, add the options interface with a JSDoc block:

   ```ts
   /** Options for {@link DefinitionEditor}. */
   export interface DefinitionEditorOptions {
       /**
        * Whether the editor shows live parser-error diagnostics. Default
        * `false`: FunctionDefinitionPanel's `pg_get_functiondef` text is
        * dollar-quoted, which the library's generic-SQL grammar reports as an
        * error, so only DefinitionPanel opts in (see
        * plans/sql-editor-live-linting.md's decision table).
        */
       lint?: boolean;
   }
   ```

2. **`frontend/src/dock/definitionEditor.ts:57`** — add a fourth constructor parameter `options: DefinitionEditorOptions = {}`, and add a matching `@param options` line to the constructor's existing JSDoc.

3. **`frontend/src/dock/definitionEditor.ts:62`** — change the editor construction to `this.editor = new CodeEditor(definition, { language: "sql", lint: options.lint ?? false });`.

4. **`frontend/src/dock/DefinitionPanel.ts:69`** — change to `const editor = new DefinitionEditor(definition, onSave, onRefresh, { lint: true });`.

5. **`frontend/src/dock/FunctionDefinitionPanel.ts:47`** — leave unchanged. Add one comment line above it stating that the omitted options bag leaves lint off because `pg_get_functiondef` text is dollar-quoted.

6. **`frontend/src/dock/QueryPanel.ts:240`** — change to `const editor = new CodeEditor(initialSql, { language: "sql", lint: true });`, preceded by a short comment:

   ```ts
   // lint: live parser-error diagnostics — a wavy underline plus a gutter
   // mark, refreshed 750ms after the last edit. On here because this is the
   // app's one free-form SQL authoring surface; the read-only viewers and the
   // dollar-quoted routine surfaces stay off (see
   // plans/sql-editor-live-linting.md's decision table).
   ```

7. **`LIBRARY_NOTES.md`** — add a new entry directly under the `---` on line 9 (the file is newest-first), under this heading:

   ```markdown
   ## ✂️🔎 `CodeEditor`'s built-in `"sql"` language lints against generic SQL, not PostgreSQL (0.8.0+unreleased, symlinked)
   ```

   Record the three constructs the generic grammar reports as errors although PostgreSQL accepts them — `@>` (`SELECT * FROM t WHERE c @> '{}'::jsonb;`), `<@`, and dollar quoting (`… AS $$ BEGIN RETURN 1; END; $$ …`) — that the same statements parse clean under the package's `PostgreSQL` dialect, and that this gap is why the function definition tab and the SQL preview dialog keep lint off.

8. **Checkpoints.**
   - `grep -rn "lint: true" frontend/src` → exactly two matches: `dock/QueryPanel.ts` and `dock/DefinitionPanel.ts`.
   - `grep -rn "lint" frontend/src/dock/SqlPreviewDialog.ts frontend/src/dock/IndexInfoPanel.ts frontend/src/shell/localStorageWindow.ts` → zero matches.
   - `cd frontend && npm run typecheck` → clean. A `'lint' does not exist in type 'CodeEditorOptions'` error here means the symlink override is missing or the library's `dist/lib` is stale, not a plan error (see `## Potential Challenges`).

---

## Files to Create / Modify / Delete

| Action | File |
| --- | --- |
| Modify | [frontend/src/dock/definitionEditor.ts](frontend/src/dock/definitionEditor.ts) |
| Modify | [frontend/src/dock/DefinitionPanel.ts](frontend/src/dock/DefinitionPanel.ts) |
| Modify | [frontend/src/dock/FunctionDefinitionPanel.ts](frontend/src/dock/FunctionDefinitionPanel.ts) (comment only) |
| Modify | [frontend/src/dock/QueryPanel.ts](frontend/src/dock/QueryPanel.ts) |
| Modify | [LIBRARY_NOTES.md](LIBRARY_NOTES.md) |

---

## Expected Behaviour

Every case below is **manual-verify only**. `CodeEditor` mounts nothing under the framework's offline test seam, so no unit test in this app can observe a diagnostic; `grep -rln "DefinitionEditor\|QueryPanel\|SqlPreviewDialog\|IndexInfoPanel" frontend/tests` finds no test file today either. Drive the live app per the `verify` skill.

Diagnostics appear roughly 750ms after typing stops, not on each keystroke.

### Query editor (lint on)

| Typed into a New Query tab | Expected |
|---|---|
| `SELECT a, b FROM t WHERE a = 1;` | no diagnostic; the editor now shows one extra, empty gutter column beside the line numbers |
| `SELECT count(* FROM t;` | a mark at the end of the text, tooltip `Missing input` |
| `SELECT a) FROM t;` | a wavy underline under `)`, tooltip `Unexpected input` |
| `select from where` | **no** diagnostic — this is a grammar-level check, not a SQL validator |
| `SELECT * FROM t WHERE c @> '{}'::jsonb;` | one **false** `Unexpected input` under `>` — a known limitation, not a defect to fix here |

Also confirm: the existing editor accelerators (`Ctrl+Enter` run, `Ctrl+S` save, `Ctrl/Cmd+E` explain, `Alt+C` clear, `Ctrl+↑/↓` history) all still fire, and no new key does anything — enabling lint installs no key bindings.[^lint-mechanics]

### View definition tab (lint on)

- Opening a view's definition shows the `SELECT` body with no diagnostics.
- Deleting a closing parenthesis produces a diagnostic within about a second; restoring it clears the diagnostic.
- A view whose body uses `@>` shows the same false positive as the query editor above.

### Every other SQL surface (lint off)

- **Function definition tab** — the `CREATE OR REPLACE FUNCTION … AS $function$ … $function$` text shows **no** diagnostics and no extra gutter column, despite the dollar quoting.
- **Explain tab** — a plan from `Explain` or `Explain Analyze` shows no diagnostics and no extra gutter column.
- **Index info tab** — the index definition shows no diagnostics and no extra gutter column.
- **SQL preview dialog** — every DDL flow, Create function included, shows no diagnostics; the dialog's auto-height and re-fit behaviour are unchanged.
- **The localStorage window's JSON viewer** — unchanged; it is a different language and out of scope.

---

## Verification

1. `cd frontend && npm run typecheck` — clean, against the symlinked library build.
2. `cd frontend && npm test` — the existing suite stays green; nothing in it constructs these panels.
3. The checkpoints listed in step 8.
4. `ls -ld frontend/node_modules/@jimka/typescript-ui` shows a **symlink** before any manual run — otherwise the app is running the published 0.8.0, which has no `lint` at all and would show nothing.
5. Manual verification of every `## Expected Behaviour` case, using the `verify` skill. Screens to exercise: a New Query dock tab, a view's definition tab, a function's definition tab, an Explain tab, an index info tab, and any Create/Alter DDL preview dialog.

---

## Documentation Impact

- **`LIBRARY_NOTES.md`** — a new entry, per step 7. This file is the app's log of library bugs and frictions, and the generic-SQL grammar gap is one.
- **`CHANGELOG.md`** — **not edited by this plan.** This repo writes the changelog at release time, as its own step ([release-steps.md](release-steps.md), "Changelog"), and the git history shows changelog edits as standalone commits rather than part of feature work. The change is user-facing, so the next release's `### Added` section should carry a line about live syntax diagnostics in the query and view-definition editors.
- **`README.md`** — no change. Its SQL workspace bullet ([README.md:53](README.md#L53)) lists what the workspace does — run queries, `EXPLAIN`, save — and does not enumerate editor-level assistance today; leave it that way.
- **`THIRD-PARTY-NOTICES.md`** — no change; `@codemirror/lint` and `@codemirror/lang-sql` are already listed, and this plan adds no dependency.
- **No app styling or theming.** The library styles the squiggle and the diagnostic tooltip from `--ts-ui-validation-error-border` and `--ts-ui-tooltip-bg`, which this app inherits rather than overrides.[^lint-mechanics]

---

## Potential Challenges

- **Typecheck fails with `'lint' does not exist in type 'CodeEditorOptions'`.** The symlink override is missing, or the library's `dist/lib` predates the option. Re-link per the `verify` skill and run `npm run build:lib` (**not** `npm run build`) in `~/typescript/typescript-ui`.
- **The release image build will fail on this branch.** The Dockerfile runs `npm ci`, which installs the published 0.8.0 — no `lint` option, so `npm run build`'s typecheck fails. Do not cut a release until a library version carrying `lint` is published and the pin plus lockfile are bumped per [release-steps.md](release-steps.md).
- **The extra gutter column shifts the editor's text sideways** by about 1.4em on the two linted editors, whether or not any diagnostic exists.[^lint-mechanics] Expected, not a defect.
- **False positives on PostgreSQL-only syntax** will be reported as bugs by anyone using `@>` or `<@` in the query editor. The `LIBRARY_NOTES.md` entry is where that is tracked; do not paper over it in the app.

---

## Critical Files

- [frontend/src/dock/QueryPanel.ts:240](frontend/src/dock/QueryPanel.ts#L240) and [:1142](frontend/src/dock/QueryPanel.ts#L1142) — the edited main editor and the untouched Explain viewer.
- [frontend/src/dock/definitionEditor.ts](frontend/src/dock/definitionEditor.ts) — the shared editor gaining the option.
- [frontend/src/dock/DefinitionPanel.ts:69](frontend/src/dock/DefinitionPanel.ts#L69) and [frontend/src/dock/FunctionDefinitionPanel.ts:47](frontend/src/dock/FunctionDefinitionPanel.ts#L47) — the two owners that now differ.
- [plans/implemented/align-with-library-post-0.4.1.md](plans/implemented/align-with-library-post-0.4.1.md) — the precedent this plan follows: adopt a new `CodeEditor` option against the symlinked build, decide per call site, leave the pin alone.
- [plans/implemented/codeeditor-sql-adoption.md](plans/implemented/codeeditor-sql-adoption.md) — the original `CodeEditor` adoption; establishes that these editors are live-only and manual-verify only.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/editor/CodeEditor.ts` — `lint` option (line 126), `refreshLint` (line 696), the compartment seeding in `mount` (line 1752).
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/editor/languages.ts:69-79` — the `"sql"` `LanguageDefinition`: the bare `sql()` call that leaves the dialect at generic `StandardSQL`, and the `loadLintSource` entry that supplies the diagnostics.
- `/home/jika/typescript/typescript-ui/packages/lib/src/typescript/lib/component/editor/syntaxDiagnostics.ts` — `collectSyntaxErrors`, the diagnostic messages and the 100-diagnostic cap.
- [.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md) — the symlink override and the login host rules for manual verification.

---

## Non-Goals

- **Enabling lint on any read-only viewer** (Explain plan, index definition) — nothing to fix and no way to fix it, and the Explain plan is not SQL.
- **Enabling lint in `SqlPreviewDialog`** — its SQL is app-generated and correct by construction, and its CREATE FUNCTION flow is dollar-quoted. Threading a per-flow opt-out through a dialog shared by every DDL action would be a footgun for future flows.
- **Registering a PostgreSQL grammar in sqladmin**, or adding any `@codemirror/*` package as a direct dependency.[^no-app-grammar]
- **Any change to the `typescript-ui` library.** The dialect gap is recorded in `LIBRARY_NOTES.md`; fixing it is library work with its own plan.
- **Bumping `@jimka/typescript-ui` in `frontend/package.json`** — a release step, per [release-steps.md](release-steps.md).
- **The JSON viewer in [frontend/src/shell/localStorageWindow.ts:248](frontend/src/shell/localStorageWindow.ts#L248)** — read-only, a different language, and it already switches to no language for non-JSON values.
- **Any diagnostics UI beyond what the option gives** — no problems panel, no next/previous-error navigation, no error count in the status line.

---

## Notes

[^unreleased-dependency]: Verified, not assumed. `frontend/node_modules/@jimka/typescript-ui` is a symlink to `/home/jika/typescript/typescript-ui/packages/lib`, whose built `dist/lib/types/component/editor/CodeEditor.d.ts` declares `lint?: boolean` (line 24) and `setLint` (line 80) — so the option is present in the code this app actually compiles against right now. The *published* package is a different story: `frontend/package.json` pins `"@jimka/typescript-ui": "^0.8.0"`, `frontend/package-lock.json` resolves that to the registry tarball for 0.8.0, and `git show v0.8.0:…/CodeEditor.ts` at the library tag contains no `lint` option — only a comment saying IntelliSense features are deliberately omitted. The local checkout is 477 commits past that tag. So the app-side edits typecheck and run today only under the symlink; a fresh `npm ci` (CI, and the Dockerfile's frontend stage) would not compile them.

[^lint-mechanics]: Read from `CodeEditor.ts`, not from the changelog. `lint` is cached in `applyOptions` (line 568) and applied by `refreshLint()` (line 696), which resolves the active language's `loadLintSource` and reconfigures a CodeMirror compartment with `[linter(source), lintGutter()]`. `mount()` seeds that compartment empty and lets `setLanguage` trigger the refresh (line 1752), so an editor constructed with both `language: "sql"` and `lint: true` gets its linter on first mount. Behaviour that matters to this plan: (a) the linter is **debounced** — `@codemirror/lint`'s default delay is 750ms after the last document change, and its source walks the syntax tree CodeMirror has already built incrementally, so the work per idle period is one walk of an existing tree, not a re-parse, and nothing runs per keystroke; (b) `collectSyntaxErrors` caps output at 100 diagnostics and merges adjacent error nodes, so a pathological document cannot flood the gutter; (c) lint is **independent of `readOnly`** — nothing in `refreshLint` consults it, and the lint plugin schedules a run when its configuration changes, so a read-only editor would show diagnostics just the same; (d) `lintGutter()` installs a gutter with a fixed `width: 1.4em` whether or not any diagnostic exists, which is where the extra column comes from; (e) the library reconfigures with `linter` and `lintGutter` only, **not** `@codemirror/lint`'s `lintKeymap`, so no `F8` or `Ctrl-Shift-m` binding is added and none of QueryPanel's accelerators can collide with one; (f) the library's own editor theme styles `.cm-lintRange-error` with `underline wavy var(--ts-ui-validation-error-border, …)` and `.cm-tooltip-lint .cm-diagnostic` with `var(--ts-ui-tooltip-bg, …)`. This app consumes `--ts-ui-*` tokens and never defines them, so those resolve through the library's own theme in both light and dark — no app styling is needed. The gutter marker icon itself is CodeMirror's own fixed-colour SVG and is not themed by either side.

[^measured-diagnostics]: Measured, not reasoned about. Parsing representative strings with `@codemirror/lang-sql`'s default `StandardSQL` parser and counting error nodes the way `collectSyntaxErrors` does: `SELECT a, b FROM t WHERE a = 1;` → 0; a view body (`SELECT c.relname, n.nspname FROM pg_class c JOIN pg_namespace n ON …`) → 0; `CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)` → 0; a generated `CREATE TABLE public.t (…)` → 0; `CREATE TYPE mood AS ENUM (…)` → 0; `SELECT row_number() OVER (PARTITION BY a ORDER BY b) FROM t;` → 0; `SELECT * FRO` (half-typed) → 0. Errors are reported for `SELECT count(* FROM t;` → 1 (`Missing input`), `SELECT a) FROM t;` → 1 (`Unexpected input`), and a mid-typing `SELECT * FROM t WHERE (` → 1. Notably `select from where` → **0**: the grammar is a token-and-bracket-structure parser, so a statement that is nonsense as SQL but balanced as tokens passes clean. That is the honest description of what this feature catches. An EXPLAIN plan parses badly, as expected for text that is not SQL: `Seq Scan on public.t  (cost=0.00..35.50 rows=2550 width=4)\n  Filter: (a = 1)\n…` → 1 error, and an `EXPLAIN ANALYZE` line with two `cost=`/`actual time=` ranges → 2. The `..` range notation is what trips it.

[^dialect-gap]: The library's `"sql"` language calls `@codemirror/lang-sql`'s `sql()` with no dialect, which is `StandardSQL`. Parsing the same strings under `StandardSQL` and under that package's `PostgreSQL` dialect, error-node counts differ on exactly three constructs: `SELECT a::text, b->>'k' FROM t WHERE c @> '{}'::jsonb;` → 1 vs 0; `SELECT * FROM t WHERE c <@ '{}'::jsonb;` → 1 vs 0; `CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;` → 2 vs 0; and the tagged form `… AS $function$ SELECT 1 $function$;` → 4 vs 0. Everything else measured (casts, `->>`, `~`, `&&`, array literals, window functions, generated DDL) is identical under both. The dollar-quoted rows are what disqualify `FunctionDefinitionPanel` and the CREATE FUNCTION preview: `pg_get_functiondef` always returns a dollar-quoted body, and `backend/app/sql/ddl.py`'s `create_routine` always generates one, so those two surfaces would show a false error on **every** open. The `@>` / `<@` rows are a lesser, content-dependent risk that the query and view-definition editors accept.

[^no-app-grammar]: Registering an app-local `LanguageDefinition` that parses with the `PostgreSQL` dialect is technically possible — `registerLanguage`, `getLanguage`, `LanguageDefinition` and `collectSyntaxErrors` are all public exports of `@jimka/typescript-ui/component/editor` — but it was rejected for three reasons. It would make `@codemirror/lang-sql` a direct dependency of an app that deliberately depends on `@jimka/typescript-ui` and `elkjs` and nothing else. Under the symlink override it would load a **second** copy of the CodeMirror packages (bare specifiers in the linked `dist/lib` resolve from the library checkout's own `node_modules`, while sqladmin's own import resolves from `frontend/node_modules`), and CodeMirror's facets are identity-based across module instances — a duplicate-instance hazard for a dev-only convenience. And it would leave the library's own `"sql"` language still wrong for every other consumer. The dialect belongs to the package that owns the CodeMirror dependency.

[^definition-editor-option]: An options bag rather than a fourth positional `boolean`: a bare `new DefinitionEditor(definition, onSave, onRefresh, true)` says nothing at the call site about what the `true` means. One optional field also leaves room for a second editor option later without another positional parameter. `FunctionDefinitionPanel` is the owner left off rather than `DefinitionPanel` because its text is dollar-quoted every single time, whereas a view's `SELECT` body never is; see the dialect footnote for the measured counts.
