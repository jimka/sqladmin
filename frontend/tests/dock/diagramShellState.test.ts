import { describe, it, expect } from "vitest";
import { DiagramShellState, sameSettle } from "../../src/dock/diagramShellState";
import type { ViewportSettle } from "../../src/dock/diagramShellState";

describe("DiagramShellState seeding and mutation", () => {
    it("defaults getDepthChoice to \"1\" and getDepth to 1 when initialDepth is omitted", () => {
        const state = new DiagramShellState(null);

        expect(state.getDepthChoice()).toBe("1");
        expect(state.getDepth()).toBe(1);
    });

    it("seeds from \"all\", normalizing to \"All\" / positive infinity", () => {
        const state = new DiagramShellState(null, "all");

        expect(state.getDepthChoice()).toBe("All");
        expect(state.getDepth()).toBe(Number.POSITIVE_INFINITY);
    });

    it("falls back to \"1\" for an unrecognized initialDepth", () => {
        const state = new DiagramShellState(null, "9");

        expect(state.getDepthChoice()).toBe("1");
    });

    it("falls back to \"1\" for an unrecognized setDepthChoice value", () => {
        const state = new DiagramShellState(null, "2");

        state.setDepthChoice("9");

        expect(state.getDepthChoice()).toBe("1");
    });

    it("defaults direction to \"both\", prune to false, rootingDisplayed to true", () => {
        const state = new DiagramShellState(null);

        expect(state.getDirection()).toBe("both");
        expect(state.isPrune()).toBe(false);
        expect(state.isRootingDisplayed()).toBe(true);
    });

    it("seeds and reports the given root", () => {
        const state = new DiagramShellState("public.orders");

        expect(state.getRoot()).toBe("public.orders");
    });

    it("setRoot(null) on a rooted state flips visibility().rootedBlock false, leaving rootRow/legend true", () => {
        const state = new DiagramShellState("orders");

        state.setRoot(null);

        expect(state.visibility()).toEqual({ rootRow: true, legend: true, rootedBlock: false });
    });

    it("setDirection/setPrune/setRootingDisplayed adopt their new values", () => {
        const state = new DiagramShellState(null);

        state.setDirection("upstream");
        state.setPrune(true);
        state.setRootingDisplayed(false);

        expect(state.getDirection()).toBe("upstream");
        expect(state.isPrune()).toBe(true);
        expect(state.isRootingDisplayed()).toBe(false);
    });
});

describe("DiagramShellState.visibility()", () => {
    it("rootingDisplayed=true, root=null -> rootRow/legend shown, rootedBlock hidden", () => {
        const state = new DiagramShellState(null);

        expect(state.visibility()).toEqual({ rootRow: true, legend: true, rootedBlock: false });
    });

    it("rootingDisplayed=true, root set -> all three shown", () => {
        const state = new DiagramShellState("orders");

        expect(state.visibility()).toEqual({ rootRow: true, legend: true, rootedBlock: true });
    });

    it("rootingDisplayed=false, root set -> all three hidden", () => {
        const state = new DiagramShellState("orders");

        state.setRootingDisplayed(false);

        expect(state.visibility()).toEqual({ rootRow: false, legend: false, rootedBlock: false });
    });

    it("rootingDisplayed=false, root=null -> all three hidden", () => {
        const state = new DiagramShellState(null);

        state.setRootingDisplayed(false);

        expect(state.visibility()).toEqual({ rootRow: false, legend: false, rootedBlock: false });
    });
});

describe("DiagramShellState.settle()", () => {
    it("rootingDisplayed=true, root set -> focus that root", () => {
        const state = new DiagramShellState("public.invoices");

        expect(state.settle()).toEqual({ kind: "focus", nodeId: "public.invoices" });
    });

    it("rootingDisplayed=true, root=null -> fit", () => {
        const state = new DiagramShellState(null);

        expect(state.settle()).toEqual({ kind: "fit" });
    });

    it("rootingDisplayed=false, root set -> fit (the Overview case that was wrong before this fix)", () => {
        const state = new DiagramShellState("public.invoices");

        state.setRootingDisplayed(false);

        expect(state.settle()).toEqual({ kind: "fit" });
    });

    it("rootingDisplayed=false, root=null -> fit", () => {
        const state = new DiagramShellState(null);

        state.setRootingDisplayed(false);

        expect(state.settle()).toEqual({ kind: "fit" });
    });
});

describe("sameSettle", () => {
    const fit: ViewportSettle = { kind: "fit" };
    const focusA: ViewportSettle = { kind: "focus", nodeId: "a" };
    const focusA2: ViewportSettle = { kind: "focus", nodeId: "a" };
    const focusB: ViewportSettle = { kind: "focus", nodeId: "b" };

    it("two fits are the same", () => {
        expect(sameSettle(fit, fit)).toBe(true);
    });

    it("a fit and a focus are different", () => {
        expect(sameSettle(fit, focusA)).toBe(false);
    });

    it("two focuses on the same node are the same", () => {
        expect(sameSettle(focusA, focusA2)).toBe(true);
    });

    it("two focuses on different nodes are different", () => {
        expect(sameSettle(focusA, focusB)).toBe(false);
    });
});
