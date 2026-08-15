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

    /**
     * Arm the awaitable. A no-op while one is already armed, so a refresh
     * arriving mid-load extends the existing wait instead of handing out a
     * second promise the first load's settle would never resolve.
     */
    arm(): void {
        if (this._pending !== null) {
            return;
        }

        let resolve: () => void = () => {};
        const promise = new Promise<void>(r => { resolve = r; });

        this._pending = { promise, resolve };
    }

    /** Settle the armed awaitable, if there is one. A no-op when idle. */
    settle(): void {
        const pending = this._pending;

        this._pending = null;
        pending?.resolve();
    }

    /**
     * @returns A promise resolving when the armed load settles; an
     * already-resolved one when no load is armed.
     */
    whenSettled(): Promise<void> {
        return this._pending?.promise ?? Promise.resolve();
    }
}
