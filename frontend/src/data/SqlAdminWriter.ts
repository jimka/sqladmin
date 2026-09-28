// Custom proxy Writer for the row-CRUD grids. Server-managed (generated)
// columns are stripped from every body, so an INSERT does not fight a
// serial/identity sequence or a generated column. An update sends only the
// changed fields plus the primary key, so a cell nobody edited is never
// rewritten. A zone-less `timestamp` value is written as its local wall clock
// with no offset, the inverse of how the library read it. This is the one
// bespoke piece of the proxy seam — the read path uses the library's
// configured JsonReader.

import type { ModelRecord, WriteOperation, Writer } from "@jimka/typescript-ui/data";

// ISO 8601 writes a calendar year as four digits, the month, day, hour, minute
// and second as two, and milliseconds as three. A JS Date holds nothing finer.
const ISO_YEAR_DIGITS   = 4;
const ISO_FIELD_DIGITS  = 2;
const ISO_MILLIS_DIGITS = 3;

/**
 * Format a `Date` as its local wall clock, `YYYY-MM-DDTHH:MM:SS.sss`, with no
 * offset.
 *
 * @param date - The date to format.
 *
 * @returns The local date and time in ISO 8601 form, without an offset.
 */
function formatWallClock(date: Date): string {
    const pad = (value: number, digits: number = ISO_FIELD_DIGITS): string => String(value).padStart(digits, "0");

    const year   = pad(date.getFullYear(), ISO_YEAR_DIGITS);
    // getMonth() is zero-based; ISO 8601 months start at 1.
    const month  = pad(date.getMonth() + 1);
    const day    = pad(date.getDate());
    const hour   = pad(date.getHours());
    const minute = pad(date.getMinutes());
    const second = pad(date.getSeconds());
    const millis = pad(date.getMilliseconds(), ISO_MILLIS_DIGITS);

    return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}`;
}

export class SqlAdminWriter implements Writer {
    /**
     * @param generatedColumns - Names of server-managed columns to strip from
     *   write bodies.
     * @param zonelessTimestampColumns - Names of `timestamp without time zone`
     *   columns, whose `Date` values are written as their local wall clock.
     */
    constructor(
        private readonly generatedColumns: ReadonlySet<string>,
        private readonly zonelessTimestampColumns: ReadonlySet<string> = new Set(),
    ) {}

    /**
     * Serialize one record: the changed fields plus the primary key for an
     * update, the whole record otherwise.
     *
     * @param record - The record to serialize.
     * @param operation - The proxy operation this write is for.
     *
     * @returns The JSON request body.
     */
    writeRecord(record: ModelRecord, operation?: WriteOperation): string {
        return JSON.stringify(this.toBody(this.dataFor(record, operation)));
    }

    /**
     * Serialize several records, each as {@link writeRecord} would.
     *
     * @param records - The records to serialize.
     * @param operation - The proxy operation this write is for.
     *
     * @returns The JSON request body, an array of objects.
     */
    writeRecords(records: ModelRecord[], operation?: WriteOperation): string {
        return JSON.stringify(records.map(r => this.toBody(this.dataFor(r, operation))));
    }

    /**
     * Drop server-managed columns from a record's data and write each zone-less
     * timestamp as its local wall clock.
     *
     * @param data - The record's field data.
     *
     * @returns The request body object.
     */
    private toBody(data: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(data)) {
            if (this.generatedColumns.has(key)) {
                continue;
            }

            out[key] = value instanceof Date && this.zonelessTimestampColumns.has(key) ? formatWallClock(value) : value;
        }

        return out;
    }

    /**
     * Choose the record data to write, mirroring the library's `JsonWriter`
     * `'dirty'` mode (its `dataFor` is private in 0.10.0, so it cannot be reused).
     *
     * @param record - The record being serialized.
     * @param operation - The proxy operation this write is for.
     *
     * @returns `record.getChangedData()` for an update; otherwise
     *   `record.getData()`.
     */
    private dataFor(record: ModelRecord, operation?: WriteOperation): Record<string, unknown> {
        return operation === "update" ? record.getChangedData() : record.getData();
    }
}
