import { describe, it, expect } from "vitest";
import { formatSqlErrorMessage, locateSqlError } from "../../src/data/sqlErrorPosition";

/**
 * Locate `position` in `text` the way QueryPanel does: the sent SQL is
 * `text.trim()`, so Postgres counts from the first non-whitespace character.
 */
function locate(text: string, position: number): ReturnType<typeof locateSqlError> {
    const sentStart = text.length - text.trimStart().length;

    return locateSqlError(text, sentStart, position);
}

describe("locateSqlError", () => {
    it("F1: highlights the identifier run at the start of the text", () => {
        expect(locate("SELEC 1", 1)).toEqual({ line: 1, column: 1, length: 5 });
    });

    it("F2: counts from the trimmed start and across line breaks", () => {
        expect(locate("\n  SELECT id\n  FROM nosuch_table", 18)).toEqual({ line: 3, column: 8, length: 12 });
    });

    it("F3: counts an astral character as one Postgres character but two UTF-16 columns", () => {
        expect(locate("SELECT '😀', nosuch FROM t", 13)).toEqual({ line: 1, column: 14, length: 6 });
    });

    it("F4: an end-of-input position is a zero-length caret one past the text", () => {
        expect(locate("SELECT (1", 10)).toEqual({ line: 1, column: 10, length: 0 });
    });

    it("F5: a position on a trimmed trailing line break has zero length", () => {
        expect(locate("SELECT (1\n\n", 10)).toEqual({ line: 1, column: 10, length: 0 });
    });

    it("F6: an out-of-range position is clamped to the document end", () => {
        expect(locate("SELECT 1", 99)).toEqual({ line: 1, column: 9, length: 0 });
    });

    it("F7: a double-quoted identifier is highlighted through its closing quote", () => {
        expect(locate('SELECT * FROM "Order Items" x', 15).length).toBe(13);
    });

    it("F8: a doubled quote inside a literal is escaped, not the end", () => {
        expect(locate("SELECT 'it''s' ,", 8).length).toBe(7);
    });

    it("F9: an unterminated quote stops at the end of its line", () => {
        expect(locate("SELECT 'abc\nFROM t", 8).length).toBe(4);
    });

    it("F10: any other character is one character long", () => {
        expect(locate("SELECT 1, , 2", 11).length).toBe(1);
    });

    it("F11: a lone surrogate-pair character is two UTF-16 units long", () => {
        expect(locate("SELECT 😀", 8).length).toBe(2);
    });

    it("F12: an astral character earlier on the line shifts the column by one", () => {
        expect(locate("SELECT 1 FROM t WHERE 😀x = 1", 24)).toEqual({ line: 1, column: 25, length: 1 });
    });
});

describe("formatSqlErrorMessage", () => {
    it("F13: appends the line and column to the backend message", () => {
        expect(formatSqlErrorMessage('syntax error at or near "FORM"', { line: 2, column: 1, length: 4 }))
            .toBe('syntax error at or near "FORM" (line 2, column 1)');
    });
});
