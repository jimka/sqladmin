// An in-memory Proxy that honours page/pageSize, slicing a settable array per
// page so the role-detail grants Table renders one page at a time — a
// phpMyAdmin-style UX for a work-area grid.
//
// Ideally this would `extend MemoryProxy` — which already stores the array and
// provides setData/CRUD — and add only the page slice plus total-count report.
// But an external consumer that subclasses a library class does NOT inherit the
// base's concrete instance members through the built .d.ts: `class X extends
// MemoryProxy` sees no `setData`, even though a direct `new MemoryProxy()` does
// (the same external-subclassing papercut LIBRARY_NOTES records for
// `Panel.addComponent`, here confirmed on a data class). So this extends the
// abstract `Proxy` and stores the array itself; CRUD is unused (read-only).

import { Proxy }            from "@jimka/typescript-ui/data";
import type { ReadParams }  from "@jimka/typescript-ui/data";
import type { ModelRecord } from "@jimka/typescript-ui/data";

/** Pages over an in-memory array; CRUD is unused (the role browser is read-only). */
export class PagingMemoryProxy extends Proxy {
    private _data: any[] = [];
    private _lastTotal: number = 0;

    /** Replace the full dataset paged over by subsequent reads. */
    setData(data: any[]): void {
        this._data = data;
    }

    /** Return the requested page slice and record the full count for the bar. */
    read(params?: ReadParams): Promise<any[]> {
        const page     = params?.page ?? 1;
        const pageSize = params?.pageSize ?? this._data.length;
        const start    = (page - 1) * pageSize;

        this._lastTotal = this._data.length;

        return Promise.resolve(this._data.slice(start, start + pageSize));
    }

    /** The full dataset length, so the store can derive the page count. */
    getLastTotalCount(): number {
        return this._lastTotal;
    }

    create(_record: ModelRecord): Promise<Record<string, any>> {
        return Promise.resolve({});
    }

    update(_record: ModelRecord): Promise<Record<string, any>> {
        return Promise.resolve({});
    }

    destroy(_record: ModelRecord): Promise<void> {
        return Promise.resolve();
    }
}
