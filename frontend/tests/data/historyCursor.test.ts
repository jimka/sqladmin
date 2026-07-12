import { describe, it, expect } from "vitest";
import { HistoryCursor } from "./historyCursor";

describe("HistoryCursor", () => {
    it("is inactive before begin() and active after", () => {
        const cursor = new HistoryCursor(["b", "a"]);

        expect(cursor.active).toBe(false);

        cursor.begin("draft");

        expect(cursor.active).toBe(true);
    });

    it("older() walks toward older entries and clamps at the oldest", () => {
        // Snapshot is newest-first: "c" newest, "a" oldest.
        const cursor = new HistoryCursor(["c", "b", "a"]);
        cursor.begin("draft");

        expect(cursor.older()).toBe("c");
        expect(cursor.older()).toBe("b");
        expect(cursor.older()).toBe("a");
        expect(cursor.older()).toBe("a"); // clamps at the oldest
    });

    it("newer() walks back toward the newest and restores the exact draft past it", () => {
        const cursor = new HistoryCursor(["c", "b", "a"]);
        cursor.begin("my draft");

        cursor.older(); // c
        cursor.older(); // b

        expect(cursor.newer()).toBe("c");
        expect(cursor.newer()).toBe("my draft"); // past the newest -> the live draft
        expect(cursor.newer()).toBe("my draft"); // stays on the draft
    });

    it("stays on the draft when history is empty", () => {
        const cursor = new HistoryCursor([]);
        cursor.begin("only draft");

        expect(cursor.older()).toBe("only draft");
        expect(cursor.newer()).toBe("only draft");
    });

    it("treats the draft as the head, skipping a newest entry equal to it", () => {
        // Right after running "c", the editor still holds "c" and the history
        // head is "c"; the first older() should reach the previous query, not
        // re-show "c".
        const cursor = new HistoryCursor(["c", "b", "a"]);
        cursor.begin("c");

        expect(cursor.older()).toBe("b");
        expect(cursor.newer()).toBe("c"); // past the newest -> the live draft
    });

    it("begin() is idempotent — a second call does not recapture the draft", () => {
        const cursor = new HistoryCursor(["a"]);
        cursor.begin("first");
        cursor.older(); // move onto "a"

        cursor.begin("second"); // ignored: already active

        expect(cursor.newer()).toBe("first");
    });
});
