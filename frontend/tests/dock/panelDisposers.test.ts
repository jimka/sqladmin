import { describe, it, expect } from "vitest";
import { PanelDisposers } from "../../src/dock/panelDisposers";

/** A stand-in panel recording how many times it was disposed. */
function panel(): { dispose: () => void; calls: number } {
    const p = {
        calls  : 0,
        dispose: (): void => {
            p.calls += 1;
        },
    };

    return p;
}

/**
 * A stand-in whose `dispose` is a **prototype method** reading `this`, the
 * shape every library `Component` has. A registry that stored `panel.dispose`
 * detached would call it with no receiver and throw here.
 */
class PrototypeDisposePanel {
    calls = 0;

    dispose(): void {
        this.calls += 1;
    }
}

describe("PanelDisposers.close", () => {
    it("disposes a registered panel exactly once", () => {
        const disposers = new PanelDisposers();
        const p         = panel();

        disposers.register("a", p);
        disposers.close("a");

        expect(p.calls).toBe(1);
    });

    it("is idempotent — a second close disposes nothing further", () => {
        const disposers = new PanelDisposers();
        const p         = panel();

        disposers.register("a", p);
        disposers.close("a");
        disposers.close("a");

        expect(p.calls).toBe(1);
    });

    it("is a no-op for an unknown id", () => {
        const disposers = new PanelDisposers();
        const p         = panel();

        disposers.register("a", p);

        expect(() => disposers.close("nope")).not.toThrow();
        expect(p.calls).toBe(0);
    });

    it("does not dispose a registered panel before its close", () => {
        const disposers = new PanelDisposers();
        const p         = panel();

        disposers.register("a", p);

        expect(p.calls).toBe(0);
    });
});

describe("PanelDisposers.settle", () => {
    it("registers a build that lands while its tab is still open", () => {
        const disposers = new PanelDisposers();
        const p         = panel();

        const token = disposers.beginLoad("a");

        disposers.settle("a", token, p);
        expect(p.calls).toBe(0);

        disposers.close("a");
        expect(p.calls).toBe(1);
    });

    it("disposes a build that lands after its tab closed", () => {
        const disposers = new PanelDisposers();
        const p         = panel();

        const token = disposers.beginLoad("a");

        disposers.close("a");
        disposers.settle("a", token, p);
        expect(p.calls).toBe(1);

        // Nothing was registered, so the close that follows finds nothing.
        disposers.close("a");
        expect(p.calls).toBe(1);
    });

    it("disposes a superseded build and leaves the newer one registered", () => {
        const disposers = new PanelDisposers();
        const first     = panel();
        const second    = panel();

        const firstToken = disposers.beginLoad("a");

        disposers.close("a");

        const secondToken = disposers.beginLoad("a");

        disposers.settle("a", secondToken, second);
        disposers.settle("a", firstToken, first);

        expect(first.calls).toBe(1);
        expect(second.calls).toBe(0);

        disposers.close("a");
        expect(second.calls).toBe(1);
    });
});

describe("PanelDisposers and `this`", () => {
    it("calls dispose on the panel, so a prototype method keeps its receiver", () => {
        const disposers = new PanelDisposers();
        const p         = new PrototypeDisposePanel();

        disposers.register("a", p);
        disposers.close("a");

        expect(p.calls).toBe(1);
    });

    it("keeps the receiver for a panel disposed by settle", () => {
        const disposers = new PanelDisposers();
        const p         = new PrototypeDisposePanel();

        const token = disposers.beginLoad("a");

        disposers.close("a");
        disposers.settle("a", token, p);

        expect(p.calls).toBe(1);
    });
});
