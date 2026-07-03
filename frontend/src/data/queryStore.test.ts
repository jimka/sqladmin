import { describe, it, expect } from "vitest";
import { QueryHistoryStore, SavedQueryStore } from "./queryStore";
import type { KeyValueStore, HistoryEntry } from "./queryStore";

/** A trivial in-memory KeyValueStore fake (the node vitest env has no localStorage). */
function fakeStorage(): KeyValueStore & { map: Map<string, string> } {
    const map = new Map<string, string>();

    return {
        map,
        getItem: (key: string): string | null => (map.has(key) ? map.get(key)! : null),
        setItem: (key: string, value: string): void => { map.set(key, value); },
    };
}

/** Build a HistoryEntry with sensible defaults for the field under test. */
function entry(sql: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
    return { sql, timestamp: 1, ok: true, rowCount: 0, ...over };
}

describe("QueryHistoryStore", () => {
    it("prepends new entries so list() is newest-first", () => {
        const store = new QueryHistoryStore("default", fakeStorage());

        store.record(entry("select 1"));
        store.record(entry("select 2"));

        expect(store.list().map(e => e.sql)).toEqual(["select 2", "select 1"]);
    });

    it("collapses a consecutive identical sql, updating the head in place", () => {
        const store = new QueryHistoryStore("default", fakeStorage());

        store.record(entry("select 1", { timestamp: 1, rowCount: 3, ok: true }));
        store.record(entry("select 1", { timestamp: 2, rowCount: 9, ok: false }));

        const list = store.list();

        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(entry("select 1", { timestamp: 2, rowCount: 9, ok: false }));
    });

    it("moves a non-consecutive repeat to the head instead of duplicating it", () => {
        const store = new QueryHistoryStore("default", fakeStorage());

        store.record(entry("select 1"));
        store.record(entry("select 2"));
        store.record(entry("select 1", { timestamp: 3, rowCount: 5 }));

        const list = store.list();

        // The re-run "select 1" is promoted to the head with its fresh metadata;
        // the old occurrence is gone, so there is no duplicate.
        expect(list.map(e => e.sql)).toEqual(["select 1", "select 2"]);
        expect(list[0]).toEqual(entry("select 1", { timestamp: 3, rowCount: 5 }));
    });

    it("caps at max, dropping the oldest on overflow", () => {
        const store = new QueryHistoryStore("default", fakeStorage(), 2);

        store.record(entry("a"));
        store.record(entry("b"));
        store.record(entry("c"));

        expect(store.list().map(e => e.sql)).toEqual(["c", "b"]);
    });

    it("returns an empty list on malformed stored JSON (no throw)", () => {
        const storage = fakeStorage();
        storage.map.set("sqladmin.history.default", "{not json");

        const store = new QueryHistoryStore("default", storage);

        expect(store.list()).toEqual([]);
    });

    it("keeps separate lists per connection (no cross-read)", () => {
        const storage = fakeStorage();
        const a = new QueryHistoryStore("connA", storage);
        const b = new QueryHistoryStore("connB", storage);

        a.record(entry("from A"));
        b.record(entry("from B"));

        expect(a.list().map(e => e.sql)).toEqual(["from A"]);
        expect(b.list().map(e => e.sql)).toEqual(["from B"]);
    });

    it("clear() empties the list", () => {
        const store = new QueryHistoryStore("default", fakeStorage());

        store.record(entry("select 1"));
        store.clear();

        expect(store.list()).toEqual([]);
    });
});

describe("SavedQueryStore", () => {
    it("saves and lists named queries sorted by name", () => {
        const store = new SavedQueryStore("default", fakeStorage());

        store.save("beta", "select 2");
        store.save("alpha", "select 1");

        expect(store.list().map(q => q.name)).toEqual(["alpha", "beta"]);
    });

    it("upserts by name — re-saving overwrites, leaving one entry", () => {
        const store = new SavedQueryStore("default", fakeStorage());

        store.save("q", "select 1");
        store.save("q", "select 2");

        expect(store.list()).toHaveLength(1);
        expect(store.get("q")?.sql).toEqual("select 2");
    });

    it("remove() deletes and get() returns undefined for a missing name", () => {
        const store = new SavedQueryStore("default", fakeStorage());

        store.save("q", "select 1");
        store.remove("q");

        expect(store.get("q")).toBeUndefined();
        expect(store.list()).toEqual([]);
    });

    it("keeps separate stores per connection (no cross-read)", () => {
        const storage = fakeStorage();
        const a = new SavedQueryStore("connA", storage);
        const b = new SavedQueryStore("connB", storage);

        a.save("q", "from A");
        b.save("q", "from B");

        expect(a.get("q")?.sql).toEqual("from A");
        expect(b.get("q")?.sql).toEqual("from B");
    });
});
