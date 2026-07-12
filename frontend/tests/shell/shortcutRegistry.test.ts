import { describe, it, expect } from "vitest";
import { SHORTCUTS, groupByCategory } from "./shortcutRegistry";
import type { ShortcutCategory } from "./shortcutRegistry";
import {
    RUN_SHORTCUT, SAVE_SHORTCUT, CLEAR_SHORTCUT, HISTORY_RECALL_SHORTCUT,
    EXPLAIN_SHORTCUT, EXPLAIN_ANALYZE_SHORTCUT,
    NEW_QUERY_SHORTCUT, OPEN_SAVED_SHORTCUT, QUERY_HISTORY_SHORTCUT,
    DATABASES_RAIL_SHORTCUT, ROLES_RAIL_SHORTCUT, QUERIES_RAIL_SHORTCUT,
    REFRESH_SHORTCUT, HELP_SHORTCUT, isHelpChord,
} from "./queryShortcuts";

// The 14 ids the registry must carry: all 13 pre-existing shortcuts plus the new
// Help chord. Pins that no entry is dropped or duplicated as the app grows.
const EXPECTED_IDS = [
    "run", "save", "clear", "history-recall", "explain", "explain-analyze",
    "new-query", "open-saved", "query-history",
    "databases-rail", "roles-rail", "queries-rail", "refresh", "help",
];

describe("SHORTCUTS registry", () => {
    it("carries exactly the 14 expected ids with no duplicates", () => {
        const ids = SHORTCUTS.map(entry => entry.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids].sort()).toEqual([...EXPECTED_IDS].sort());
    });

    it("gives every entry a non-empty keys and label string", () => {
        for (const entry of SHORTCUTS) {
            expect(entry.keys.length).toBeGreaterThan(0);
            expect(entry.label.length).toBeGreaterThan(0);
        }
    });

    it("references the queryShortcuts constants for keys, never literals", () => {
        const byId = new Map(SHORTCUTS.map(entry => [entry.id, entry.keys]));

        expect(byId.get("run")).toBe(RUN_SHORTCUT);
        expect(byId.get("save")).toBe(SAVE_SHORTCUT);
        expect(byId.get("clear")).toBe(CLEAR_SHORTCUT);
        expect(byId.get("history-recall")).toBe(HISTORY_RECALL_SHORTCUT);
        expect(byId.get("explain")).toBe(EXPLAIN_SHORTCUT);
        expect(byId.get("explain-analyze")).toBe(EXPLAIN_ANALYZE_SHORTCUT);
        expect(byId.get("new-query")).toBe(NEW_QUERY_SHORTCUT);
        expect(byId.get("open-saved")).toBe(OPEN_SAVED_SHORTCUT);
        expect(byId.get("query-history")).toBe(QUERY_HISTORY_SHORTCUT);
        expect(byId.get("databases-rail")).toBe(DATABASES_RAIL_SHORTCUT);
        expect(byId.get("roles-rail")).toBe(ROLES_RAIL_SHORTCUT);
        expect(byId.get("queries-rail")).toBe(QUERIES_RAIL_SHORTCUT);
        expect(byId.get("refresh")).toBe(REFRESH_SHORTCUT);
        expect(byId.get("help")).toBe(HELP_SHORTCUT);
    });
});

describe("groupByCategory", () => {
    it("returns the three groups in Editor -> Query -> Navigation order", () => {
        const groups = groupByCategory();

        expect(groups.map(group => group.category)).toEqual(
            ["editor", "query", "navigation"] as ShortcutCategory[]);
        expect(groups.map(group => group.title)).toEqual(
            ["Editor", "Query", "Navigation"]);
    });

    it("groups the entries with counts 6 / 3 / 5", () => {
        const groups = groupByCategory();

        expect(groups.map(group => group.entries.length)).toEqual([6, 3, 5]);
    });

    it("skips empty groups (an empty input yields no groups)", () => {
        expect(groupByCategory([])).toEqual([]);
    });

    it("preserves registry order within a group", () => {
        const editor = groupByCategory().find(group => group.category === "editor");

        expect(editor?.entries.map(entry => entry.id)).toEqual(
            ["run", "save", "clear", "history-recall", "explain", "explain-analyze"]);
    });
});

describe("isHelpChord (modifier/key logic; editable-target verified live)", () => {
    /** A minimal KeyboardEvent-like stub for the non-DOM branches. */
    function keyEvent(partial: Partial<KeyboardEvent>): KeyboardEvent {
        return { ctrlKey: false, metaKey: false, altKey: false, key: "", target: null, ...partial } as KeyboardEvent;
    }

    it("is true for a bare ? with no editable target", () => {
        expect(isHelpChord(keyEvent({ key: "?" }))).toBe(true);
    });

    it("is false for any other key", () => {
        expect(isHelpChord(keyEvent({ key: "a" }))).toBe(false);
    });

    it("is false when ctrl, meta, or alt is held", () => {
        expect(isHelpChord(keyEvent({ key: "?", ctrlKey: true }))).toBe(false);
        expect(isHelpChord(keyEvent({ key: "?", metaKey: true }))).toBe(false);
        expect(isHelpChord(keyEvent({ key: "?", altKey: true }))).toBe(false);
    });
});
