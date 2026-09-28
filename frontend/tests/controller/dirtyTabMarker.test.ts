// Pins DirtyTabMarker against the plan's `## Expected Behaviour` cases D1-D9
// (plans/implemented/dirty-tab-modified-indicator.md). A plain fake source
// stands in for a Dock identity frame, so each test flips dirty state by hand;
// a spy stands in for Dock.setPanelModified.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { DirtyTabMarker } from "../../src/controller/dirtyTabMarker";

type DirtyListener = (dirty: boolean) => void;

interface FakeSource {
    getId         : () => string;
    isDirty       : () => boolean;
    onDirtyChange : Mock<(listener: DirtyListener) => void>;
    offDirtyChange: Mock<(listener: DirtyListener) => void>;
    /** Set the dirty state and notify every subscribed listener. */
    flip(dirty: boolean): void;
}

/**
 * A fake identity frame with spied dirty-change subscription.
 *
 * @param id - The panel id the frame reports.
 * @param dirty - The initial dirty state.
 * @returns The fake source.
 */
function fakeSource(id: string, dirty: boolean = false): FakeSource {
    const listeners = new Set<DirtyListener>();
    let state       = dirty;

    return {
        getId         : () => id,
        isDirty       : () => state,
        onDirtyChange : vi.fn((l: DirtyListener) => {
            listeners.add(l);
        }),
        offDirtyChange: vi.fn((l: DirtyListener) => {
            listeners.delete(l);
        }),
        flip(d: boolean): void {
            state = d;
            listeners.forEach(l => l(d));
        },
    };
}

let setModified: Mock<(id: string, modified: boolean) => void>;
let marker: DirtyTabMarker;

beforeEach(() => {
    setModified = vi.fn<(id: string, modified: boolean) => void>();
    marker      = new DirtyTabMarker(setModified);
});

describe("DirtyTabMarker.track", () => {
    it("D1: pushes a clean frame's state once and subscribes once", () => {
        const a = fakeSource("a");

        marker.track(a);

        expect(setModified).toHaveBeenCalledTimes(1);
        expect(setModified).toHaveBeenCalledWith("a", false);
        expect(a.onDirtyChange).toHaveBeenCalledTimes(1);
    });

    it("D2: pushes a dirty frame's state once", () => {
        const a = fakeSource("a", true);

        marker.track(a);

        expect(setModified).toHaveBeenCalledTimes(1);
        expect(setModified).toHaveBeenCalledWith("a", true);
    });

    it("D3: mirrors each later dirty change onto the tab", () => {
        const a = fakeSource("a");

        marker.track(a);
        a.flip(true);

        expect(setModified).toHaveBeenLastCalledWith("a", true);

        a.flip(false);

        expect(setModified).toHaveBeenLastCalledWith("a", false);
    });

    it("D4: a repeat track re-syncs without subscribing a second time", () => {
        const a = fakeSource("a");

        marker.track(a);
        marker.track(a);

        expect(a.onDirtyChange).toHaveBeenCalledTimes(1);
        expect(setModified.mock.calls).toEqual([["a", false], ["a", false]]);

        a.flip(true);

        expect(setModified).toHaveBeenCalledTimes(3);
        expect(setModified).toHaveBeenLastCalledWith("a", true);
    });

    it("D9: frames are tracked independently", () => {
        const a = fakeSource("a");
        const b = fakeSource("b");

        marker.track(a);
        marker.track(b);
        setModified.mockClear();
        b.flip(true);

        expect(setModified.mock.calls).toEqual([["b", true]]);
    });
});

describe("DirtyTabMarker.untrack", () => {
    it("D5: removes the very listener track added, so later changes are ignored", () => {
        const a = fakeSource("a");

        marker.track(a);
        marker.untrack(a);

        expect(a.offDirtyChange).toHaveBeenCalledTimes(1);
        expect(a.offDirtyChange.mock.calls[0][0]).toBe(a.onDirtyChange.mock.calls[0][0]);

        const callsBefore = setModified.mock.calls.length;

        a.flip(true);

        expect(setModified).toHaveBeenCalledTimes(callsBefore);
    });

    it("D6: is a no-op for a frame that was never tracked", () => {
        const a = fakeSource("a");

        expect(() => marker.untrack(a)).not.toThrow();
        expect(a.offDirtyChange).not.toHaveBeenCalled();
        expect(setModified).not.toHaveBeenCalled();
    });

    it("D7: does not touch the tab's dot", () => {
        const a = fakeSource("a", true);

        marker.track(a);
        setModified.mockClear();
        marker.untrack(a);

        expect(setModified).not.toHaveBeenCalled();
    });

    it("D8: a frame tracked again after untrack is subscribed afresh", () => {
        const a = fakeSource("a");

        marker.track(a);
        marker.untrack(a);
        marker.track(a);

        expect(a.onDirtyChange).toHaveBeenCalledTimes(2);

        setModified.mockClear();
        a.flip(true);

        expect(setModified.mock.calls).toEqual([["a", true]]);
    });
});
