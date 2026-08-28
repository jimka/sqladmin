import { describe, it, expect } from "vitest";
import { parseImportFile } from "../../src/data/parseImport";

const CRLF = "\r\n";

describe("parseImportFile — unsupported extension", () => {
    it("throws for a file that is neither .csv nor .json", () => {
        expect(() => parseImportFile("data.txt", "a,b")).toThrow(/Unsupported file type/);
    });

    it("is case-insensitive on the extension", () => {
        const result = parseImportFile("DATA.CSV", `id${CRLF}1${CRLF}`);

        expect(result.rows).toEqual([{ id: "1" }]);
    });
});

describe("parseImportFile — CSV", () => {
    it("parses a header and data rows", () => {
        const text = `id,name${CRLF}1,ada${CRLF}2,bob${CRLF}`;

        expect(parseImportFile("t.csv", text)).toEqual({
            headers: ["id", "name"],
            rows: [{ id: "1", name: "ada" }, { id: "2", name: "bob" }],
        });
    });

    it("parses a bare empty field as null (SQL NULL)", () => {
        const text = `a,b${CRLF},x${CRLF}`;

        expect(parseImportFile("t.csv", text).rows).toEqual([{ a: null, b: "x" }]);
    });

    it("parses a quoted empty field as the empty string, distinct from null", () => {
        const text = `a,b${CRLF}"",x${CRLF}`;

        expect(parseImportFile("t.csv", text).rows).toEqual([{ a: "", b: "x" }]);
    });

    it("keeps a comma inside a quoted field literal", () => {
        const text = `a${CRLF}"x,y"${CRLF}`;

        expect(parseImportFile("t.csv", text).rows).toEqual([{ a: "x,y" }]);
    });

    it("unescapes a doubled quote inside a quoted field to one literal quote", () => {
        const text = `a${CRLF}"say ""hi"""${CRLF}`;

        expect(parseImportFile("t.csv", text).rows).toEqual([{ a: 'say "hi"' }]);
    });

    it("keeps an embedded newline inside a quoted field literal", () => {
        const text = `a${CRLF}"line1\nline2"${CRLF}`;

        expect(parseImportFile("t.csv", text).rows).toEqual([{ a: "line1\nline2" }]);
    });

    it("accepts a bare \\n record separator leniently", () => {
        const text = "a,b\n1,x\n2,y\n";

        expect(parseImportFile("t.csv", text).rows).toEqual([{ a: "1", b: "x" }, { a: "2", b: "y" }]);
    });

    it("parses a trailing record with no closing newline", () => {
        const text = `a${CRLF}1${CRLF}2`;

        expect(parseImportFile("t.csv", text).rows).toEqual([{ a: "1" }, { a: "2" }]);
    });

    it("round-trips this app's own CSV export dialect (quoted vs bare empty)", () => {
        // Mirrors export_format.py's _csv_field / serialize.ts's csvCell: a SQL
        // NULL round-trips through a bare empty field, an empty string through
        // a quoted "".
        const text = `id,note${CRLF}1,${CRLF}2,""${CRLF}`;

        expect(parseImportFile("t.csv", text).rows).toEqual([
            { id: "1", note: null },
            { id: "2", note: "" },
        ]);
    });

    it("throws naming the row when a data row's field count does not match the header", () => {
        const text = `a,b${CRLF}1,2,3${CRLF}`;

        expect(() => parseImportFile("t.csv", text)).toThrow(/Row 1/);
    });

    it("returns empty headers/rows for empty text", () => {
        expect(parseImportFile("t.csv", "")).toEqual({ headers: [], rows: [] });
    });
});

describe("parseImportFile — JSON", () => {
    it("parses an array of row objects", () => {
        const text = JSON.stringify([{ id: 1, name: "ada" }, { id: 2, name: "bob" }]);

        expect(parseImportFile("t.json", text)).toEqual({
            headers: ["id", "name"],
            rows: [{ id: 1, name: "ada" }, { id: 2, name: "bob" }],
        });
    });

    it("throws for invalid JSON text", () => {
        expect(() => parseImportFile("t.json", "{not json")).toThrow(/Invalid JSON/);
    });

    it("throws when the top level is not an array (a bare object)", () => {
        expect(() => parseImportFile("t.json", JSON.stringify({ id: 1 }))).toThrow(/Expected a JSON array/);
    });

    it("throws naming the row when an array element is not a plain object", () => {
        const text = JSON.stringify([{ id: 1 }, "not an object"]);

        expect(() => parseImportFile("t.json", text)).toThrow(/Row 2/);
    });

    it("throws naming the row for a null element", () => {
        const text = JSON.stringify([null]);

        expect(() => parseImportFile("t.json", text)).toThrow(/Row 1/);
    });

    it("throws naming the row for an array element (rejects NDJSON-shaped nesting)", () => {
        const text = JSON.stringify([[1, 2]]);

        expect(() => parseImportFile("t.json", text)).toThrow(/Row 1/);
    });

    it("returns an empty result for an empty array", () => {
        expect(parseImportFile("t.json", "[]")).toEqual({ headers: [], rows: [] });
    });
});
