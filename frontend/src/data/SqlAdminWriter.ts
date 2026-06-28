// Custom proxy Writer that omits server-managed (generated) columns from the
// request body, so an INSERT does not fight a serial/identity sequence or a
// generated column. This is the one bespoke piece of the proxy seam — the read
// path uses the library's configured JsonReader.

import type { ModelRecord, Writer } from "@jimka/typescript-ui/data";

export class SqlAdminWriter implements Writer {
    /**
     * @param generatedColumns - Names of server-managed columns to strip from
     *   write bodies.
     */
    constructor(private readonly generatedColumns: ReadonlySet<string>) {}

    writeRecord(record: ModelRecord): string {
        return JSON.stringify(this.strip(record.getData()));
    }

    writeRecords(records: ModelRecord[]): string {
        return JSON.stringify(records.map(r => this.strip(r.getData())));
    }

    /** Drop server-managed columns from a record's data. */
    private strip(data: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(data)) {
            if (!this.generatedColumns.has(key)) {
                out[key] = value;
            }
        }

        return out;
    }
}
