// Pure partition-rule tests for the Clear-action split: which keys "Clear
// SQLAdmin data" removes vs. which "Clear saved connections" removes. This is
// the rule that must never regress (see shell/appStorageKeys.ts's header).

import { describe, expect, it } from "vitest";
import { isAppKey, isDisposableAppKey, isPresetKey } from "../../src/shell/appStorageKeys";

describe("the clear-partition table", () => {
    const rows: { key: string; disposable: boolean; preset: boolean }[] = [
        { key: "sqladmin.history.u.default", disposable: true,  preset: false },
        { key: "sqladmin.saved.u.default",   disposable: true,  preset: false },
        { key: "sqladmin.notes.u.default",   disposable: true,  preset: false },
        { key: "sqladmin.layout.u.dock",     disposable: true,  preset: false },
        { key: "sqladmin.presets",           disposable: false, preset: true },
        { key: "theme",                      disposable: false, preset: false },
    ];

    it("isDisposableAppKey matches the 'Clear SQLAdmin data' column", () => {
        for (const row of rows) {
            expect(isDisposableAppKey(row.key)).toBe(row.disposable);
        }
    });

    it("isPresetKey matches the 'Clear saved connections' column", () => {
        for (const row of rows) {
            expect(isPresetKey(row.key)).toBe(row.preset);
        }
    });

    it("isAppKey is true for every sqladmin.* key and false for an unrelated origin key", () => {
        for (const row of rows) {
            expect(isAppKey(row.key)).toBe(row.key.startsWith("sqladmin."));
        }
    });
});
