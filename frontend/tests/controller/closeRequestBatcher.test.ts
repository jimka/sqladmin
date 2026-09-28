// Pins CloseRequestBatcher against the plan's `## Expected Behaviour` cases
// B1-B9 (plans/implemented/dock-beforeclose-unsaved-guard.md). A manual
// scheduler stands in for queueMicrotask, so each test decides exactly when a
// batch flushes; fake vetoes stand in for the Dock's close controllers. A
// last block pins the default scheduler's unbound queueMicrotask call.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { CloseRequestBatcher } from "../../src/controller/closeRequestBatcher";
import type { VetoedClose } from "../../src/controller/closeRequestBatcher";

interface FakeVeto {
    preventDefault: Mock<() => void>;
}

/**
 * A fresh fake close controller.
 *
 * @returns A veto whose preventDefault is a spy.
 */
function fakeVeto(): FakeVeto {
    return { preventDefault: vi.fn<() => void>() };
}

let pending: (() => void) | null;
let schedule: Mock<(flush: () => void) => void>;
let onVetoed: Mock<(close: VetoedClose) => void>;
let batcher: CloseRequestBatcher;

/** Run the flush the scheduler captured, as the microtask would. */
function flush(): void {
    const run = pending;

    pending = null;
    run?.();
}

beforeEach(() => {
    pending  = null;
    schedule = vi.fn((f: () => void) => {
        pending = f;
    });
    onVetoed = vi.fn<(close: VetoedClose) => void>();
    batcher  = new CloseRequestBatcher(onVetoed, schedule);
});

describe("CloseRequestBatcher", () => {
    it("B1: a clean close is neither vetoed nor reported", () => {
        const v = fakeVeto();

        batcher.add("a", false, v);
        flush();

        expect(v.preventDefault).not.toHaveBeenCalled();
        expect(onVetoed).not.toHaveBeenCalled();
    });

    it("B2: a dirty close is vetoed synchronously and reported at flush", () => {
        const v = fakeVeto();

        batcher.add("a", true, v);

        expect(v.preventDefault).toHaveBeenCalledTimes(1);
        expect(onVetoed).not.toHaveBeenCalled();

        flush();

        expect(onVetoed).toHaveBeenCalledTimes(1);
        expect(onVetoed).toHaveBeenCalledWith({ ids: ["a"], dirtyCount: 1 });
    });

    it("B3: a window close with one dirty tab reports every tab of the shared controller", () => {
        const w = fakeVeto();

        batcher.add("a", false, w);
        batcher.add("b", true, w);
        batcher.add("c", false, w);
        flush();

        expect(onVetoed).toHaveBeenCalledTimes(1);
        expect(onVetoed).toHaveBeenCalledWith({ ids: ["a", "b", "c"], dirtyCount: 1 });
    });

    it("B4: a window close with every tab dirty reports once", () => {
        const w = fakeVeto();

        batcher.add("a", true, w);
        batcher.add("b", true, w);
        batcher.add("c", true, w);
        flush();

        expect(onVetoed).toHaveBeenCalledTimes(1);
        expect(onVetoed).toHaveBeenCalledWith({ ids: ["a", "b", "c"], dirtyCount: 3 });
    });

    it("B5: a window close with every tab clean is neither vetoed nor reported", () => {
        const w = fakeVeto();

        batcher.add("a", false, w);
        batcher.add("b", false, w);
        batcher.add("c", false, w);
        flush();

        expect(w.preventDefault).not.toHaveBeenCalled();
        expect(onVetoed).not.toHaveBeenCalled();
    });

    it("B6: a bulk close reports only the tabs whose own controller was vetoed", () => {
        const v1 = fakeVeto();
        const v2 = fakeVeto();
        const v3 = fakeVeto();

        batcher.add("a", false, v1);
        batcher.add("b", true, v2);
        batcher.add("c", true, v3);
        flush();

        expect(v1.preventDefault).not.toHaveBeenCalled();
        expect(onVetoed).toHaveBeenCalledTimes(1);
        expect(onVetoed).toHaveBeenCalledWith({ ids: ["b", "c"], dirtyCount: 2 });
    });

    it("B7: one turn's events schedule exactly one flush", () => {
        const w = fakeVeto();

        batcher.add("a", false, w);
        batcher.add("b", true, w);
        batcher.add("c", false, w);

        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it("B8: separate gestures are separate batches", () => {
        const v1 = fakeVeto();
        const v2 = fakeVeto();

        batcher.add("a", true, v1);
        flush();
        batcher.add("b", true, v2);
        flush();

        expect(schedule).toHaveBeenCalledTimes(2);
        expect(onVetoed).toHaveBeenCalledTimes(2);
        expect(onVetoed).toHaveBeenNthCalledWith(1, { ids: ["a"], dirtyCount: 1 });
        expect(onVetoed).toHaveBeenNthCalledWith(2, { ids: ["b"], dirtyCount: 1 });
    });

    it("B9: a close raised from inside the callback starts a fresh batch", () => {
        const v1 = fakeVeto();
        const v9 = fakeVeto();

        onVetoed.mockImplementationOnce(() => {
            batcher.add("z", true, v9);
        });

        batcher.add("a", true, v1);
        flush();

        expect(schedule).toHaveBeenCalledTimes(2);

        flush();

        expect(onVetoed).toHaveBeenCalledTimes(2);
        expect(onVetoed).toHaveBeenNthCalledWith(2, { ids: ["z"], dirtyCount: 1 });
    });
});

describe("CloseRequestBatcher default scheduler", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("calls queueMicrotask unbound, as a browser requires", () => {
        const queued: (() => void)[] = [];

        // A browser's queueMicrotask throws "Illegal invocation" when called
        // as a method of some other object; Node's does not, so this stub
        // reproduces the browser's receiver check.
        vi.stubGlobal("queueMicrotask", function (this: unknown, callback: () => void): void {
            if (this !== undefined && this !== globalThis) {
                throw new TypeError("Illegal invocation");
            }

            queued.push(callback);
        });

        const vetoed = vi.fn<(close: VetoedClose) => void>();
        const defaultBatcher = new CloseRequestBatcher(vetoed);

        defaultBatcher.add("a", true, fakeVeto());
        queued.forEach(callback => callback());

        expect(vetoed).toHaveBeenCalledWith({ ids: ["a"], dirtyCount: 1 });
    });
});
