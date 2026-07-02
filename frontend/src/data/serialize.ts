// The shared, pure serialization core for result export. Turns (columns, rows)
// of wire scalars into a CSV or JSON string. It is DOM-free and node-testable —
// the download trigger lives in download.ts so this module stays pure.
//
// The library's TableExporter is deliberately NOT reused: it formats Date values
// through the browser locale and collapses NULL and "" to the same empty field.
// A SQL export must be stable and lossless (ISO timestamps, precision numerics)
// and must keep NULL distinguishable from an empty string, so the app owns this
// dialect and mirrors it in the backend (backend/app/export_format.py).
//
// Byte-identity with the backend export holds for every wire type EXCEPT
// floating-point `number` values. These query rows have already crossed JSON
// transport, so a `double precision` 1.0 arrives here as the JS number 1
// (String(1) === "1") while the backend streams the native float (str(1.0) ===
// "1.0"); exponent notation likewise differs (1e16 vs 1e+16). That loss is
// inherent to the query path (the rows are JS numbers), not this serializer, so
// the backend full-table export is the authoritative full-fidelity surface.
// String-based types stay byte-identical: numeric/decimal/money arrive as
// precision strings, timestamps as ISO, bytea as base64, and non-float json is
// stringified identically (with raw UTF-8 on both sides).

import type { WireType } from "../contract";

// The CSV dialect (RFC 4180): comma delimiter, CRLF record separator. Every line
// (the header included) is CRLF-terminated so the output is byte-identical to the
// backend's streamed export of the same wire data.
const CSV_DELIM = ",";
const CSV_EOL   = "\r\n";

/** A column to export: its name and the wire scalar its values arrive as. */
export interface ExportColumn {
    name:     string;
    wireType: WireType;
}

/** One CSV field's text plus whether it originated from a SQL NULL. */
interface CsvCell {
    text:   string;
    isNull: boolean;
}

/**
 * Render one wire value to its CSV field text. A SQL NULL (`null`, `undefined`,
 * or a missing key) yields `isNull` so the field-escaper emits it bare (unquoted)
 * — the one rule that keeps NULL distinguishable from an empty string.
 *
 * @param value - The wire scalar read from the row object.
 * @param wireType - The column's wire type, selecting the rendering.
 *
 * @returns The field text and whether the value was NULL.
 */
function csvCell(value: unknown, wireType: WireType): CsvCell {
    if (value === null || value === undefined) {
        return { text: "", isNull: true };
    }

    switch (wireType) {
        case "boolean":
            return { text: value ? "true" : "false", isNull: false };

        case "json":
        case "jsonArray":
            return { text: JSON.stringify(value), isNull: false };

        default:
            // number / string (incl. precision numerics) / isoString / base64:
            // the wire string verbatim, so no locale drift. A `number` here is a
            // JS number (already JSON-parsed), so String() gives its shortest
            // round-trip form — which may differ from the backend's native-float
            // rendering for floats (see the module header's byte-identity note).
            return { text: String(value), isNull: false };
    }
}

/**
 * RFC-4180 field escape: quote the field iff it contains a comma, a double
 * quote, a CR, or an LF, doubling any embedded quote. A NULL emits a bare empty
 * field; an empty string emits a quoted `""`, keeping the two distinguishable.
 *
 * @param text - The rendered field text.
 * @param isNull - Whether the value was a SQL NULL.
 *
 * @returns The escaped CSV field.
 */
function escapeField(text: string, isNull: boolean): string {
    if (isNull) {
        return "";
    }

    if (text === "" || /[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
}

/**
 * Render one row to a CSV record: each column's value cell, field-escaped and
 * comma-joined.
 *
 * @param row - The row object keyed by column name.
 * @param columns - The columns to emit, in order.
 *
 * @returns The comma-joined CSV record (no trailing EOL).
 */
function csvRecord(row: Record<string, unknown>, columns: ExportColumn[]): string {
    return columns
        .map(c => {
            const cell = csvCell(row[c.name], c.wireType);

            return escapeField(cell.text, cell.isNull);
        })
        .join(CSV_DELIM);
}

/**
 * Serialize rows of wire scalars to an RFC-4180 CSV string (header + data). The
 * header row is always emitted first (so an empty result still recovers the
 * columns), and every line including the header is CRLF-terminated.
 *
 * @param columns - The export columns, in output order.
 * @param rows - The wire-scalar rows to serialize.
 *
 * @returns The CSV text.
 */
export function toCSV(columns: ExportColumn[], rows: Record<string, unknown>[]): string {
    const header = columns.map(c => escapeField(c.name, false)).join(CSV_DELIM);
    const lines  = [header, ...rows.map(r => csvRecord(r, columns))];

    return lines.map(line => line + CSV_EOL).join("");
}

/**
 * Render one wire value to its native JSON value: a SQL NULL (`null`,
 * `undefined`, or a missing key) becomes JSON `null`, and every other wire
 * scalar is already its own native JSON type — numbers/booleans/json/jsonArray
 * as themselves, string/isoString/base64 (incl. precision numerics) as strings.
 *
 * @param value - The wire scalar read from the row object.
 *
 * @returns The value to place in the JSON row object.
 */
function jsonCell(value: unknown): unknown {
    return value === null || value === undefined ? null : value;
}

/**
 * Serialize rows of wire scalars to a pretty-printed JSON array of objects, one
 * object per row with keys in column order. An empty result serializes to `[]`.
 *
 * @param columns - The export columns, in output (key) order.
 * @param rows - The wire-scalar rows to serialize.
 *
 * @returns The pretty-printed (2-space) JSON text.
 */
export function toJSON(columns: ExportColumn[], rows: Record<string, unknown>[]): string {
    const data = rows.map(row =>
        Object.fromEntries(columns.map(c => [c.name, jsonCell(row[c.name])])),
    );

    // 2-space indentation: these are downloads a user opens, matching the JSON
    // the library's own exporter emits for human-readability.
    return JSON.stringify(data, null, 2);
}
