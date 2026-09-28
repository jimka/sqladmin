// The DOM-free rules that keep a SqlPreviewDialog's SQL preview in step with
// its form: the last generated SQL (the baseline the editor "follows" while
// its text still equals it), the debounce between a form change and the
// preview request it triggers, request sequencing so only the newest result
// lands, and whether the last generation failed. Kept out of
// SqlPreviewDialog.ts (which constructs the CodeEditor, Button and Dialog and
// so needs a DOM) so node vitest can test it, mirroring diagramShellState.ts's
// split out of diagramShell.ts. This is the preview-refresh design
// plans/implemented/ddl-infrastructure.md specified and never shipped — the
// form fires a change signal, the dialog regenerates, a "Regenerate SQL"
// action discards manual edits — as built by
// plans/implemented/ddl-preview-follows-form.md.

/**
 * Delay after the last form change before the preview is regenerated.
 *
 * A TextField reports every keystroke and every regeneration is a backend
 * preview request, so typing needs a debounce. The library exposes no public
 * debounce helper; its own per-keystroke-to-network delay is
 * AutoCompleteField's `debounceMs` default of 200 ms, so the app reuses that
 * value rather than tuning a new one. Checkbox and combo changes share it for
 * one simple rule, and `settle()` removes any risk of executing stale SQL
 * because of the delay.
 */
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

/**
 * Whether two SQL texts are equal once `\r\n` is read as `\n`. CodeMirror
 * stores `\n` line breaks, so a raw comparison against a `\r\n` generation
 * would report every untouched preview as edited.
 *
 * @param a - The first SQL text.
 * @param b - The second SQL text.
 * @returns True when the texts match after normalising line breaks.
 */
export function sameSql(a: string, b: string): boolean {
    return normaliseLineBreaks(a) === normaliseLineBreaks(b);
}

/**
 * Replace every `\r\n` with `\n`.
 *
 * @param text - The text to normalise.
 * @returns The text with LF-only line breaks.
 */
function normaliseLineBreaks(text: string): string {
    return text.replace(/\r\n/g, "\n");
}

/**
 * Keeps an SQL preview editor in step with its form. The editor "follows the
 * form" while its text equals the last generated SQL: only then does a form
 * change regenerate it. A hand-edited editor is never overwritten
 * automatically — only an explicit `regenerate("button")` replaces it.
 */
export class SqlPreviewSync {
    private readonly _host: SqlPreviewSyncHost;
    private readonly _debounceMs: number;
    // Last SQL applied to the editor ("" after an applied failure while following).
    private _generatedSql = "";
    // Whether the last *applied* generation failed.
    private _lastFailed = false;
    // Bumped per request; only the newest request's result applies.
    private _requestSeq = 0;
    private _inFlight: Promise<void> | null = null;
    private _timer: ReturnType<typeof setTimeout> | null = null;
    private _disposed = false;
    // Sequence number of the open/Regenerate request in flight, or null when
    // none is. A form change that arrives meanwhile is held, not dropped.
    private _regenerateSeq: number | null = null;
    // A form change arrived while `_regenerateSeq`'s request was in flight:
    // that request read the form before the change, so its result is stale.
    private _heldFormChange = false;
    // Editor text when the newest request started. A Regenerate result only
    // replaces the editor if the user has not typed since clicking.
    private _editorAtRequest = "";

    /**
     * @param host - The dialog-side hooks to drive.
     * @param debounceMs - Delay after the last form change before regenerating.
     */
    constructor(host: SqlPreviewSyncHost, debounceMs: number = FORM_CHANGE_DEBOUNCE_MS) {
        this._host       = host;
        this._debounceMs = debounceMs;
    }

    /**
     * Whether the editor text equals the last generated SQL (see {@link sameSql}).
     *
     * @returns True while the editor follows the form.
     */
    followsForm(): boolean {
        return sameSql(this._host.readEditor(), this._generatedSql);
    }

    /**
     * Regenerate now, cancelling any pending debounced run.
     *
     * @param trigger - `"open"` for the dialog's first generation, `"button"`
     *   for Regenerate SQL (which replaces a hand edit on success).
     * @returns A promise that settles once the result has been applied or dropped.
     */
    regenerate(trigger: "open" | "button"): Promise<void> {
        this.cancelTimer();

        return this.startRequest(trigger);
    }

    /**
     * Schedule a debounced regeneration if the editor follows the form. While
     * an open/Regenerate request is in flight the change is held instead, since
     * that request read the form before it and will make the editor follow
     * again when it lands. An arrow-function field: forms register it by
     * reference.
     */
    readonly formChanged = (): void => {
        if (this._disposed) {
            return;
        }

        if (this._regenerateSeq !== null) {
            this._heldFormChange = true;
        }

        const follows = this.followsForm();

        if (!follows) {
            return;
        }

        this.cancelTimer();
        this._timer = setTimeout(this.fireDebounced, this._debounceMs);
    };

    /**
     * Flush a pending debounced run and await the newest request, repeating
     * while form changes made in the meantime start newer ones.
     *
     * @returns True when the editor holds SQL fit to execute: false when the
     *   sync has been disposed (the dialog is closing, so nothing may run), or
     *   when the last generation failed and the editor still follows the form.
     */
    async settle(): Promise<boolean> {
        // The form stays editable while Execute waits here, so a change can
        // arm a new debounce or start a newer request during the await; loop
        // until nothing newer is pending, so the SQL that runs matches the
        // form's latest state.
        let awaited: Promise<void> | null;

        do {
            this.flushTimer();
            awaited = this._inFlight;
            await awaited;

            // Checked after the await: the user may close the dialog while the
            // request is in flight, and `followsForm()` must not run then.
            if (this._disposed) {
                return false;
            }
        } while (this._timer !== null || this._inFlight !== awaited);

        const follows = this.followsForm();

        return !(this._lastFailed && follows);
    }

