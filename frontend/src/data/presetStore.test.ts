import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PresetStore } from "./presetStore";
import type { ConnectionPreset } from "../contract";

// sqladmin's vitest runs the node environment (no DOM), so WebStorageProxy's
// `localStorage` global must be stubbed with a Map-backed stand-in.
function makeStorage(): Storage {
    const map = new Map<string, string>();

    return {
        get length() { return map.size; },
        clear: () => map.clear(),
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => { map.set(k, String(v)); },
        removeItem: (k: string) => { map.delete(k); },
        key: (i: number) => Array.from(map.keys())[i] ?? null,
    } as Storage;
}

const preset = (name: string, over: Partial<ConnectionPreset> = {}): ConnectionPreset =>
    ({ name, host: "db.host", port: 5432, database: "app", ...over });

const KEY = "sqladmin.presets";

beforeEach(() => vi.stubGlobal("localStorage", makeStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("PresetStore", () => {
    it("saves a preset and lists it back", async () => {
        const store = new PresetStore();
        await store.save(preset("Prod"));

        expect(await store.list()).toEqual([preset("Prod")]);
    });

    it("upserts by name (a second save with the same name replaces it)", async () => {
        const store = new PresetStore();
        await store.save(preset("Prod", { host: "old" }));
        await store.save(preset("Prod", { host: "new" }));

        const all = await store.list();
        expect(all).toHaveLength(1);
        expect(all[0].host).toBe("new");
    });

    it("lists presets ordered by name", async () => {
        const store = new PresetStore();
        await store.save(preset("Zeta"));
        await store.save(preset("Alpha"));
        await store.save(preset("Mid"));

        expect((await store.list()).map(p => p.name)).toEqual(["Alpha", "Mid", "Zeta"]);
    });

    it("removes exactly the named preset and no-ops on an absent name", async () => {
        const store = new PresetStore();
        await store.save(preset("A"));
        await store.save(preset("B"));

        await store.remove("A");
        expect((await store.list()).map(p => p.name)).toEqual(["B"]);

        await store.remove("nope"); // no throw, no change
        expect((await store.list()).map(p => p.name)).toEqual(["B"]);
    });

    it("persists across a fresh PresetStore over the same storage (reload)", async () => {
        await new PresetStore().save(preset("Keep"));

        // A brand-new instance reads the same localStorage blob.
        expect((await new PresetStore().list()).map(p => p.name)).toEqual(["Keep"]);
    });

    it("never persists a credential field in the stored blob", async () => {
        await new PresetStore().save(preset("Prod"));

        const blob = localStorage.getItem(KEY)!;
        expect(blob).not.toContain("password");
        expect(blob).not.toContain("username");

        const stored = JSON.parse(blob)[0];
        expect(stored).toMatchObject({ name: "Prod", host: "db.host", port: 5432, database: "app" });
    });

    it("returns [] on a corrupt blob instead of throwing", async () => {
        localStorage.setItem(KEY, "{not valid json");

        expect(await new PresetStore().list()).toEqual([]);
    });

    it("save() recovers from a corrupt blob by discarding it and creating", async () => {
        localStorage.setItem(KEY, "{not valid json");

        const store = new PresetStore();
        await store.save(preset("Fresh")); // must not throw

        expect((await store.list()).map(p => p.name)).toEqual(["Fresh"]);
    });

    it("remove() does not throw on a corrupt blob", async () => {
        localStorage.setItem(KEY, "{not valid json");

        const store = new PresetStore();
        await store.remove("anything"); // must not throw

        expect(await store.list()).toEqual([]);
    });
});
