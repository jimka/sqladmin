// An in-memory Proxy that honours page/pageSize, slicing a settable array per
// page (mirroring the library's MiscPanel paginated-table demo proxy). Used to
// page the role-detail rows so the Table never renders more than one page at a
// time — both a phpMyAdmin-style UX and a guard against the library's large
// MemoryStore.loadData render limit (see LIBRARY_NOTES.md).

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
