import { describe, it, expect } from "vitest";
import { LoadSignal } from "../../src/data/loadSignal";

/**
 * Whether `promise` has already resolved. Decided after a timer turn — by which
 * point every microtask queued so far has run, including a resolution arriving
 * through a chain of `.then`s — so only a genuinely pending promise reads false.
 *
 * @param promise - The awaitable under test.
 *
 * @returns Whether it resolved before the next timer turn.
 */
async function hasResolved(promise: Promise<void>): Promise<boolean> {
    let resolved = false;

    void promise.then(() => { resolved = true; });

    // 0ms — the next timer turn, which the microtask queue is fully drained
    // before; no shorter wait can tell "resolved" from "pending" at all.
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    return resolved;
}

describe("LoadSignal", () => {
    it("whenSettled() on a fresh signal is already resolved", async () => {
        const signal = new LoadSignal();

        expect(await hasResolved(signal.whenSettled())).toBe(true);
    });

    it("whenSettled() while a load is armed is pending", async () => {
        const signal = new LoadSignal();

        signal.arm();

        expect(await hasResolved(signal.whenSettled())).toBe(false);
    });

    it("settle() resolves the promise handed out while armed", async () => {
        const signal = new LoadSignal();

        signal.arm();

        const settled = signal.whenSettled();

        signal.settle();

        expect(await hasResolved(settled)).toBe(true);
    });

    it("a second arm() extends the wait: one settle() leaves it pending", async () => {
        const signal = new LoadSignal();

        signal.arm();

        const settled = signal.whenSettled();

        signal.arm();
        signal.settle();

        expect(await hasResolved(settled)).toBe(false);
    });

    it("the matching second settle() resolves the extended wait", async () => {
        const signal = new LoadSignal();

        signal.arm();

        const settled = signal.whenSettled();

        signal.arm();
        signal.settle();
        signal.settle();

        expect(await hasResolved(settled)).toBe(true);
    });

    it("whenSettled() hands out the same promise while one load is armed", () => {
        const signal = new LoadSignal();

        signal.arm();

        expect(signal.whenSettled()).toBe(signal.whenSettled());
    });

    it("whenSettled() after the armed load settled is already resolved", async () => {
        const signal = new LoadSignal();

        signal.arm();
        signal.settle();

        expect(await hasResolved(signal.whenSettled())).toBe(true);
    });

    it("settle() with nothing armed does not throw and leaves the signal idle", async () => {
        const signal = new LoadSignal();

        expect(() => signal.settle()).not.toThrow();
        expect(await hasResolved(signal.whenSettled())).toBe(true);
    });

    it("a re-armed signal waits for the new load", async () => {
        const signal = new LoadSignal();

        signal.arm();
        signal.settle();
        signal.arm();

        expect(await hasResolved(signal.whenSettled())).toBe(false);
    });
});