    /** Cancel the timer and ignore every later result. Called when the dialog closes. */
    dispose(): void {
        this._disposed = true;
        this.cancelTimer();
    }

    /**
     * The debounce timer's callback: start a form-change request if the editor
     * still follows. An arrow-function field: handed to `setTimeout` by reference.
     */
    private readonly fireDebounced = (): void => {
        this._timer = null;

        const follows = this.followsForm();

        if (follows) {
            void this.startRequest("formChange");
        }
    };

    /** Start a pending debounced regeneration now, instead of waiting for its timer. */
    private flushTimer(): void {
        if (this._timer === null) {
            return;
        }

        this.cancelTimer();
        void this.startRequest("formChange");
    }

    /** Clear a pending debounce timer, if any. */
    private cancelTimer(): void {
        if (this._timer === null) {
            return;
        }

        clearTimeout(this._timer);
        this._timer = null;
    }

    /**
     * Start a numbered generation request and record it as the one in flight.
     *
     * @param trigger - What started the request.
     * @returns The request's apply-or-drop promise.
     */
    private startRequest(trigger: RegenerateTrigger): Promise<void> {
        this._requestSeq += 1;

        // Every request reads the form's current state, so nothing held
        // before this point is still pending.
        this._heldFormChange  = false;
        this._regenerateSeq   = trigger === "formChange" ? null : this._requestSeq;
        this._editorAtRequest = this._host.readEditor();

        const request = this.generateAndApply(this._requestSeq, trigger);

        this._inFlight = request;

        return request;
    }

    /**
     * Await the host's generation and apply its success or failure.
     *
     * @param seq - The request's sequence number.
     * @param trigger - What started the request.
     */
    private async generateAndApply(seq: number, trigger: RegenerateTrigger): Promise<void> {
        let sql: string;

        try {
            sql = await this._host.generateSql();
        } catch (err) {
            this.applyFailure(seq, trigger, err);
            this.releaseHeldFormChange(seq);

            return;
        }

        this.applySuccess(seq, trigger, sql);
        this.releaseHeldFormChange(seq);
    }

    /**
     * Once the open/Regenerate request `seq` has landed, regenerate at once
     * for a form change held while it was in flight, if the editor now follows
     * the form. Started synchronously, so a `settle()` awaiting `seq` sees the
     * newer request and waits for it too.
     *
     * @param seq - The request that just landed.
     */
    private releaseHeldFormChange(seq: number): void {
        if (this._regenerateSeq !== seq) {
            return;
        }

        const held = this._heldFormChange;

        this._regenerateSeq  = null;
        this._heldFormChange = false;

        if (this._disposed || !held) {
            return;
        }

        const follows = this.followsForm();

        // A debounce armed for the same change (the editor was edited back to
        // the baseline meanwhile) would only repeat this request.
        if (follows) {
            this.cancelTimer();
            void this.startRequest("formChange");
        }
    }

    /**
     * Whether a result may be applied: the sync is live, the request is the
     * newest, and — for a form change — the editor still follows the form.
     * `_disposed` is checked first: after dispose the editor may be destroyed,
     * so `followsForm()` must not run.
     *
     * @param seq - The request's sequence number.
     * @param trigger - What started the request.
     * @returns True when the result should be applied.
     */
    private isApplicable(seq: number, trigger: RegenerateTrigger): boolean {
        if (this._disposed || seq !== this._requestSeq) {
            return false;
        }

        if (trigger !== "formChange") {
            return true;
        }

        return this.followsForm();
    }

    /**
     * Apply a successful generation. A Regenerate result is dropped when the
     * user typed in the editor after clicking, so that newer edit survives.
     * The baseline is set before `writeEditor`, because writing fires the
     * editor's "change", whose listener reads `followsForm()`.
     *
     * @param seq - The request's sequence number.
     * @param trigger - What started the request.
     * @param sql - The generated SQL.
     */
    private applySuccess(seq: number, trigger: RegenerateTrigger, sql: string): void {
        const applicable = this.isApplicable(seq, trigger);

        if (!applicable) {
            return;
        }

        const editedSinceClick = trigger === "button" && !sameSql(this._host.readEditor(), this._editorAtRequest);

        if (editedSinceClick) {
            return;
        }

        this._generatedSql = sql;
        this._lastFailed   = false;
        this._host.writeEditor(sql);
        this._host.onGenerated(trigger);
    }

    /**
     * Apply a failed generation: a following editor is cleared (so stale SQL
     * that disagrees with the form is never shown or executed), a hand-edited
     * one is kept as typed.
     *
     * @param seq - The request's sequence number.
     * @param trigger - What started the request.
     * @param err - The generation's rejection.
     */
    private applyFailure(seq: number, trigger: RegenerateTrigger, err: unknown): void {
        const applicable = this.isApplicable(seq, trigger);

        if (!applicable) {
            return;
        }

        const follows = this.followsForm();

        if (follows) {
            this._generatedSql = "";
            this._host.writeEditor("");
        }

        this._lastFailed = true;
        this._host.onFailed(err, trigger);
    }
}
