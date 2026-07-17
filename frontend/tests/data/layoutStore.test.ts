import { describe, it, expect } from "vitest";
import { LayoutStore } from "../../src/data/layoutStore";
import type { KeyValueStore } from "../../src/data/queryStore";
import type { LayoutSize } from "@jimka/typescript-ui/layout";

/** A trivial in-memory KeyValueStore fake (the node vitest env has no localStorage). */
function fakeStorage(): KeyValueStore & { map: Map<string, string> } {
    const map = new Map<string, string>();

    return {
        map,
        getItem: (key: string): string | null => (map.has(key) ? map.get(key)! : null),
        setItem: (key: string, value: string): void => { map.set(key, value); },
    };
}

describe("LayoutStore — bindSplit", () => {
    it("loadSizes()/loadCollapsed() on empty storage return null / []", () => {
        const layout = new LayoutStore(fakeStorage()).bindSplit("shell");

        expect(layout.loadSizes()).toBeNull();
        expect(layout.loadCollapsed()).toEqual([]);
    });

    it("mixed units round-trip verbatim", () => {
        const layout = new LayoutStore(fakeStorage()).bindSplit("shell");
        const sizes: LayoutSize[] = [{ unit: "px", value: 280 }, { unit: "ratio", value: 1 }];

        layout.onSizes(sizes);

        expect(layout.loadSizes()).toEqual(sizes);
    });

    it("stores under the key sqladmin.layout.<site> with no connection segment", () => {
        const storage = fakeStorage();
        const layout  = new LayoutStore(storage).bindSplit("shell");

        layout.onSizes([{ unit: "px", value: 280 }]);

        expect(storage.map.has("sqladmin.layout.shell")).toBe(true);
    });

    it("one JSON object per site: a second write merges rather than replaces", () => {
        const storage = fakeStorage();
        const layout  = new LayoutStore(storage).bindSplit("shell");
        const sizes: LayoutSize[] = [{ unit: "px", value: 280 }, { unit: "ratio", value: 1 }];

        layout.onSizes(sizes);
        layout.onCollapse(0, true);

        expect(JSON.parse(storage.map.get("sqladmin.layout.shell")!)).toEqual({ sizes, collapsed: [0] });
    });

    it("corrupt JSON is treated as absent, without throwing", () => {
        const storage = fakeStorage();
        storage.map.set("sqladmin.layout.shell", "{not json");
        const layout = new LayoutStore(storage).bindSplit("shell");

        expect(layout.loadSizes()).toBeNull();
        expect(layout.loadCollapsed()).toEqual([]);
    });

    it("a top-level JSON array or string is treated as absent", () => {
        const storage = fakeStorage();

        storage.map.set("sqladmin.layout.shell", "[1,2]");
        expect(new LayoutStore(storage).bindSplit("shell").loadSizes()).toBeNull();

        storage.map.set("sqladmin.layout.shell", "\"hi\"");
        expect(new LayoutStore(storage).bindSplit("shell").loadSizes()).toBeNull();
    });

    it("a write over a corrupt blob repairs it", () => {
        const storage = fakeStorage();
        storage.map.set("sqladmin.layout.shell", "{not json");
        const layout = new LayoutStore(storage).bindSplit("shell");
        const sizes: LayoutSize[] = [{ unit: "px", value: 1 }];

        layout.onSizes(sizes);

        expect(layout.loadSizes()).toEqual(sizes);
    });

    it("a non-array sizes value is rejected", () => {
        const storage = fakeStorage();
        const layout  = new LayoutStore(storage).bindSplit("shell");

        storage.map.set("sqladmin.layout.shell", JSON.stringify({ sizes: "nope" }));
        expect(layout.loadSizes()).toBeNull();

        storage.map.set("sqladmin.layout.shell", JSON.stringify({ sizes: 5 }));
        expect(layout.loadSizes()).toBeNull();

        storage.map.set("sqladmin.layout.shell", JSON.stringify({ sizes: {} }));
        expect(layout.loadSizes()).toBeNull();
    });

    it("a malformed entry rejects the whole array", () => {
        const storage = fakeStorage();
        const layout  = new LayoutStore(storage).bindSplit("shell");
        const cases: unknown[] = [
            [{ unit: "px", value: 1 }, null],
            [{ unit: "bogus", value: 1 }],
            [{ unit: "px" }],
            [5],
            [{ unit: "px", value: NaN }],
            [{ unit: "px", value: -1 }],
        ];

        for (const sizes of cases) {
            storage.map.set("sqladmin.layout.shell", JSON.stringify({ sizes }));
            expect(layout.loadSizes()).toBeNull();
        }
    });

    it("an empty sizes array is rejected", () => {
        const storage = fakeStorage();
        storage.map.set("sqladmin.layout.shell", JSON.stringify({ sizes: [] }));

        expect(new LayoutStore(storage).bindSplit("shell").loadSizes()).toBeNull();
    });

    it("performs no length check — a 3-entry array loads from a 2-pane site", () => {
        const storage = fakeStorage();
        const sizes: LayoutSize[] = [
            { unit: "px", value: 1 }, { unit: "px", value: 2 }, { unit: "px", value: 3 },
        ];
        storage.map.set("sqladmin.layout.shell", JSON.stringify({ sizes }));

        expect(new LayoutStore(storage).bindSplit("shell").loadSizes()).toEqual(sizes);
    });

    it("performs no unit expectation — an all-ratio array loads from the mixed-unit shell site", () => {
        const storage = fakeStorage();
        const sizes: LayoutSize[] = [{ unit: "ratio", value: 0.5 }, { unit: "ratio", value: 0.5 }];
        storage.map.set("sqladmin.layout.shell", JSON.stringify({ sizes }));

        expect(new LayoutStore(storage).bindSplit("shell").loadSizes()).toEqual(sizes);
    });

    it("loads an all-zero array — that discard rule belongs to the library, not the store", () => {
        const storage = fakeStorage();
        const sizes: LayoutSize[] = [{ unit: "px", value: 0 }, { unit: "ratio", value: 0 }];
        storage.map.set("sqladmin.layout.shell", JSON.stringify({ sizes }));

        expect(new LayoutStore(storage).bindSplit("shell").loadSizes()).toEqual(sizes);
    });

    it("onCollapse tracks a sorted, deduped set of indices; onCollapse(-1) is ignored; garbage entries are dropped", () => {
        const storage = fakeStorage();
        const layout  = new LayoutStore(storage).bindSplit("shell");

        layout.onCollapse(0, true);
        layout.onCollapse(1, true);
        expect(layout.loadCollapsed()).toEqual([0, 1]);

        layout.onCollapse(0, true);
        expect(layout.loadCollapsed()).toEqual([0, 1]);

        layout.onCollapse(0, false);
        expect(layout.loadCollapsed()).toEqual([1]);

        layout.onCollapse(-1, true);
        expect(layout.loadCollapsed()).toEqual([1]);

        storage.map.set("sqladmin.layout.shell", JSON.stringify({ collapsed: [0, 1.5, "x", -2] }));
        expect(layout.loadCollapsed()).toEqual([0]);
    });

    it("sites do not cross-read, and a loader is a live read, not a construction snapshot", () => {
        const store = new LayoutStore(fakeStorage());
        const query = store.bindSplit("query");
        const shell = store.bindSplit("shell");

        query.onSizes([{ unit: "px", value: 200 }]);
        expect(shell.loadSizes()).toBeNull();

        const sizes: LayoutSize[] = [{ unit: "px", value: 999 }];
        query.onSizes(sizes);
        expect(query.loadSizes()).toEqual(sizes);
    });
});

