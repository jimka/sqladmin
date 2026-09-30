// Custom proxy Writer for the row-CRUD grids. Server-managed (generated)
// columns are stripped from every body, so an INSERT does not fight a
// serial/identity sequence or a generated column. An update sends only the
// changed fields plus the primary key (the library's `'dirty'` mode), so a cell
// nobody edited is never rewritten. `JsonWriter` writes each `Date` in its
// field type's form: a bare date, a time of day, or a local date-time with its
// offset. This is the one bespoke piece of the proxy seam — the read path uses
// the library's configured JsonReader.

import { JsonWriter }                       from "@jimka/typescript-ui/data";
import type { ModelRecord, WriteOperation } from "@jimka/typescript-ui/data";

export class SqlAdminWriter extends JsonWriter {
    /**
     * @param generatedColumns - Names of server-managed columns to strip from
     *   write bodies.
     */
    constructor(private readonly generatedColumns: ReadonlySet<string>) {
        super({ mode: "dirty" });
    }

    /**
     * Choose the record data to write — the changed fields plus the primary key
     * for an update, the whole record otherwise — minus every generated column.
     *
     * @param record - The record being serialized.
     * @param operation - The proxy operation this write is for.
     *
     * @returns The field data to write, keyed by field name.
     */
    protected override dataFor(record: ModelRecord, operation?: WriteOperation): Record<string, any> {
        const data = super.dataFor(record, operation);

        return Object.fromEntries(Object.entries(data).filter(([name]) => !this.generatedColumns.has(name)));
    }
}
