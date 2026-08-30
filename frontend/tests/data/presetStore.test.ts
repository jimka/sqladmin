import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PresetStore } from "../../src/data/presetStore";
import type { ConnectionPreset } from "../../src/contract";

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

// A storage stand-in whose setItem always throws `error` — for pinning a
// write failure that is not the corrupt-blob SyntaxError _withRepair repairs.
// Seeded from `seed` so the write is attempted against real (non-corrupt)
// stored data, and `getItem`'s return proves whether it was ever discarded.
function makeFailingStorage(seed: string | null, error: Error): Storage {
    const map = new Map<string, string>();

    if (seed !== null) {
        map.set(KEY, seed);
    }

    return {
        get length() { return map.size; },
        clear: () => map.clear(),
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: () => { throw error; },
        removeItem: (k: string) => { map.delete(k); },
        key: (i: number) => Array.from(map.keys())[i] ?? null,
    } as Storage;
}

const preset = (name: string, over: Partial<ConnectionPreset> = {}): ConnectionPreset =>
    ({ name, host: "db.host", port: 5432, database: "app", username: "", isDefault: false, ...over });

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

    it("never persists a password field in the stored blob", async () => {
        await new PresetStore().save(preset("Prod"));

        const blob = localStorage.getItem(KEY)!;
        expect(blob).not.toContain("password");

        const stored = JSON.parse(blob)[0];
        expect(stored).toMatchObject({ name: "Prod", host: "db.host", port: 5432, database: "app" });
    });

    it("saves and lists back the username", async () => {
        const store = new PresetStore();
        await store.save(preset("Prod", { username: "alice" }));

        expect(await store.list()).toEqual([preset("Prod", { username: "alice" })]);
    });

    it("backfills username/isDefault on a preset stored before those fields existed", async () => {
        localStorage.setItem(KEY, JSON.stringify([{ name: "Legacy", host: "db.host", port: 5432, database: "app" }]));

        expect(await new PresetStore().list()).toEqual([preset("Legacy")]);
    });

    describe("setDefault", () => {
        it("marks the named preset default and clears any other preset's default flag", async () => {
            const store = new PresetStore();
            await store.save(preset("A", { isDefault: true }));
            await store.save(preset("B"));

            await store.setDefault("B");

            const all = await store.list();
            expect(all.find(p => p.name === "A")?.isDefault).toBe(false);
            expect(all.find(p => p.name === "B")?.isDefault).toBe(true);
        });

        it("clears the current default when passed null", async () => {
            const store = new PresetStore();
            await store.save(preset("A", { isDefault: true }));

            await store.setDefault(null);

            expect((await store.list())[0].isDefault).toBe(false);
        });

        it("no-ops when name matches nothing", async () => {
            const store = new PresetStore();
            await store.save(preset("A", { isDefault: true }));

            await store.setDefault("nope");

            expect((await store.list())[0].isDefault).toBe(true);
        });
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

    it("save() recovers from a SyntaxError on the first write attempt, keeping the retry's data", async () => {
        localStorage.setItem(KEY, "{not valid json");

        const store = new PresetStore();

        await store.save(preset("Fresh"));

        expect((await store.list()).map(p => p.name)).toEqual(["Fresh"]);
    });

    it("propagates a non-SyntaxError write failure, leaving stored presets untouched", async () => {
        const seed = JSON.stringify([preset("Keeper")]);

        vi.stubGlobal("localStorage", makeFailingStorage(seed, new Error("QuotaExceededError")));

        const store = new PresetStore();

        await expect(store.save(preset("New"))).rejects.toThrow("QuotaExceededError");
        expect(localStorage.getItem(KEY)).toBe(seed);
    });
});
