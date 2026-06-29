// Build an AjaxStore for one table's rows.
//
// Uses the SINGLE-BAG AjaxStore form so the store-level options (pageSize,
// remoteSort, remoteFilter) actually apply. A page size MUST be set: the proxy
// only parses the {rows, totalCount} envelope in paginated mode, so without it
// the reader would expect a top-level array and fail.

import { AjaxStore, JsonReader }        from "@jimka/typescript-ui/data";
import type { Model }                   from "@jimka/typescript-ui/data";
import type { ColumnMeta, DbObjectRef } from "../contract";
import { SqlAdminWriter }               from "./SqlAdminWriter";

const PAGE_SIZE = 100;

/** Build the AjaxStore for a table: JsonReader envelope + SqlAdminWriter. */
export function buildStore(ref: DbObjectRef, model: Model, columns: ColumnMeta[]): AjaxStore {
    const generated = new Set(columns.filter(c => c.isGenerated).map(c => c.name));

    return new AjaxStore({
        model,
        proxy: {
            url: `/api/${ref.connectionId}/${ref.database}/${ref.schema}/${ref.name}/rows`,
            reader: new JsonReader({ rootProperty: "rows", totalProperty: "totalCount" }),
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
