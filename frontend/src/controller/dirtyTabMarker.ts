// Mirrors each open Dock tab's isDirty() onto its tab's "unsaved changes" dot,
// via a callback the controller wires to Dock.setPanelModified. Kept free of
// library imports so node vitest can test it without a DOM (mirroring
// controllerText.ts's own header).

/**
 * The part of a Dock identity frame the marker reads. A library Component
 * satisfies it structurally, so this module needs no library import.
 */
export interface DirtySource {
    getId(): string;
    isDirty(): boolean;
    onDirtyChange(listener: (dirty: boolean) => void): unknown;
    offDirtyChange(listener: (dirty: boolean) => void): unknown;
}

/** Shows (true) or hides (false) the modified dot on panel `id`'s tab. */
export type SetPanelModified = (id: string, modified: boolean) => void;

/**
 * Keeps every tracked identity frame's tab dot in step with the frame's dirty
 * state. The controller tracks a frame on each Dock "attach" and untracks it
 * on "close".
 */
export class DirtyTabMarker {
    private readonly _setModified: SetPanelModified;
    // The dirty-change listener registered on each tracked frame, kept so
    // untrack() can pass the same reference to offDirtyChange.
    private readonly _listeners = new Map<DirtySource, (dirty: boolean) => void>();

    /**
     * @param setModified - Called with a panel id and its dirty state whenever
     *   the dot must change.
     */
    constructor(setModified: SetPanelModified) {
        this._setModified = setModified;
    }

    /**
     * Start mirroring `source`'s dirty state onto its tab. Subscribes only the
     * first time a given source is seen; every call pushes the current state.
     *
     * @param source - The panel's Dock identity frame.
     */
    track(source: DirtySource): void {
        // A panel id is stable for its frame's lifetime, so read it once.
        const id         = source.getId();
        const subscribed = this._listeners.has(source);

        if (!subscribed) {
            const listener = (dirty: boolean): void => {
                this._setModified(id, dirty);
            };

            this._listeners.set(source, listener);
            source.onDirtyChange(listener);
        }

        this._setModified(id, source.isDirty());
    }

    /**
     * Stop mirroring `source`: removes the listener `track` added. A no-op for
     * a source that is not tracked. Does not call `setModified` — the tab is
     * being destroyed.
     *
     * @param source - The panel's Dock identity frame.
     */
    untrack(source: DirtySource): void {
        const listener = this._listeners.get(source);

        if (!listener) {
            return;
        }

        source.offDirtyChange(listener);
        this._listeners.delete(source);
    }
}
