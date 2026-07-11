// Build an AjaxStore for one table's rows.
//
// Uses the SINGLE-BAG AjaxStore form so the store-level options (pageSize,
// remoteSort, remoteFilter) actually apply. `pageSize` is set because the grids
// genuinely paginate; the reader's `mode: "envelope"` (below) makes it parse the
// {rows, totalCount} envelope on its own terms, independent of pagination, so
// the two concerns are no longer coupled.

import { AjaxStore, JsonReader }        from "@jimka/typescript-ui/data";
import type { Model }                   from "@jimka/typescript-ui/data";
import type { ColumnMeta, DbObjectRef } from "../contract";
import { csrfHeader }                   from "./api";
import { SqlAdminWriter }               from "./SqlAdminWriter";

/** Rows per page for the paginated data grids (row-CRUD tables and role grants). */
export const PAGE_SIZE = 100;

/** Build the AjaxStore for a table: JsonReader envelope + SqlAdminWriter. */
export function buildStore(ref: DbObjectRef, model: Model, columns: ColumnMeta[]): AjaxStore {
    const generated = new Set(columns.filter(c => c.isGenerated).map(c => c.name));

    return new AjaxStore({
        model,
        proxy: {
            url: `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/rows`,
            // The session's CSRF token, read at build time (after login has set
            // it). AjaxProxy merges it into every request; write routes require
            // it and read routes ignore it.
            headers: csrfHeader(),
            reader: new JsonReader({ rootProperty: "rows", totalProperty: "totalCount", mode: "envelope" }),
            writer: new SqlAdminWriter(generated),
            // The backend exposes per-record write endpoints (POST /rows with a
            // single object, PUT/DELETE /rows/{id}), so opt out of batch writes.
            batch: false,
        },
        pageSize: PAGE_SIZE,
        remoteSort: true,
        remoteFilter: true,
    });
}
