import { describe, it, expect } from "vitest";
import {
    isNewQueryChord, isOpenSavedChord, isQueryHistoryChord,
    isDatabasesRailChord, isRolesRailChord, isQueriesRailChord, isRefreshChord,
    isExplainChord, isExplainAnalyzeChord, isHelpChord,
} from "../../src/shell/queryShortcuts";

/** A minimal KeyboardEvent-like stub; every modifier defaults to false. */
function keyEvent(partial: Partial<KeyboardEvent>): KeyboardEvent {
    return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "", target: null, ...partial } as KeyboardEvent;
}

/** One Alt+<letter> chord's matcher and the key that triggers it. */
interface AltChordRow {
    name: string;
    matcher: (event: KeyboardEvent) => boolean;
    key: string;
}

// The seven Alt-chord matchers, driven from one table so a new chord is one row.
const ALT_CHORDS: readonly AltChordRow[] = [
    { name: "isNewQueryChord",       matcher: isNewQueryChord,       key: "n" },
    { name: "isOpenSavedChord",      matcher: isOpenSavedChord,      key: "s" },
    { name: "isQueryHistoryChord",   matcher: isQueryHistoryChord,   key: "h" },
    { name: "isDatabasesRailChord",  matcher: isDatabasesRailChord,  key: "d" },
    { name: "isRolesRailChord",      matcher: isRolesRailChord,      key: "o" },
    { name: "isQueriesRailChord",    matcher: isQueriesRailChord,    key: "q" },
    { name: "isRefreshChord",        matcher: isRefreshChord,        key: "r" },
];

// Every matcher under test, Alt chords plus the Ctrl/Cmd and Help chords —
// used by the mutual-exclusion check (case 8) to assert only one ever fires.
const ALL_MATCHERS: readonly { name: string; matcher: (event: KeyboardEvent) => boolean }[] = [
    ...ALT_CHORDS,
    { name: "isExplainChord",         matcher: isExplainChord },
    { name: "isExplainAnalyzeChord",  matcher: isExplainAnalyzeChord },
    { name: "isHelpChord",            matcher: isHelpChord },
];

describe("Alt-chord matchers", () => {
    it.each(ALT_CHORDS)("$name returns true for its own chord, lowercase and uppercase", ({ matcher, key }) => {
        expect(matcher(keyEvent({ altKey: true, key }))).toBe(true);
        expect(matcher(keyEvent({ altKey: true, key: key.toUpperCase() }))).toBe(true);
    });

    it("the matchers are mutually exclusive: each chord fires exactly its own matcher", () => {
        for (const row of ALT_CHORDS) {
            const event = keyEvent({ altKey: true, key: row.key });

            for (const other of ALL_MATCHERS) {
                expect(other.matcher(event)).toBe(other.name === row.name);
            }
        }
    });

    it.each(ALT_CHORDS)("$name returns false when a second modifier is held, or Alt is absent", ({ matcher, key }) => {
        expect(matcher(keyEvent({ altKey: true, ctrlKey: true, key }))).toBe(false);
        expect(matcher(keyEvent({ altKey: true, metaKey: true, key }))).toBe(false);
        expect(matcher(keyEvent({ altKey: true, shiftKey: true, key }))).toBe(false);
        expect(matcher(keyEvent({ key }))).toBe(false);
    });
});

describe("isExplainChord / isExplainAnalyzeChord", () => {
    it("isExplainChord is true for Ctrl/Cmd+E (either key casing) with no Shift", () => {
        expect(isExplainChord(keyEvent({ ctrlKey: true, key: "e" }))).toBe(true);
        expect(isExplainChord(keyEvent({ metaKey: true, key: "e" }))).toBe(true);
        expect(isExplainChord(keyEvent({ ctrlKey: true, key: "E" }))).toBe(true);
    });

    it("isExplainChord is false when Shift is also held, Alt is also held, no modifier is held, or the key differs", () => {
        expect(isExplainChord(keyEvent({ ctrlKey: true, shiftKey: true, key: "e" }))).toBe(false);
        expect(isExplainChord(keyEvent({ ctrlKey: true, altKey: true, key: "e" }))).toBe(false);
        expect(isExplainChord(keyEvent({ key: "e" }))).toBe(false);
        expect(isExplainChord(keyEvent({ ctrlKey: true, key: "f" }))).toBe(false);
    });

    it("isExplainAnalyzeChord is true for Ctrl/Cmd+Shift+E (either key casing)", () => {
        expect(isExplainAnalyzeChord(keyEvent({ ctrlKey: true, shiftKey: true, key: "e" }))).toBe(true);
        expect(isExplainAnalyzeChord(keyEvent({ metaKey: true, shiftKey: true, key: "E" }))).toBe(true);
    });

    it("isExplainAnalyzeChord is false without Shift, or with Alt also held", () => {
        expect(isExplainAnalyzeChord(keyEvent({ ctrlKey: true, key: "e" }))).toBe(false);
        expect(isExplainAnalyzeChord(keyEvent({ ctrlKey: true, shiftKey: true, altKey: true, key: "e" }))).toBe(false);
    });
});

describe("isHelpChord (modifier/key logic; editable-target branch verified live)", () => {
    it("is true for a bare ? with a null target", () => {
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
