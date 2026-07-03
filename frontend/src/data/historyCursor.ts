// A pure, per-panel bash-style history-navigation cursor. Each QueryPanel owns
// one, constructed from a newest-first snapshot of the shared history plus the
// user's in-progress draft at the bottom of the stack. older() walks back in
// time, newer() forward, and the draft is preserved and restored when the user
// arrows down past the newest entry. No storage, no DOM — a value object, so it
// is red-green testable offline.

// Sentinel index meaning "on the live draft, below the newest history entry".
const DRAFT_INDEX = -1;

/**
 * Bash-style history navigation over a fixed snapshot of past SQL plus the live
 * draft at the bottom of the stack.
 */
export class HistoryCursor {
    private _snapshot: string[];
    private _draft: string = "";
    private _index: number = DRAFT_INDEX;
    private _active: boolean = false;

    /**
     * @param history - A newest-first snapshot of past SQL (the draft is not
     *   included; it is captured by {@link begin}).
     */
    constructor(history: string[]) {
        this._snapshot = history;
    }

    /**
     * Enter navigation from the current draft. Call once when the user starts
     * browsing; a second call while already active is ignored so an in-progress
     * browse keeps its captured draft.
     *
     * The draft is the head of the stack: if the newest history entry is
     * identical to it (the common case right after running the query, which
     * `record()` puts at the history head), that entry is dropped so the first
     * older() step lands on the previous *distinct* query instead of re-showing
     * the text already in the editor.
     *
     * @param draft - The editor's live text, restored past the newest entry.
     */
    begin(draft: string): void {
        if (this._active) {
            return;
        }

        if (this._snapshot.length > 0 && this._snapshot[0] === draft) {
            this._snapshot = this._snapshot.slice(1);
        }

        this._draft  = draft;
        this._index  = DRAFT_INDEX;
        this._active = true;
    }

    /**
     * Step to the previous (older) entry, clamping at the oldest.
     *
     * @returns The older entry's SQL, or the draft when the snapshot is empty.
     */
    older(): string {
        this._index = Math.min(this._index + 1, this._snapshot.length - 1);

        return this._valueAt(this._index);
    }

    /**
     * Step toward the newer entries; past the newest, return to the live draft.
     *
     * @returns The newer entry's SQL, or the draft once below the newest entry.
     */
    newer(): string {
        this._index = Math.max(this._index - 1, DRAFT_INDEX);

        return this._valueAt(this._index);
    }

    /** Whether the cursor is currently navigating (between begin and reset). */
    get active(): boolean {
        return this._active;
    }

    /**
     * Resolve the SQL at a cursor index: the draft at {@link DRAFT_INDEX} (or
     * when the snapshot is empty), else the snapshot entry.
     *
     * @param index - The current cursor index.
     *
     * @returns The SQL to place in the editor.
     */
    private _valueAt(index: number): string {
        if (index < 0 || this._snapshot.length === 0) {
            return this._draft;
        }

        return this._snapshot[index];
    }
}
