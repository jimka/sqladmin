// Pins querySaveFlow against the plan's `## Expected Behaviour` -> *Save flow*
// cases S1-S10 (plans/in-progress/query-save-vs-save-as.md). A Map-backed fake
// stands in for SavedQueryStore, and scripted promptName/confirmReplace
// functions queue answers and record what they were asked — mirroring
// closeRequestBatcher.test.ts's manual-scheduler style for a pure, injected
// controller module.

import { describe, it, expect, vi } from "vitest";
import { saveQuery, saveQueryAs } from "../../src/controller/querySaveFlow";
import type { QuerySaveDeps, SavedQueryTarget } from "../../src/controller/querySaveFlow";
import type { SavedQuery } from "../../src/data/queryStore";

/** A Map-backed fake implementing the store surface `querySaveFlow` needs. */
function fakeStore(seed: Record<string, string> = {}): SavedQueryTarget & { map: Map<string, SavedQuery> } {
    const map = new Map<string, SavedQuery>();

    for (const [name, sql] of Object.entries(seed)) {
        map.set(name, { name, sql, savedAt: 0 });
    }

    return {
        map,
        get : name => map.get(name),
        save: (name, sql) => { map.set(name, { name, sql, savedAt: Date.now() }); },
    };
}

/**
 * A scripted `promptName`: resolves each call with the next queued answer (or
 * `null` once exhausted), recording every `defaultName` it was asked with.
 */
function scriptedPrompt(...answers: (string | null)[]): { promptName: QuerySaveDeps["promptName"]; asked: string[] } {
    const asked: string[] = [];
    let next = 0;

    return {
        asked,
        promptName: async defaultName => {
            asked.push(defaultName);

            return answers[next++] ?? null;
        },
    };
}

/**
 * A scripted `confirmReplace`: resolves each call with the next queued answer
 * (or `false` once exhausted), recording every name it was asked about.
 */
function scriptedConfirm(...answers: boolean[]): { confirmReplace: QuerySaveDeps["confirmReplace"]; asked: string[] } {
    const asked: string[] = [];
    let next = 0;

    return {
        asked,
        confirmReplace: async name => {
            asked.push(name);

            return answers[next++] ?? false;
        },
    };
}

const SQL = "SELECT 1";

describe("saveQuery", () => {
    it("S1: saves to the existing link with no prompt", async () => {
        const store   = fakeStore({ a: "old" });
        const prompt  = scriptedPrompt();
        const confirm = scriptedConfirm();
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        const result = await saveQuery(deps, SQL, "a");

        expect(result).toBe("a");
        expect(store.map.get("a")?.sql).toBe(SQL);
        expect(prompt.asked).toEqual([]);
    });

    it("S2: falls through to saveQueryAs when unlinked", async () => {
        const store   = fakeStore();
        const prompt  = scriptedPrompt("b");
        const confirm = scriptedConfirm();
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        const result = await saveQuery(deps, SQL, null);

        expect(result).toBe("b");
        expect(store.map.get("b")?.sql).toBe(SQL);
        expect(prompt.asked).toEqual([""]);
    });

    it("S3: falls through to saveQueryAs when the linked query was removed, prefilled with the old name", async () => {
        const store   = fakeStore();
        const prompt  = scriptedPrompt("a");
        const confirm = scriptedConfirm();
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        const result = await saveQuery(deps, SQL, "a");

        expect(result).toBe("a");
        expect(store.map.get("a")?.sql).toBe(SQL);
        expect(prompt.asked).toEqual(["a"]);
        expect(confirm.asked).toEqual([]);
    });

    it("S10: does not prompt when the link still exists", async () => {
        const store   = fakeStore({ a: "old" });
        const prompt  = scriptedPrompt();
        const confirm = scriptedConfirm();
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        await saveQuery(deps, SQL, "a");

        expect(prompt.asked).toEqual([]);
    });
});

describe("saveQueryAs", () => {
    it("S4: a cancelled prompt saves nothing", async () => {
        const store   = fakeStore();
        const prompt  = scriptedPrompt(null);
        const confirm = scriptedConfirm();
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        const result = await saveQueryAs(deps, SQL, null);

        expect(result).toBeNull();
        expect(store.map.size).toBe(0);
    });

    it("S5: replacing another query confirms first, then saves", async () => {
        const store   = fakeStore({ b: "old" });
        const prompt  = scriptedPrompt("b");
        const confirm = scriptedConfirm(true);
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        const result = await saveQueryAs(deps, SQL, null);

        expect(result).toBe("b");
        expect(store.map.get("b")?.sql).toBe(SQL);
        expect(confirm.asked).toEqual(["b"]);
    });

    it("S6: declining the replace confirm returns to the name prompt, prefilled with the declined name", async () => {
        const store   = fakeStore({ b: "old" });
        const prompt  = scriptedPrompt("b", "c");
        const confirm = scriptedConfirm(false);
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        const result = await saveQueryAs(deps, SQL, null);

        expect(result).toBe("c");
        expect(store.map.get("b")?.sql).toBe("old");
        expect(store.map.get("c")?.sql).toBe(SQL);
        expect(prompt.asked).toEqual(["", "b"]);
    });

    it("S7: declining the replace confirm then cancelling the name prompt saves nothing", async () => {
        const store   = fakeStore({ b: "old" });
        const prompt  = scriptedPrompt("b", null);
        const confirm = scriptedConfirm(false);
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        const result = await saveQueryAs(deps, SQL, null);

        expect(result).toBeNull();
        expect(store.map.get("b")?.sql).toBe("old");
    });

    it("S8: entering the tab's own linked name saves with no replace confirm", async () => {
        const store   = fakeStore({ a: "old" });
        const prompt  = scriptedPrompt("a");
        const confirm = scriptedConfirm();
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        const result = await saveQueryAs(deps, SQL, "a");

        expect(result).toBe("a");
        expect(store.map.get("a")?.sql).toBe(SQL);
        expect(prompt.asked).toEqual(["a"]);
        expect(confirm.asked).toEqual([]);
    });

    it("S9: entering a different existing name confirms, then saves under it, leaving the link's query unchanged", async () => {
        const store   = fakeStore({ a: "old-a", b: "old-b" });
        const prompt  = scriptedPrompt("b");
        const confirm = scriptedConfirm(true);
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm.confirmReplace };

        const result = await saveQueryAs(deps, SQL, "a");

        expect(result).toBe("b");
        expect(store.map.get("b")?.sql).toBe(SQL);
        expect(store.map.get("a")?.sql).toBe("old-a");
    });

    it("never calls confirmReplace when the name does not already exist", async () => {
        const store   = fakeStore();
        const prompt  = scriptedPrompt("fresh");
        const confirm = vi.fn();
        const deps: QuerySaveDeps = { store, promptName: prompt.promptName, confirmReplace: confirm };

        await saveQueryAs(deps, SQL, null);

        expect(confirm).not.toHaveBeenCalled();
    });
});
