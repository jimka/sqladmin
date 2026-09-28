---
depends-on: [navigator-targeted-refresh]
touches-shared:
  - frontend/src/dock/SqlPreviewDialog.ts
  - frontend/src/dock/ColumnChecklist.ts
  - frontend/src/dock/SchemaDdlForms.ts
---

# DDL Preview Follows Form — Implementation Plan

## Overview

The SQL preview in the DDL dialogs that host an interactive form is generated once, when the dialog opens, and never again. [`runSqlPreviewDialog`](frontend/src/dock/SqlPreviewDialog.ts#L126) seeds the editor from `generateSql()` before `dialog.show()`, and nothing listens to the form afterwards. Execute runs the editor text, so:

- ticking CASCADE in a drop dialog still runs a plain `DROP` (Postgres refuses it when dependents exist);
- typing a new name in Rename table / Rename schema still runs `RENAME TO` the old name;
- Create index opens with "CREATE INDEX requires at least one column", and ticking columns never fixes the preview;
- the same holds for Refresh materialized view's two checkboxes and every Add constraint field.

Commit `783f497` caused this by removing the "Regenerate SQL" button on the belief that every dialog form was a static summary. That is true for the summary panels from [`summaryPanel`](frontend/src/dock/summaryPanel.ts#L14) (Structure, Sequence, Type info panels) and for [`DdlFormPanel`](frontend/src/dock/DdlFormPanel.ts#L71)'s form-less review. It is false for the forms the launchers in [`ddlLaunchers.ts`](frontend/src/controller/ddlLaunchers.ts#L226) (lines 226–568) put in the dialog.

This plan makes the preview follow the form. Interactive forms gain an `onFieldChange(listener)` method. `SqlPreviewDialog` debounces those changes and regenerates the SQL while the user has not edited it by hand. A restored "Regenerate SQL" button discards hand edits on request. The regeneration rules live in a new DOM-free module, `frontend/src/dock/sqlPreviewSync.ts`, so they are unit-tested under node vitest. `ddlLaunchers.ts` does not change.

---

## Architecture Decisions

### Implement the original design: form change signal, auto-regenerate, explicit Regenerate

The fix builds what [`ddl-infrastructure.md`](plans/implemented/ddl-infrastructure.md) specified at lines 191 and 294 and never shipped. The form fires a change signal. The dialog awaits `generateSql()` and sets the editor text. A "Regenerate SQL" button re-runs generation and discards manual edits.[^original-design] The button restores the one `783f497` removed — a plain compact `Button` placed between the form and the editor, wired with `.on("action", …)` (see `git show 783f497^:frontend/src/dock/SqlPreviewDialog.ts`).

### A hand-edited preview is never overwritten automatically

The editor **follows the form** while its text equals the SQL the dialog last generated. Only a following editor is regenerated on a form change. Once the user edits the SQL, form changes leave the editor alone. The only way back is the Regenerate SQL button, which is enabled only while the editor does not follow the form.[^no-confirm]

| Editor state | User changes the form | User clicks Regenerate SQL |
|---|---|---|
| Follows the form (untouched, or edited back to the generated text) | Regenerated after the debounce | Button is disabled |
| Hand-edited | Editor unchanged; button stays enabled | Editor replaced by fresh SQL; button disables |

"Follows the form" compares text after turning `\r\n` into `\n`.[^crlf] The existing `sqlEdited` flag passed to `onSuccess` becomes "the editor does not follow the form" at execute time. It keeps the meaning [`navigator-targeted-refresh`](plans/implemented/navigator-targeted-refresh.md) gave it: the form's values no longer describe what ran.[^sqledited]

### Forms signal change through `onFieldChange`, built on each control's `"change"` event

Each interactive form gets `onFieldChange(listener: () => void): this`. It registers `listener` on the library `"change"` event of every input the form owns. The name and shape copy the library's [`Component.onDirtyChange`](../typescript-ui/packages/lib/src/typescript/lib/core/Component.ts#L2663). Wiring each input's `"change"` copies [`SequenceInfoPanel`](frontend/src/dock/SequenceInfoPanel.ts#L241)'s per-widget `widget.on("change", this.syncSaveEnabled)` loop.[^change-event]

`SqlPreviewDialogOptions.form` becomes the type `SqlPreviewForm`: a `Component` with an optional `onFieldChange`. The dialog subscribes with `options.form?.onFieldChange?.(sync.formChanged)`. Summary panels and form-less dialogs do not have the method, so they behave exactly as today and show no Regenerate button.[^optional-member]

### Changes are debounced by 200 ms, and Execute waits for pending work

A form change schedules one regeneration 200 ms after the last change (`FORM_CHANGE_DEBOUNCE_MS`). This is the same per-keystroke-to-network delay as the library's `AutoCompleteField` default `debounceMs`.[^debounce] Execute first calls `sync.settle()`. `settle()` runs a pending debounced regeneration immediately and waits for any request in flight. So a name typed just before clicking Execute is in the SQL that runs.

Responses can arrive out of order. Each request gets a sequence number, and only the newest request's result is applied. A form-change result is also dropped if the user hand-edited the SQL while it was in flight.

### Generation errors show in the banner; a following editor is cleared, and Execute is vetoed

When a generation fails, the dialog's existing `ErrorBanner` shows the message, and the form stays editable. What else happens depends on what started the generation and on the editor state:

| Trigger | Banner | Caller's `onError` (Notification + status bar) | Editor when following | Editor when hand-edited |
|---|---|---|---|---|
| Dialog open (`"open"`) | shown | called (as today) | cleared to `""` | — (cannot be edited yet) |
| Form change (`"formChange"`) | shown | **not** called | cleared to `""` | never reached (not regenerated) |
| Regenerate SQL (`"button"`) | shown | called | — (button disabled) | kept as typed |

A successful generation hides the banner. Execute is vetoed (returns `false`, dialog stays open, banner keeps the generation error) when the last generation failed and the editor still follows the form. Execute runs normally in every other case.[^failure-policy]

### The regeneration rules live in a DOM-free `SqlPreviewSync` class

`frontend/src/dock/sqlPreviewSync.ts` owns the generated-SQL baseline, the debounce timer, request sequencing and the failure flag. `SqlPreviewDialog` gives it the editor through small host callbacks. This follows the app's split of state machines out of DOM modules so node vitest can test them, as in [`diagramShellState.ts`](frontend/src/dock/diagramShellState.ts#L1) and [`sequenceFormState.ts`](frontend/src/dock/sequenceFormState.ts).

---

## Public API

All of this is app-internal. There is no library change.

### `frontend/src/dock/sqlPreviewSync.ts` (new)

```ts
/** Delay after the last form change before the preview is regenerated. */
export const FORM_CHANGE_DEBOUNCE_MS = 200;

/** What started a regeneration. Decides whether a failure also reaches `onError`. */
export type RegenerateTrigger = "open" | "formChange" | "button";

/** The dialog-side hooks SqlPreviewSync drives. */
export interface SqlPreviewSyncHost {
    /** The caller's `generateSql` for the form's current state. */
    generateSql: () => Promise<string>;
    /** Current editor text. */
    readEditor: () => string;
    /** Replace the editor text. */
    writeEditor: (sql: string) => void;
    /** A generation result was applied. */
    onGenerated: (trigger: RegenerateTrigger) => void;
    /** A generation failure was applied. */
    onFailed: (error: unknown, trigger: RegenerateTrigger) => void;
}

/** Whether two SQL texts are equal once `\r\n` is read as `\n`. */
export function sameSql(a: string, b: string): boolean;

export class SqlPreviewSync {
    constructor(host: SqlPreviewSyncHost, debounceMs?: number);   // defaults to FORM_CHANGE_DEBOUNCE_MS

    /** Whether the editor text equals the last generated SQL (see sameSql). */
    followsForm(): boolean;

    /** Regenerate now, cancelling any pending debounced run. */
    regenerate(trigger: "open" | "button"): Promise<void>;

    /** Arrow-function field (registered by reference): schedule a debounced regeneration if the editor follows the form. */
    readonly formChanged: () => void;

    /** Flush a pending debounced run, await the newest request; true when the editor holds SQL fit to execute. */
    settle(): Promise<boolean>;

    /** Cancel the timer and ignore every later result. Called when the dialog closes. */
    dispose(): void;
}
```

### `frontend/src/dock/SqlPreviewDialog.ts`

```ts
/** A dialog-hosted form. `onFieldChange`, when present, makes the preview follow the form. */
export interface SqlPreviewForm extends Component {
    onFieldChange?(listener: () => void): unknown;
}

export interface SqlPreviewDialogOptions {
    form?: SqlPreviewForm;          // was: Component
    // every other field unchanged
}
```

### Form methods (each returns `this`)

```ts
// ConfirmCascadeForm, RenameTableForm, RenameSchemaForm (SchemaDdlForms.ts),
// RefreshMatviewForm, ColumnChecklist, IndexForm, ConstraintForm:
onFieldChange(listener: () => void): this;
```

---

## Internal Structure

### `SqlPreviewSync` state and core methods

```ts
private readonly _host: SqlPreviewSyncHost;
private readonly _debounceMs: number;
private _generatedSql = "";          // last SQL applied to the editor ("" after an applied failure while following)
private _lastFailed = false;         // the last *applied* generation failed
private _requestSeq = 0;             // bumped per request; only the newest result applies
private _inFlight: Promise<void> | null = null;
private _timer: ReturnType<typeof setTimeout> | null = null;
private _disposed = false;

readonly formChanged = (): void => {
    if (this._disposed) {
        return;
    }

    const follows = this.followsForm();

    if (!follows) {
        return;
    }

    this.cancelTimer();
    this._timer = setTimeout(this.fireDebounced, this._debounceMs);
};

// Arrow field: handed to setTimeout by reference.
private readonly fireDebounced = (): void => {
    this._timer = null;

    const follows = this.followsForm();

    if (follows) {
        void this.startRequest("formChange");
    }
};

private startRequest(trigger: RegenerateTrigger): Promise<void> {
    this._requestSeq += 1;

    const request = this.generateAndApply(this._requestSeq, trigger);

    this._inFlight = request;

    return request;
}

private async generateAndApply(seq: number, trigger: RegenerateTrigger): Promise<void> {
    let sql: string;

    try {
        sql = await this._host.generateSql();
    } catch (err) {
        this.applyFailure(seq, trigger, err);

        return;
    }

    this.applySuccess(seq, trigger, sql);
}

/** A result applies only if the sync is live, it is the newest request, and (for a form change) the editor still follows. Check `_disposed` first: after dispose the editor may be destroyed, so `followsForm()` must not run. */
private isApplicable(seq: number, trigger: RegenerateTrigger): boolean { ... }

private applySuccess(seq: number, trigger: RegenerateTrigger, sql: string): void {
    // if !isApplicable → return
    // set _generatedSql = sql and _lastFailed = false BEFORE writeEditor:
    // writeEditor fires the editor's "change", whose listener reads followsForm().
    // then host.writeEditor(sql); host.onGenerated(trigger)
}

private applyFailure(seq: number, trigger: RegenerateTrigger, err: unknown): void {
    // if !isApplicable → return
    // const follows = this.followsForm();
    // if follows: _generatedSql = ""; host.writeEditor("")   (field first, as above)
    // _lastFailed = true; host.onFailed(err, trigger)
}

async settle(): Promise<boolean> {
    if (this._timer !== null) {
        this.cancelTimer();
        void this.startRequest("formChange");
    }

    await this._inFlight;

    const follows = this.followsForm();

    return !(this._lastFailed && follows);
}
```

`regenerate(trigger)` is `this.cancelTimer(); return this.startRequest(trigger);`. `dispose()` sets `_disposed = true` and cancels the timer.

### `runSqlPreviewDialog` after the change

```ts
async function runSqlPreviewDialog(options: SqlPreviewDialogOptions): Promise<void> {
    const editor = buildPreviewEditor();          // the existing CodeEditor construction, extracted

    editor.on("heightchange", () => dialog.resizeToContent());

    const sync = new SqlPreviewSync({
        generateSql: options.generateSql,
        readEditor:  () => editor.getValue(),
        writeEditor: sql => editor.setValue(sql),
        onGenerated: () => {
            errorBanner.hide();
            syncRegenerateEnabled();
        },
        onFailed: (err, trigger) => {
            if (trigger !== "formChange") {
                reportError(err, options.onError);
            }

            errorBanner.show(err);
            syncRegenerateEnabled();
        },
    });

    // Only a form that can change gets the button (and the editor "change" hook).
    const regenerateButton = options.form?.onFieldChange ? buildRegenerateButton(sync) : null;

    /** Enable Regenerate SQL only while the editor does not follow the form. */
    function syncRegenerateEnabled(): void {
        regenerateButton?.setEnabled(!sync.followsForm());
    }

    if (regenerateButton) {
        editor.on("change", syncRegenerateEnabled);
    }

    const content = Panel({
        layoutManager: VBox({ itemAlign: "stretch", spacing: CONTENT_SPACING }),
        components:    previewComponents(options.form, regenerateButton, editor),
    });

    const errorBanner = new ErrorBanner({ host: content, onChange: () => dialog.resizeToContent() });

    async function tryExecute(): Promise<boolean> {
        const ready = await sync.settle();

        if (!ready) {
            return false;                          // banner already shows the generation error
        }

        errorBanner.hide();

        try {
            const sql       = editor.getValue();
            const sqlEdited = !sync.followsForm();
            const status    = await options.execute(sql);

            options.onSuccess(status, sqlEdited);

            return true;
        } catch (err) {
            reportError(err, options.onError);
            errorBanner.show(err);

            return false;
        }
    }

    // executeButton + dialog construction unchanged

    options.form?.onFieldChange?.(sync.formChanged);

    try {
        await sync.regenerate("open");
        syncRegenerateEnabled();
        await dialog.show();
    } finally {
        sync.dispose();
        errorBanner.dispose();
    }
}
```

Module-level helpers in `SqlPreviewDialog.ts`:

- `buildPreviewEditor(): CodeEditor` — the current `new CodeEditor("", { language, autoHeightMaxRows, autoHeightMinRows })`.
- `buildRegenerateButton(sync: SqlPreviewSync): Button` — `Button({ text: "Regenerate SQL", compact: true })` plus `button.on("action", () => void sync.regenerate("button"))`. Import `Button` from `@jimka/typescript-ui/component/button`.
- `previewComponents(form, regenerateButton, editor): Component[]` — returns `[form, regenerateButton, editor]`, `[form, editor]` or `[editor]`, leaving out whichever is absent.

`seededSql`, `seedPreview()` and the `let seededSql = ""` declaration are removed. `SqlPreviewSync` replaces them.

---

## Ordered Implementation Steps

1. **Create `frontend/src/dock/sqlPreviewSync.ts`** with the API and internals above. Add a file header comment in the style of `diagramShellState.ts`, and cite this plan and `ddl-infrastructure.md`'s preview-refresh design. Use JSDoc on every member. Put the "why 200" comment on `FORM_CHANGE_DEBOUNCE_MS` (see [^debounce]). Do not use a DOM or library import.
2. **Create `frontend/tests/dock/sqlPreviewSync.test.ts`** covering every unit case in _Expected Behaviour_. Use `vi.useFakeTimers()` and manually resolved promises for `generateSql`. Host `readEditor`/`writeEditor` with a plain `let text` variable. Run `cd frontend && npx vitest run tests/dock/sqlPreviewSync.test.ts` and expect it to pass.
3. **`frontend/src/dock/ConfirmCascadeForm.ts`** — add `onFieldChange` after [`readSpec`](frontend/src/dock/ConfirmCascadeForm.ts#L35). It calls `this._cascadeBox.on("change", listener)` and returns `this`.
4. **`frontend/src/dock/RenameTableForm.ts`** — add `onFieldChange` after [`readSpec`](frontend/src/dock/RenameTableForm.ts#L31), registering on `_newNameField`.
5. **`frontend/src/dock/SchemaDdlForms.ts`** — add `onFieldChange` to [`RenameSchemaForm`](frontend/src/dock/SchemaDdlForms.ts#L51), registering on `_newNameField`. Do not touch `CreateSchemaForm` (tab-hosted).
6. **`frontend/src/dock/RefreshMatviewForm.ts`** — add `onFieldChange`, registering on `_concurrentlyBox` and `_withNoDataBox`. Leave the existing mutual-disable listeners as they are.
7. **`frontend/src/dock/ColumnChecklist.ts`** — add `onFieldChange` after [`readSelected`](frontend/src/dock/ColumnChecklist.ts#L39), registering on every entry of `_boxes`.
8. **`frontend/src/dock/IndexForm.ts`** — add `onFieldChange`, registering on `_nameField`, `_uniqueBox` and `_methodCombo`, and calling `this._checklist.onFieldChange(listener)`.
9. **`frontend/src/dock/ConstraintForm.ts`** — add `onFieldChange` to [`ConstraintForm`](frontend/src/dock/ConstraintForm.ts#L80). It registers on `_nameField` and calls `this._fields.checklist?.onFieldChange(listener)`. It registers separately with `?.` on each of `expressionField`, `refSchemaCombo`, `refTableField`, `refColumnsField`, `onUpdateCombo`, `onDeleteCombo`. Use one statement per field, not a loop over a mixed `TextField | ComboBox` array.[^union-on]
10. **Update each form's file header comment** (steps 3–9) with one line saying the form reports field edits through `onFieldChange`, which `SqlPreviewDialog` uses to keep the preview in step.
11. **`frontend/src/dock/SqlPreviewDialog.ts`** — add the `SqlPreviewForm` interface and retype `SqlPreviewDialogOptions.form`. Rewrite `runSqlPreviewDialog` as in _Internal Structure_, and add `buildPreviewEditor`, `buildRegenerateButton` and `previewComponents`.
    - Rewrite the header comment's "generateSql() only ever seeds once … would only ever reproduce the same seed" passage to describe following, the Regenerate rule and the failure table, citing this plan.
    - Update the "Every failure" paragraph: form-change failures show in the banner only.
    - Update the `generateSql` option doc: a rejection clears an editor that follows the form and leaves a hand-edited one as is.
    - Update the `onSuccess` doc: `sqlEdited` is measured against the most recently generated SQL, not the first.
12. **Checkpoint:** `grep -n "seededSql\|seedPreview" frontend/src` should return zero matches. `grep -n "onFieldChange" frontend/src/controller/ddlLaunchers.ts` should also return zero matches, because the launchers are untouched.
13. **Checkpoint:** `cd frontend && npm run typecheck && npm test`. Both must pass. In a worktree, symlink `node_modules` from the main tree first.
14. **Manual verification**: run M1–M12 from _Expected Behaviour_ in the live app per `.claude/skills/verify/SKILL.md`.

---

## Files to Create / Modify / Delete

| Action | File |
|---|---|
| Create | `frontend/src/dock/sqlPreviewSync.ts` |
| Create | `frontend/tests/dock/sqlPreviewSync.test.ts` |
| Modify | `frontend/src/dock/SqlPreviewDialog.ts` |
| Modify | `frontend/src/dock/ConfirmCascadeForm.ts` |
| Modify | `frontend/src/dock/RenameTableForm.ts` |
| Modify | `frontend/src/dock/SchemaDdlForms.ts` |
| Modify | `frontend/src/dock/RefreshMatviewForm.ts` |
| Modify | `frontend/src/dock/ColumnChecklist.ts` |
| Modify | `frontend/src/dock/IndexForm.ts` |
| Modify | `frontend/src/dock/ConstraintForm.ts` |

---

## Expected Behaviour

### Unit-testable (`sqlPreviewSync.test.ts`)

Timers are fake. "Resolves"/"rejects" means the test settles that request's promise by hand.

- **U1 — open success.** `regenerate("open")` resolves `"DROP TABLE t"`. Result: the editor is `"DROP TABLE t"`, `followsForm()` is true, and `onGenerated("open")` is called once.
- **U2 — open failure.** `generateSql` rejects `Error("needs a column")`. Result: the editor stays `""`, `onFailed(err, "open")` is called, and `settle()` resolves `false`.
- **U3 — debounce.** While following, three `formChanged()` calls fall 50 ms apart. `generateSql` is not called before 200 ms after the third call, and is called exactly once after that.
- **U4 — edited editor ignores form changes.** After U1, set the editor to `"DROP TABLE t -- mine"`, call `formChanged()` and advance 1000 ms. `generateSql` is not called again, the editor keeps the edit, and `followsForm()` is false.
- **U5 — edit back resumes following.** Continue from U4, set the editor back to `"DROP TABLE t"`. `followsForm()` is true, and a later `formChanged()` regenerates after 200 ms.
- **U6 — edit during an in-flight form change wins.** A form-change request is pending. The editor is then edited and the request resolves `"X"`. The editor keeps the edit, and `onGenerated` is not called.
- **U7 — out-of-order responses.** Request A starts, then request B starts. B resolves `"B"`, then A resolves `"A"`. The editor ends as `"B"`.
- **U8 — form-change failure while following.** After U1, a form change rejects. The editor becomes `""`, `onFailed(err, "formChange")` is called, and `settle()` resolves `false`. A following form change that resolves `"DROP TABLE t CASCADE"` sets the editor, and `settle()` then resolves `true`.
- **U9 — Regenerate replaces a hand edit.** With the editor hand-edited, `regenerate("button")` resolving `"Y"` sets the editor to `"Y"`, and `followsForm()` becomes true.
- **U10 — Regenerate failure keeps a hand edit.** With the editor hand-edited to `"MINE"`, `regenerate("button")` rejects. The editor stays `"MINE"`, `onFailed(err, "button")` is called, and `settle()` resolves `true`.
- **U11 — settle flushes the debounce.** Call `formChanged()` and immediately `settle()` without advancing timers. `generateSql` is called right away. `settle()` resolves after that request, and the editor holds its result.
- **U12 — settle with nothing pending** after U1 resolves `true` without calling `generateSql`.
- **U13 — dispose.** After `dispose()`, a pending debounce never calls `generateSql`. A request already in flight that resolves later does not call `writeEditor`, `onGenerated` or `onFailed`.
- **U14 — `sameSql`.** `sameSql("a\r\nb", "a\nb")` is true. `sameSql("a", "a ")` is false.
- **U15 — field order.** `writeEditor` is called after `followsForm()` already reports the new baseline. Assert this by reading `sync.followsForm()` inside the `writeEditor` stub after the stub stores the text.

### Manual (live app — dialogs, focus, Postgres)

Before M1–M2, create fixtures in a Query tab: `CREATE TABLE public.pv_parent(id int); CREATE VIEW public.pv_child AS SELECT * FROM public.pv_parent;`.

- **M1 — CASCADE is honoured.** Open Drop table on `pv_parent`. Tick CASCADE. Within about 200 ms the preview ends in `CASCADE`, and Regenerate SQL stays disabled. Click Execute: it succeeds, and `pv_child` is gone too. The navigator refreshes every loaded schema (the `cascade: true`, `sqlEdited: false` scope).
- **M2 — without CASCADE.** Recreate the fixtures. Open Drop table with CASCADE unticked and click Execute. Postgres's "other objects depend on it" error shows in the banner, and the dialog stays open. Now tick CASCADE; the preview updates and the banner hides. Click Execute: it succeeds.
- **M3 — rename.** Open Rename table on `pv_parent`, type `pv_parent2` and click Execute immediately (under 200 ms). The table is renamed to `pv_parent2`, because `settle()` flushed the debounce. Repeat for Rename schema on a scratch schema.
- **M4 — create index from empty.** Open Create index from the Structure tab. The banner shows "CREATE INDEX requires at least one column" and the preview is empty. Tick one column: the preview shows `CREATE INDEX …` and the banner hides. Tick Unique and pick `hash`: the preview follows each change.
- **M5 — invalid again.** Continue from M4 and untick every column. The preview clears and the banner shows the error. Click Execute: the dialog stays open, the same error remains, and no request reaches `/ddl/execute` (check the network panel).
- **M6 — manual edit, then form change.** Open Drop table on any table. Add `-- note` to the SQL: Regenerate SQL becomes enabled. Tick CASCADE: the SQL is unchanged. Click Regenerate SQL: the SQL becomes the CASCADE statement without `-- note`, and the button disables.
- **M7 — Add constraint (foreign key).** Pick local columns, the referenced schema, table and columns, and ON DELETE: the preview follows each field. Repeat briefly for check (the expression field) and unique.
- **M8 — Refresh materialized view.** Tick CONCURRENTLY: the preview gains `CONCURRENTLY`, and WITH NO DATA disables as before.
- **M9 — index advisor.** Use a suggestion's "Create index…" in a Query tab. The preview opens with the suggested columns in order. Untick one column: the preview follows.
- **M10 — no notification spam.** In M4/M5 the validation errors from ticking and unticking appear in the banner only. Notification history and the status bar gain no entry. The failure on opening still reports once, as before.
- **M11 — static dialogs unchanged.** The Structure tab's "Alter columns" save and a tab-hosted Create table "Review SQL…" show no Regenerate SQL button and behave as before.
- **M12 — close while pending.** Open Rename table, type a character and press Escape within 200 ms. No console error appears, and no preview request fires after the close.

---

## Verification

- `cd frontend && npm run typecheck && npm test` — green, including `tests/dock/sqlPreviewSync.test.ts` (U1–U15).
- `grep -n "seededSql\|seedPreview" frontend/src` — zero matches.
- `git diff --stat -- frontend/src/controller/ddlLaunchers.ts` — empty.
- Manual M1–M12 in the live app. The login host depends on how the backend runs (`sqladmin-db` under Compose, `localhost` natively).

---

## Potential Challenges

- **`CodeEditor.setValue` fires `"change"`.** Any mounted `setValue` dispatches a transaction that emits `"change"`, so the dialog cannot use that event to detect user edits. Mitigation: following is decided by text comparison, never by the event's source.
- **A late timer or response after close.** The editor and form are destroyed when the dialog closes. Mitigation: `sync.dispose()` in the `finally` block, plus the `_disposed` check in `isApplicable` (U13, M12).
- **Banner flicker.** Hiding the banner at the start of every regeneration would resize the dialog twice per keystroke. Mitigation: hide it only on an applied success, as specified.
- **Seed runs before mount.** `writeEditor` during `regenerate("open")` only caches the value, and `getValue()` returns that cache until mount. Following comparisons stay correct.

---

## Critical Files

- [`frontend/src/dock/SqlPreviewDialog.ts`](frontend/src/dock/SqlPreviewDialog.ts#L126) — the dialog being changed.
- `git show 783f497` — the removed Regenerate button being restored (placement, `Button` import, `.on("action")`).
- [`plans/implemented/ddl-infrastructure.md`](plans/implemented/ddl-infrastructure.md) lines 191 and 294 — the original preview-refresh design.
- [`plans/implemented/navigator-targeted-refresh.md`](plans/implemented/navigator-targeted-refresh.md) — where `sqlEdited` comes from and what it means for the refresh scope.
- [`frontend/src/dock/SequenceInfoPanel.ts`](frontend/src/dock/SequenceInfoPanel.ts#L241) — the per-widget `"change"` wiring precedent.
- [`frontend/src/dock/diagramShellState.ts`](frontend/src/dock/diagramShellState.ts#L1) and `frontend/tests/dock/diagramShellState.test.ts` — the DOM-free module and test precedent.
- [`frontend/src/controller/ddlLaunchers.ts`](frontend/src/controller/ddlLaunchers.ts#L226) — the call sites (read-only). Confirms every form reaches the dialog as `form` with no change needed.
- `frontend/COMPONENT_CONVENTIONS.md` — rule (c): handlers registered by reference are arrow-function fields (`formChanged`, `fireDebounced`).
- Library: `component/input/AbstractInput.ts` (`on("change")`), `TextInput.ts` (`onInput` → `notifyChange` on every keystroke), `Checkbox.ts` / `ComboBox.ts` (`"change"` vs `"action"`), `editor/CodeEditor.ts` (`setValue`, `onDocChange`).

---

## Non-Goals

- **Live preview in the tab-hosted creation forms** (`DdlFormPanel`). Their review dialog is form-less and opens fresh on each "Review SQL…", so it is always current.
- **A Regenerate/reset button for summary or form-less dialogs.** Their input cannot change while the modal is open.
- **Disabling Execute while the preview is invalid.** The library `Dialog` has no per-button enable API, so the `onClick` veto is the mechanism, as it is today.
- **Changes to `ddlLaunchers.ts` or backend preview validation.**
- **Version bumps or CHANGELOG entries.** These belong to the release step.

---

## Notes

[^original-design]: `ddl-infrastructure.md:191` reads: "the form fires a change signal → the dialog awaits generateSql() and sets the editor text. Debounce/explicit trigger is the phase's choice … A 'Regenerate SQL' affordance re-runs it (discarding manual edits)". Line 294 names the race between manual edits and form-driven regeneration and leaves auto-regeneration to each phase. No phase ever wired the signal. The in-tab precedent (`DdlFormPanel`'s "Review SQL…") regenerates on an explicit trigger by opening a fresh dialog. That cannot apply inside a modal whose form stays open, so the infra design is the governing precedent. Restoring only the Regenerate button (no live updates) was rejected: it keeps the reported trap, where a user ticks CASCADE, sees nothing change and executes the wrong statement. Live-only with no button was rejected because a hand edit would then have no way back to the form.

[^no-confirm]: Asking "discard your SQL edits?" (`Dialog.confirm`) on each form change was rejected. It interrupts every checkbox click after an edit, and the user can always recover with one Regenerate click. The Regenerate button itself needs no confirmation because discarding edits is its stated purpose. The enabled or disabled state of the button is the visible sign of whether the SQL still follows the form.

[^crlf]: CodeMirror stores documents with `\n` line breaks and `getValue()` joins lines with `\n`. If `generateSql` ever returned `\r\n`, a raw comparison would report every untouched preview as edited and silently stop auto-regeneration. The existing `sql !== seededSql` check had the same weakness.

[^sqledited]: `navigator-targeted-refresh` widens the navigator refresh when `sqlEdited` is true, because the form's values no longer describe what ran. With a preview that is generated once, a user who ticked CASCADE got `sqlEdited: false` and `cascade: true` for a statement that had no CASCADE. Comparing against the newest generated SQL, after `settle()`, makes `sqlEdited: false` mean again that the form describes the executed SQL.

[^change-event]: typescript-ui 0.10.0 inputs expose two events. `"action"` fires only on user activation: for `TextField` it is the native `input` event, for `Checkbox`/`ComboBox` it is the DOM `change` on a click, key or row commit. `"change"` (the `AbstractInput` listener bag) fires on every committed value change, including programmatic `setValue`. For `TextField`, `"change"` fires on every keystroke via `TextInput.onInput` → `notifyChange`. `"change"` is the event the app already uses to follow form values (`SequenceInfoPanel`, `RefreshMatviewForm`, `diagramShell`). No form here calls `setValue` after construction, and listeners are added after construction, so programmatic firing causes no spurious runs. `Component.onDirtyChange` was rejected as the signal because it fires only on dirty/clean transitions: a second keystroke in an already-dirty field would not fire it. A subtree listener for the DOM `change` event on the form was rejected too. `TextField` does not fire DOM `change` per keystroke, and `Checkbox` skips its DOM `change` when a listener-bag listener disposed it, so coverage would depend on each control's internals.

[^optional-member]: An optional method keeps every existing caller compiling unchanged. The summary panels, `DdlFormPanel`'s form-less review and the six form classes `ddlLaunchers.ts` passes all remain valid `form` values. Calling it as `options.form?.onFieldChange?.(…)` keeps `this` bound to the form. A separate `watchForm` option on `SqlPreviewDialogOptions` was rejected: it would need a change at all 14 launcher call sites to say something the form already knows.

[^debounce]: `TextField` reports every keystroke, and every regeneration is a backend preview request, so typing a name needs a debounce. The library has no public debounce helper. Its own per-keystroke-to-network debounce is `AutoCompleteField`'s `debounceMs` default of 200 ms (`AutoCompleteField.ts:89`), so the app uses the same value rather than tuning a new one. Checkbox and combo changes use the same delay for one simple rule. `settle()` removes any risk of executing stale SQL because of that delay.

[^failure-policy]: Form-change failures skip `onError` because they are expected while the user is part-way through filling in a form (no columns yet, an empty name). Sending each one through `host.notifyError` would add a Notification-history entry and a status-bar message per pause in typing, and the toast would be hidden behind the modal anyway. The open and Regenerate failures keep calling `onError`, which is today's behaviour for the seed. Clearing a following editor on failure means stale SQL that disagrees with the form (for example, an index on a column the user just unticked) is never shown or executed. Nothing the user typed is lost, because a following editor holds only generated text. After such a failure, `settle()` vetoes Execute so the banner keeps the real reason. Without the veto, the empty editor would reach the backend and replace that reason with "Empty DDL statement". A hand-edited editor is never cleared, and Execute then runs the user's text as today.

[^union-on]: `TextField.on` and `ComboBox.on` are both overloaded. Calling `.on("change", …)` on a `TextField | ComboBox` union value can fail to type-check ("each member has signatures, but none are compatible"). Separate statements keep each call on one concrete type.

---

## Implementation Notes

The code follows _Public API_ and _Internal Structure_ as written, with four audit-driven additions, each described below. The audit found that the plan's `sync.dispose()` in `runSqlPreviewDialog`'s `finally` runs too late. `Dialog.show()` resolves only after `hide()`'s 150 ms exit animation, so a debounce armed 50–200 ms before Escape, Cancel or ✕ still fired a preview request while the dialog faded out. This broke M12, and the plan's _Potential Challenges_ entry had missed it. `SqlPreviewDialog.ts` now builds a module-private `SqlPreviewModal extends Dialog`, whose `hide()` override disposes the sync before calling `super.hide()`. Every dismiss path goes through `hide()`, and COMPONENT_CONVENTIONS (g) says a guarded dialog should extend `Dialog` directly. The `finally` still calls `dispose()`, which is idempotent. Because dispose now happens as soon as a close starts, a close can land while Execute is waiting in `settle()` for a flushed preview request. `settle()` therefore returns `false` once the sync is disposed, so a cancelled dialog never executes the SQL it held before the flush. The plan's `settle()` sketch had no such check. Two added unit tests cover it: dispose while settle waits, and settle after dispose. The audit also found that the plan's `settle()`, which awaited a single request, could return early. The form stays editable while Execute waits, so an edit made then could start a newer request, or arm a new debounce, that `settle()` never awaited. The dropped result then left the pre-edit SQL to execute. `settle()` now loops: it flushes the timer and awaits the in-flight request until no timer is pending and no newer request has started. Two further unit tests cover it: a request started while settle waits, and a debounce armed while settle waits. The branch was built on `feature/dirty-tab-modified-indicator`, but none of the files this plan touches changed between `feature/navigator-targeted-refresh` and that tip.

### Fourth addition: form changes during an open/Regenerate request

After the audit cap was reached, the coordinator had the last open BLOCKING finding fixed and re-audited in one more round.

- **The finding:** a form change that arrived while a Regenerate SQL request was in flight was dropped. `formChanged()` saw a hand-edited editor, and the plan's sketch ignores changes then. The button result then made the editor follow the form again, but with SQL for the form's state before the change. Execute ran it with `sqlEdited: false`.
- **The fix:** `SqlPreviewSync` now holds such a change (`_heldFormChange`) while an open or Regenerate request is in flight (`_regenerateSeq`). When that request lands, `releaseHeldFormChange` starts a form-change regeneration at once if the editor follows. That request starts synchronously, so the looping `settle()` sees it and Execute waits for it too.
- **The symmetric case:** a Regenerate result is no longer applied if the user typed in the editor after clicking (the editor text is compared with its text when the request started). So an edit made while the request is in flight survives, as U6 already guaranteed for form-change requests. This refines the plan's "Regenerate discards manual edits": it still discards the edits that existed when the user clicked.
- **Tests:** two unit tests cover it: a held change is regenerated and awaited by settle, and a hand edit typed during a Regenerate request is kept.
- **Audit:** a fresh audit round on this fix reported no BLOCKING findings. Its ADVISORY items are the stale sentence in COMPONENT_CONVENTIONS (g), a possible library close-start hook, `flushTimer` skipping the follows check, a rare stuck state after a failed Regenerate, and minor JSDoc and test-style nits. None of them was acted on.

### Verification record

- **Automated:** U1–U15 in `frontend/tests/dock/sqlPreviewSync.test.ts` were written first and failed (the module did not exist), then passed. `npm run typecheck` and the full `npm test` pass. The step-12 greps return no matches.
- **Live UI (Chrome via chrome-devtools, dev server from this worktree against typescript-ui 0.10.0, Postgres on localhost):** M1–M12 were each run in the app. Every scratch object (`pv_parent`, `pv_child`, `pv_mv`, `pv_scratch`) was dropped afterwards.
  - M2 then M1 on one dialog: Execute without CASCADE showed Postgres's "other objects depend on it" error in the banner, and the dialog stayed open. Ticking CASCADE had not changed the preview after 100 ms, and it ended in `CASCADE` by 600 ms. The banner hid and Regenerate SQL stayed disabled. Execute succeeded, and `pg_class` confirmed that both `pv_parent` and the dependent view `pv_child` were gone.
  - M6: real keystrokes added ` -- note` to the editor, which enabled Regenerate SQL. Ticking CASCADE left the edit untouched. A real click on Regenerate SQL replaced the text with the CASCADE statement and disabled the button.
  - M3 (table): the name was set and Execute clicked in the same script tick, so no debounce had fired. At the click the preview still read `RENAME TO "pv_parent"`. The network log shows the settle-flushed preview request before `/ddl/execute`, and the table was renamed to `pv_parent2`. M3 (schema): typed with real keystrokes, the preview followed, and an Execute click renamed the schema.
  - M12: the first run pressed Escape in the same tick as the input change, so it missed the gap the audit later found. After the fix, a scripted probe wrapped `fetch`, changed the name and pressed Escape 122 ms later. No preview request fired, and the console had no error. A control run with the same steps and no Escape saw the preview request at 203 ms, which shows the probe would have caught one. A rename Execute still succeeded through the new subclass.
  - M4, M5, M10: Create index opened with an empty preview and the banner "CREATE INDEX requires at least one column". Ticking `id`, ticking Unique, and picking `hash` with the keyboard in the method combo each updated the preview. Unticking `id` cleared the preview and showed the error again. A real Execute click kept the dialog open, and no `/ddl/execute` request was sent. Notification history then held exactly one CREATE INDEX entry, from the open.
  - M7: foreign key. The local column, referenced table and columns (typed), ON DELETE CASCADE and a referenced-schema change (keyboard) each updated the preview. Unique followed a column tick, and check followed its expression field. None was executed.
  - M8: CONCURRENTLY and WITH NO DATA each updated the preview, and each still disabled the other.
  - M9: Explain Analyze on a 20 000-row scratch table suggested `("name", "id")`, and the dialog opened with that column order. Unticking `id` updated the preview to `("name")`.
  - M11: Structure's Alter columns dialog (which then executed successfully) and the tab-hosted Create table's Review SQL… showed no Regenerate SQL button.
  - Held form change during Regenerate (the fourth addition): the dialog was driven live with every DDL preview response delayed by 2 s, using a `fetch` wrapper installed in the page (`/ddl/execute` was not delayed).
    - Open Drop table on `pv_parent`, which had the dependent view `pv_child`. Add ` -- note` with real keystrokes, then click Regenerate SQL (a real click). While its response was pending, tick CASCADE and click Execute (synthetic events in one script).
    - The fetch log shows the Regenerate preview request with `cascade:false`, and the follow-up preview request with `cascade:true` started 3 ms after it landed. `/ddl/execute` ran only after that follow-up landed, with `DROP TABLE "public"."pv_parent" CASCADE`. Both `pv_parent` and `pv_child` were gone.
    - `sqlEdited: false` in that run follows from `followsForm()` being true, which is pinned by the unit test. It was not observed directly in the UI.
  - Symmetric case, same delay: add ` -- a` with real keystrokes, click Regenerate SQL, then type `b` with real keystrokes while the request was pending. After the response landed, the editor still read `... -- ab`, and Regenerate stayed enabled. A later Regenerate click with no typing replaced the text and disabled the button.
  - Some checkbox ticks and M3's fast path were driven with synthetic pointer or input events from `evaluate_script`, because the a11y click lands in the empty centre of the full-width Checkbox row. Everything else used real clicks and keystrokes.
