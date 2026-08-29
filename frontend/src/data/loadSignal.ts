// The load-completion awaitable both explorer trees (NavigatorTree, RolesTree)
// hang off: each arms it when its `refresh` starts and settles it when the load
// chain ends, so a caller awaiting `whenSettled()` before a reveal always
// searches a populated tree. Mirrors DiagramView's `whenLaidOut` deferred
// (_layoutSettled / armLayoutSettled / settleLayout in the library), the shape
// this app already uses to wait on an async UI step, factored out here rather
// than written once per tree. Imports nothing at all, so — like treeExpansion.ts
// beside it — this module carries none of the DOM side effects library component
// modules run at import scope and keeps running under the node vitest
// environment.

/**
 * A re-armable "the load finished" awaitable. Arm it when a load starts and
 * settle it when the load chain ends (success or failure); `whenSettled`
 * resolves at once whenever no load is armed.
 */
export class LoadSignal {
    // The armed deferred, or null when idle. Holding the resolver beside its
    // promise is what lets `settle` resolve a promise handed out earlier.
    private _pending: { promise: Promise<void>; resolve: () => void } | null = null;
    // Loads that have armed and not yet settled. The shared deferred resolves
    // when this returns to zero, so overlapping refreshes extend one wait.
    private _armed: number = 0;

    /**
     * Arm the awaitable, counting this load among the outstanding ones. A
     * refresh arriving mid-load increments the count rather than replacing
     * the deferred, so `whenSettled()`'s promise resolves only once every
     * armed load has settled — one still-outstanding load extends the wait
     * for every caller already holding the promise.
     */
    arm(): void {
        this._armed += 1;

        if (this._pending !== null) {
            return;
        }

        let resolve: () => void = () => {};
        const promise = new Promise<void>(r => { resolve = r; });

        this._pending = { promise, resolve };
    }

    /**
     * Settle one armed load. A no-op when nothing is armed (guards against an
     * unmatched call rather than driving the count negative). Resolves the
     * shared deferred only once every armed load has settled.
     */
    settle(): void {
        if (this._armed === 0) {
            return;
        }

        this._armed -= 1;

        if (this._armed > 0) {
            return;
        }

        const pending = this._pending;

        this._pending = null;
        pending?.resolve();
    }

    /**
     * @returns A promise resolving when every currently-armed load has
     * settled; an already-resolved one when no load is armed.
     */
    whenSettled(): Promise<void> {
        return this._pending?.promise ?? Promise.resolve();
    }
}
