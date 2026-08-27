// The pure CSV/JSON import parser, structurally inverting export_format.py's
// (backend) / serialize.ts's (frontend) CSV dialect — see the
// table-data-import plan's "CSV/JSON dialect mirrors this app's own export
// dialect, inverted" Architecture Decision. DOM-free (takes `text: string`,
// already read by the caller via `File.text()`) so it is node-testable, the
// same constraint serialize.ts holds itself to.
//
// A structural problem — a file this app cannot make sense of at all — is
// rejected here, synchronously, before any network round-trip: an
// unsupported extension, a CSV row whose field count doesn't match the
// header, a JSON document that isn't an array of objects. A file column that
// merely names no *table* column, or a cell value that fails to coerce for
// its column's type, is instead a per-row, server-validated concern (see
// PreviewImportRowsQuery) — this module never touches the table's schema.

/** One file's parsed rows, plus the header/key names observed (informational). */
export interface ParsedImport {
    headers: string[];
    rows: Array<Record<string, unknown>>;
}

/** One CSV field's text plus whether it was ever inside a `"..."` pair. */
interface CsvField {
    text: string;
    quoted: boolean;
}

/**
 * Scans `text` into records of raw fields, tracking `inQuotes` so a comma or
 * newline inside a quoted field is not mistaken for a delimiter — the reason
 * this cannot be a `split(",")`. A doubled `"` inside a quoted field is one
 * literal `"`. Records split on `\r\n` (this app's own export dialect) or a
 * bare `\n` (accepted leniently for a file from another tool).
 *
 * @param text - The raw CSV file text.
 * @returns Every record (header included) as an array of raw fields.
 */
function tokenizeCsv(text: string): CsvField[][] {
    const records: CsvField[][] = [];
    let record: CsvField[] = [];
    let field = "";
    let quoted = false;
    let inQuotes = false;
    let i = 0;

    const endField = (): void => {
        record.push({ text: field, quoted });
        field = "";
        quoted = false;
    };
    const endRecord = (): void => {
        endField();
        records.push(record);
        record = [];
    };

    while (i < text.length) {
        const ch = text[i];

        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }

                inQuotes = false;
                i++;
                continue;
            }

            field += ch;
            i++;
            continue;
        }

        if (ch === '"' && field === "") {
            // A quote only opens a quoted field at the field's very start —
            // this app's own export never emits one mid-field unquoted, and
            // RFC 4180 does not define that case either.
            quoted = true;
            inQuotes = true;
            i++;
            continue;
        }

        if (ch === ",") {
            endField();
            i++;
            continue;
        }

        if (ch === "\r" && text[i + 1] === "\n") {
            endRecord();
            i += 2;
            continue;
        }

        if (ch === "\n") {
            endRecord();
            i++;
            continue;
        }

        field += ch;
        i++;
    }

    // A trailing field/record with no closing newline is still real content;
    // an already-terminated file (the common case — this app's own export
    // always ends with \r\n) leaves nothing pending here, so no spurious
    // empty record is appended.
    if (field !== "" || record.length > 0 || quoted) {
        endRecord();
    }

    return records;
}

/**
 * A bare empty field is SQL NULL; a quoted `""` is the empty string — the
 * one distinction a naive parser loses, and the reason this module exists.
 */
function fieldValue(field: CsvField): string | null {
    return !field.quoted && field.text === "" ? null : field.text;
}

/**
 * Parse RFC-4180 CSV text into a header row plus data rows, per this app's
 * own CSV dialect (see the module doc comment).
 *
 * @param text - The raw CSV file text.
 * @throws If a data row's field count does not match the header's, naming
 *   the offending (1-based) row.
 */
function parseCsv(text: string): ParsedImport {
    const records = tokenizeCsv(text);

    if (records.length === 0) {
        return { headers: [], rows: [] };
    }

    const headers = records[0].map(f => f.text);
    const rows: Array<Record<string, unknown>> = [];

    for (let i = 1; i < records.length; i++) {
        const record = records[i];

        if (record.length !== headers.length) {
            throw new Error(`Row ${i}: expected ${headers.length} field(s), got ${record.length}`);
        }

        const row: Record<string, unknown> = {};

        headers.forEach((h, idx) => { row[h] = fieldValue(record[idx]); });
        rows.push(row);
    }

    return { headers, rows };
}

/**
 * Parse a JSON import file: a top-level array of plain row objects, matching
 * this app's own JSON export shape (see Non-Goals: NDJSON and a bare
 * single-object file are both out of scope for v1, and are rejected here
 * with a message naming the expected shape rather than silently
 * misinterpreted).
 *
 * @param text - The raw JSON file text.
 * @throws If the text is not valid JSON, the top level is not an array, or
 *   any element is not a plain object.
 */
function parseJson(text: string): ParsedImport {
    let data: unknown;

    try {
        data = JSON.parse(text);
    } catch (err) {
        throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!Array.isArray(data)) {
        throw new Error("Expected a JSON array of row objects — see the app's own JSON export for the shape.");
    }

    const rows: Array<Record<string, unknown>> = [];
    const headers = new Set<string>();

    data.forEach((item, index) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            const got = item === null ? "null" : Array.isArray(item) ? "an array" : typeof item;

            throw new Error(`Row ${index + 1}: expected a JSON object, got ${got}`);
        }

        const row = item as Record<string, unknown>;

        Object.keys(row).forEach(k => headers.add(k));
        rows.push(row);
    });

    return { headers: [...headers], rows };
}

/**
 * Parse an import file's text into rows, dispatching on `fileName`'s
 * extension.
 *
 * @param fileName - The dropped/picked file's name (only its extension matters).
 * @param text - The file's full text (`File.text()`, read by the caller).
 * @throws If the extension is neither `.csv` nor `.json`, or the format-
 *   specific parse fails (see {@link parseCsv} / {@link parseJson}).
 */
export function parseImportFile(fileName: string, text: string): ParsedImport {
    const dot = fileName.lastIndexOf(".");
    const ext = dot === -1 ? "" : fileName.slice(dot).toLowerCase();

    if (ext === ".csv") {
        return parseCsv(text);
    }

    if (ext === ".json") {
        return parseJson(text);
    }

    throw new Error("Unsupported file type — expected .csv or .json");
}
