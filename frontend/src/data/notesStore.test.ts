import { describe, it, expect } from "vitest";
import { NotesStore } from "./notesStore";
import type { KeyValueStore } from "./queryStore";

/** A trivial in-memory KeyValueStore fake (the node vitest env has no localStorage). */
function fakeStorage(): KeyValueStore & { map: Map<string, string> } {
    const map = new Map<string, string>();

    return {
        map,
        getItem: (key: string): string | null => (map.has(key) ? map.get(key)! : null),
        setItem: (key: string, value: string): void => { map.set(key, value); },
    };
}

describe("NotesStore", () => {
    it("load() on a fresh store (key absent) returns an empty string", () => {
        const store = new NotesStore("default", fakeStorage());

        expect(store.load()).toEqual("");
    });

    it("save() then load() returns exactly the saved Markdown, including multi-line and non-JSON content", () => {
        const store   = new NotesStore("default", fakeStorage());
        const markdown = "# Title\n\nSome **bold** text.\n- item\n- {not valid json";

        store.save(markdown);

        expect(store.load()).toEqual(markdown);
    });

    it("save() overwrites: a second save replaces the value", () => {
        const store = new NotesStore("default", fakeStorage());

        store.save("first draft");
        store.save("second draft");

        expect(store.load()).toEqual("second draft");
    });

    it("keeps separate notes per connection (no cross-read)", () => {
        const storage = fakeStorage();
        const a = new NotesStore("connA", storage);
        const b = new NotesStore("connB", storage);

        a.save("notes from A");
        b.save("notes from B");

        expect(a.load()).toEqual("notes from A");
        expect(b.load()).toEqual("notes from B");
    });

    it("stores under the key sqladmin.notes.<connectionId>", () => {
        const storage = fakeStorage();
        const store = new NotesStore("default", storage);

        store.save("hello");

        expect(storage.map.get("sqladmin.notes.default")).toEqual("hello");
    });
});