describe("LayoutStore — bindAccordion", () => {
    it("loadOpen() on empty storage returns each site's defaults", () => {
        const store = new LayoutStore(fakeStorage());

        expect(store.bindAccordion("structure").loadOpen()).toEqual([true, false, false, false]);
        expect(store.bindAccordion("database").loadOpen()).toEqual([true, true]);
        expect(store.bindAccordion("explainDiagram").loadOpen()).toEqual([true, true, false]);
    });

    it("a wrong-length open array falls back to defaults", () => {
        const storage = fakeStorage();
        storage.map.set("sqladmin.layout.structure", JSON.stringify({ open: [true, true] }));

        expect(new LayoutStore(storage).bindAccordion("structure").loadOpen()).toEqual([true, false, false, false]);
    });

    it("non-boolean entries fall back to defaults", () => {
        const storage = fakeStorage();
        storage.map.set("sqladmin.layout.structure", JSON.stringify({ open: [1, 0, 0, 0] }));

        expect(new LayoutStore(storage).bindAccordion("structure").loadOpen()).toEqual([true, false, false, false]);
    });

    it("onToggle sets one index, leaving the others untouched", () => {
        const layout = new LayoutStore(fakeStorage()).bindAccordion("structure");

        layout.onToggle(1, true);

        expect(layout.loadOpen()).toEqual([true, true, false, false]);
    });

    it("onToggle is index-scoped, not array-flush — two bindings for the same site compose", () => {
        const store = new LayoutStore(fakeStorage());
        const a     = store.bindAccordion("structure");
        const b     = store.bindAccordion("structure");

        a.onToggle(1, true);
        b.onToggle(0, false);

        expect(store.bindAccordion("structure").loadOpen()).toEqual([false, true, false, false]);
    });

    it("an out-of-range onToggle index is ignored", () => {
        const layout = new LayoutStore(fakeStorage()).bindAccordion("structure");

        layout.onToggle(9, true);
        layout.onToggle(-1, true);

        expect(layout.loadOpen()).toEqual([true, false, false, false]);
    });
});
