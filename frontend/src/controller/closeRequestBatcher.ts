// Groups the Dock "beforeclose" events of one user gesture into one batch, so
// the controller's unsaved-changes guard asks once per gesture — a float
// window's chrome ✕ over several dirty tabs, or a tab menu's "Close all" —
// instead of once per tab. Kept free of library imports so node vitest can
// test it without a DOM (mirroring controllerText.ts's own header).

/**
 * The veto handle a Dock "beforeclose" listener receives. Structurally matches both
 * the library's TabCloseController and WindowCloseController, so this module needs
 * no library import.
 */
export interface CloseVeto {
    preventDefault(): void;
}

/** One gesture's vetoed close, handed to the confirm step. */
export interface VetoedClose {
    /** Every panel whose close was vetoed — dirty or clean — in event order. */
    readonly ids: readonly string[];
    /** How many of `ids` are dirty; always at least 1. */
    readonly dirtyCount: number;
}

/** Schedules `flush` to run once the current synchronous turn has finished. */
export type FlushScheduler = (flush: () => void) => void;

// One recorded "beforeclose" event of the pending batch.
interface CloseEvent {
    readonly id   : string;
    readonly dirty: boolean;
    readonly veto : CloseVeto;
}

/**
 * Collects every "beforeclose" event raised in one synchronous turn into one
 * batch. A dirty panel's close is vetoed at once (the veto must be
 * synchronous); once the turn ends, a batch that vetoed anything is reported
 * once, listing every panel whose controller was vetoed — including clean
 * panels of a window close, which share that window's one controller.
 */
export class CloseRequestBatcher {
    private readonly _onVetoed: (close: VetoedClose) => void;
    private readonly _schedule: FlushScheduler;
    // null between turns; the first add() of a turn creates it and schedules a flush.
    private _events: CloseEvent[] | null = null;
    // The controllers this batch has called preventDefault() on.
    private _vetoed: Set<CloseVeto> = new Set();

    /**
     * @param onVetoed - Called once per batch that vetoed at least one close.
     * @param schedule - Defaults to `queueMicrotask`; tests inject a manual one.
     */
    constructor(onVetoed: (close: VetoedClose) => void, schedule: FlushScheduler = queueMicrotask) {
        this._onVetoed = onVetoed;
        this._schedule = schedule;
    }

    /**
     * Record one "beforeclose" event. Vetoes `veto` synchronously when `dirty`.
     *
     * @param id - The closing panel's Dock id.
     * @param dirty - Whether the panel has unsaved changes right now.
     * @param veto - The controller the Dock handed the listener.
     */
    add(id: string, dirty: boolean, veto: CloseVeto): void {
        if (this._events === null) {
            // Called through a local, not as this._schedule(...): the default
            // is the browser's queueMicrotask, which throws "Illegal
            // invocation" when invoked as a method of another object.
            const schedule = this._schedule;

            this._events = [];
            schedule(this.flush);
        }

        this._events.push({ id, dirty, veto });

        if (dirty) {
            veto.preventDefault();
            this._vetoed.add(veto);
        }
    }

    /**
     * End the pending batch and report it when it vetoed anything. Membership
     * is decided here, not per event: a window close's clean first tab only
     * turns out to be vetoed when a later dirty tab vetoes the shared
     * controller. The state is reset before reporting, so a close the callback
     * raises starts a fresh batch. Arrow field: handed to the scheduler by
     * reference.
     */
    private flush = (): void => {
        const events = this._events ?? [];
        const vetoed = this._vetoed;

        this._events = null;
        this._vetoed = new Set();

        const ids        = events.filter(event => vetoed.has(event.veto)).map(event => event.id);
        const dirtyCount = events.filter(event => event.dirty).length;

        if (dirtyCount === 0) {
            return;
        }

        this._onVetoed({ ids, dirtyCount });
    };
}
