import { describe, it, expect } from "vitest";
import { toCSV, toJSON }        from "./serialize";
import type { ExportColumn }    from "./serialize";

// The CSV dialect: comma delimiter, CRLF record separator, a header row, and
// every line (header included) terminated by CRLF so the string is byte-
// identical to the backend's streamed export of the same wire data.
const CRLF = "\r\n";

describe("toCSV", () => {
    it("emits the header row first, then data rows, each CRLF-terminated", () => {
        const cols: ExportColumn[] = [
            { name: "id", wireType: "number" },
            { name: "name", wireType: "string" },
        ];

        const csv = toCSV(cols, [{ id: 1, name: "ada" }, { id: 2, name: "bob" }]);

        expect(csv).toBe(`id,name${CRLF}1,ada${CRLF}2,bob${CRLF}`);
    });

    it("emits only the header (still CRLF-terminated) for an empty result", () => {
        const cols: ExportColumn[] = [
            { name: "a", wireType: "number" },
            { name: "b", wireType: "string" },
        ];

        expect(toCSV(cols, [])).toBe(`a,b${CRLF}`);
    });

    it("quotes a field with a comma, doubling nothing else", () => {
        const cols: ExportColumn[] = [{ name: "c", wireType: "string" }];

        expect(toCSV(cols, [{ c: "a,b" }])).toBe(`c${CRLF}"a,b"${CRLF}`);
    });

    it("quotes a field with a double quote and doubles the embedded quote", () => {
        const cols: ExportColumn[] = [{ name: "c", wireType: "string" }];

        expect(toCSV(cols, [{ c: 'a"b' }])).toBe(`c${CRLF}"a""b"${CRLF}`);
    });

    it("quotes a field containing CR or LF, keeping the newline inside the field", () => {
        const cols: ExportColumn[] = [{ name: "c", wireType: "string" }];

        expect(toCSV(cols, [{ c: "a\nb" }])).toBe(`c${CRLF}"a\nb"${CRLF}`);
        expect(toCSV(cols, [{ c: "a\rb" }])).toBe(`c${CRLF}"a\rb"${CRLF}`);
    });

    it("renders NULL as a bare empty field but an empty string as a quoted \"\"", () => {
        const cols: ExportColumn[] = [
            { name: "n", wireType: "string" },
            { name: "e", wireType: "string" },
        ];

        // null, undefined, and a missing key all render as bare-empty (NULL);
        // only a real empty string renders as the quoted empty field.
        expect(toCSV(cols, [{ n: null, e: "" }])).toBe(`n,e${CRLF},""${CRLF}`);
        expect(toCSV(cols, [{ e: "" }])).toBe(`n,e${CRLF},""${CRLF}`);
        expect(toCSV(cols, [{ n: undefined, e: "" }])).toBe(`n,e${CRLF},""${CRLF}`);
    });

    it("renders booleans as lowercase true/false", () => {
        const cols: ExportColumn[] = [{ name: "b", wireType: "boolean" }];

        expect(toCSV(cols, [{ b: true }, { b: false }])).toBe(`b${CRLF}true${CRLF}false${CRLF}`);
    });

    it("renders numbers via String(v) with no rounding", () => {
        const cols: ExportColumn[] = [{ name: "n", wireType: "number" }];

        expect(toCSV(cols, [{ n: 42 }, { n: -0.5 }])).toBe(`n${CRLF}42${CRLF}-0.5${CRLF}`);
    });

    it("emits a numeric-as-string (precision string) verbatim", () => {
        const cols: ExportColumn[] = [{ name: "amount", wireType: "string" }];

        expect(toCSV(cols, [{ amount: "123.45000" }])).toBe(`amount${CRLF}123.45000${CRLF}`);
    });

    it("emits an isoString and a base64 string verbatim", () => {
        const cols: ExportColumn[] = [
            { name: "ts", wireType: "isoString" },
            { name: "b", wireType: "base64" },
        ];

        expect(toCSV(cols, [{ ts: "2026-07-02T10:00:00+00:00", b: "AQID" }]))
            .toBe(`ts,b${CRLF}2026-07-02T10:00:00+00:00,AQID${CRLF}`);
    });

    it("serializes json/jsonArray with JSON.stringify, then CSV-escapes it", () => {
        const cols: ExportColumn[] = [
            { name: "j", wireType: "json" },
            { name: "a", wireType: "jsonArray" },
        ];

        // {"a":1} contains a comma and quotes, so it becomes one quoted field
        // with the embedded quotes doubled.
        expect(toCSV(cols, [{ j: { a: 1 }, a: [1, 2] }]))
            .toBe(`j,a${CRLF}"{""a"":1}","[1,2]"${CRLF}`);
    });

    it("keeps non-ASCII in a json field as raw UTF-8 (byte-identical to the backend)", () => {
        const cols: ExportColumn[] = [{ name: "j", wireType: "json" }];

        // JSON.stringify emits raw UTF-8 (not \uXXXX); the backend mirrors this
        // with ensure_ascii=False so the CSV field is byte-identical.
        expect(toCSV(cols, [{ j: { name: "café" } }]))
            .toBe(`j${CRLF}"{""name"":""café""}"${CRLF}`);
    });
});

describe("toJSON", () => {
    it("returns [] for an empty result", () => {
        const cols: ExportColumn[] = [{ name: "a", wireType: "number" }];

        expect(toJSON(cols, [])).toBe("[]");
    });

    it("builds an array of row objects with keys in column order and native types", () => {
        const cols: ExportColumn[] = [
            { name: "id", wireType: "number" },
            { name: "ok", wireType: "boolean" },
            { name: "name", wireType: "string" },
            { name: "meta", wireType: "json" },
            { name: "tags", wireType: "jsonArray" },
            { name: "note", wireType: "string" },
        ];

        const out = toJSON(cols, [
            { id: 1, ok: true, name: "ada", meta: { x: 1 }, tags: ["a", "b"], note: null },
        ]);

        // The parse-round-trip is the load-bearing check: native number/bool,
        // parsed json structures, and JSON null for a SQL NULL.
        expect(JSON.parse(out)).toEqual([
            { id: 1, ok: true, name: "ada", meta: { x: 1 }, tags: ["a", "b"], note: null },
        ]);
    });

    it("keeps column key order and treats a missing key as JSON null", () => {
        const cols: ExportColumn[] = [
            { name: "a", wireType: "number" },
            { name: "b", wireType: "string" },
        ];

        const out = toJSON(cols, [{ b: "x" }]);

        expect(JSON.parse(out)).toEqual([{ a: null, b: "x" }]);
        // Column order: "a" precedes "b" in the serialized text.
        expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    });

    it("pretty-prints with 2-space indentation", () => {
        const cols: ExportColumn[] = [{ name: "a", wireType: "number" }];

        expect(toJSON(cols, [{ a: 1 }])).toBe('[\n  {\n    "a": 1\n  }\n]');
    });
});
