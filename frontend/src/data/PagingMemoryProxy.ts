// An in-memory proxy that pages a settable array by page/pageSize, so the
// role-detail grants Table renders one page at a time — a phpMyAdmin-style UX for
// a work-area grid.
//
// It extends the library's MemoryProxy, which already stores the array and
// provides setData plus CRUD. This subclass adds only what MemoryProxy lacks: a
// page-slicing read (MemoryProxy.read ignores pagination and returns the whole
// array) and a total-count report (Proxy.getLastTotalCount returns undefined),
// which the PaginationBar needs to derive the page count. CRUD is inherited but
// unused — the role browser is read-only.

import { MemoryProxy }     from "@jimka/typescript-ui/data";
import type { ReadParams } from "@jimka/typescript-ui/data";

/** Pages over MemoryProxy's in-memory array, reporting the full count for the bar. */
export class PagingMemoryProxy extends MemoryProxy {
    private _lastTotal: number = 0;

    /** Return the requested page slice and record the full count for the bar. */
    async read(params?: ReadParams): Promise<any[]> {
        // super.read() returns a copy of the whole array (MemoryProxy ignores
        // pagination); slice out the requested page from it.
        const all = await super.read();

        this._lastTotal = all.length;

        const page     = params?.page ?? 1;
        const pageSize = params?.pageSize ?? all.length;
        const start    = (page - 1) * pageSize;

        return all.slice(start, start + pageSize);
    }

    /** The full dataset length, so the store can derive the page count. */
    getLastTotalCount(): number {
        return this._lastTotal;
    }
}
