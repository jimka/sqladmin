import { describe, it, expect } from "vitest";
import { formatCaretReadout, yesNo } from "../src/textFormat";

describe("yesNo", () => {
    it("renders true as Yes", () => {
        expect(yesNo(true)).toBe("Yes");
    });

    it("renders false as No", () => {
        expect(yesNo(false)).toBe("No");
    });
});

describe("formatCaretReadout", () => {
    it("shows only the position at the document start with nothing selected", () => {
        expect(formatCaretReadout({ line: 1, column: 1 }, { characterCount: 0, lineCount: 1 })).toBe("Ln 1, Col 1");
    });

    it("shows only the position when nothing is selected", () => {
        expect(formatCaretReadout({ line: 12, column: 4 }, { characterCount: 0, lineCount: 1 })).toBe("Ln 12, Col 4");
    });

    it("uses the singular for exactly one selected character", () => {
        expect(formatCaretReadout({ line: 3, column: 9 }, { characterCount: 1, lineCount: 1 }))
            .toBe("Ln 3, Col 9 (1 char selected)");
    });

    it("uses the plural for several characters on one line", () => {
        expect(formatCaretReadout({ line: 3, column: 9 }, { characterCount: 5, lineCount: 1 }))
            .toBe("Ln 3, Col 9 (5 chars selected)");
    });

    it("adds the line count for a selection spanning several lines", () => {
        expect(formatCaretReadout({ line: 14, column: 3 }, { characterCount: 15, lineCount: 2 }))
            .toBe("Ln 14, Col 3 (15 chars, 2 lines selected)");
    });

    it("omits the suffix when no characters are selected whatever the line count", () => {
        expect(formatCaretReadout({ line: 2, column: 1 }, { characterCount: 0, lineCount: 2 })).toBe("Ln 2, Col 1");
    });

    it("ignores extra payload fields and reports a lone line break as two lines", () => {
        const caret = { line: 2, column: 1, offset: 9 };

        expect(formatCaretReadout(caret, { characterCount: 1, lineCount: 2 }))
            .toBe("Ln 2, Col 1 (1 char, 2 lines selected)");
    });
});
