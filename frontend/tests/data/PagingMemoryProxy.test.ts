import { describe, it, expect } from "vitest";
import { PagingMemoryProxy } from "../../src/data/PagingMemoryProxy";

/** n rows shaped { i: 0 }, { i: 1 }, … for slice assertions. */
function rows(n: number): { i: number }[] {
    return Array.from({ length: n }, (_, i) => ({ i }));
}

describe("PagingMemoryProxy", () => {
    it("returns the requested page slice, including a partial last page", async () => {
        const proxy = new PagingMemoryProxy();
        proxy.setData(rows(5));

        expect(await proxy.read({ page: 1, pageSize: 2 })).toEqual([{ i: 0 }, { i: 1 }]);
        expect(await proxy.read({ page: 2, pageSize: 2 })).toEqual([{ i: 2 }, { i: 3 }]);
        expect(await proxy.read({ page: 3, pageSize: 2 })).toEqual([{ i: 4 }]);
    });

    it("returns an empty slice for a page past the end", async () => {
        const proxy = new PagingMemoryProxy();
        proxy.setData(rows(3));

        expect(await proxy.read({ page: 5, pageSize: 2 })).toEqual([]);
    });

    it("returns all rows when no pageSize is given", async () => {
        const proxy = new PagingMemoryProxy();
        proxy.setData(rows(4));

        expect(await proxy.read()).toEqual(rows(4));
    });

    it("reports the full dataset length via getLastTotalCount after a read", async () => {
        const proxy = new PagingMemoryProxy();
        proxy.setData(rows(7));

        await proxy.read({ page: 1, pageSize: 2 });

        expect(proxy.getLastTotalCount()).toBe(7);
    });

    it("handles an empty dataset", async () => {
        const proxy = new PagingMemoryProxy();
        proxy.setData([]);

        expect(await proxy.read({ page: 1, pageSize: 10 })).toEqual([]);
        expect(proxy.getLastTotalCount()).toBe(0);
    });

    it("reflects a replaced dataset on the next read", async () => {
        const proxy = new PagingMemoryProxy();
        proxy.setData(rows(2));
        await proxy.read({ page: 1, pageSize: 10 });

        proxy.setData(rows(20));
        await proxy.read({ page: 1, pageSize: 10 });

        expect(proxy.getLastTotalCount()).toBe(20);
    });
});
