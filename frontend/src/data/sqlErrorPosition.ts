// Converts the error position Postgres reports for a failed statement into the
// editor line/column/length a CodeEditor reveal takes. Pure — no DOM, no library
// import — so it is red-green testable offline. Three conversions matter:
//
//   * Characters → UTF-16. Postgres counts characters (code points); the editor
//     counts UTF-16 code units, where a character above U+FFFF (an emoji) is two.
//   * Trim offset. The query panel sends the editor text trimmed, so Postgres
//     counts from `sentStart` units into the document, not from its start.
//   * Lines. The editor's text always joins lines with "\n" (CodeMirror's
//     doc.toString()), so "\n" is the only line break counted.
//
// The highlight length is the token at the position — an identifier run, a
// quoted run, or one character — since Postgres reports a point, not a range.

// The highest code point UTF-16 stores in one unit (the end of the Basic
// Multilingual Plane); anything above it is a surrogate pair — two units.
// Fixed by the UTF-16 encoding itself, not tunable.
const MAX_BMP_CODE_POINT = 0xFFFF;

// Characters that continue an identifier-like token for the highlight: letters,
// digits, underscore, and `$` (Postgres allows `$` inside identifiers).
const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

/**
 * Where a failed statement's error sits in the editor. The same shape as the
 * library's `CodeEditorRevealTarget`, so it passes straight to `revealRange`.
 */
export interface SqlErrorLocation {
    /** 1-based line. */
    line: number;
    /** 1-based column, in UTF-16 code units (CodeEditor's convention). */
    column: number;
    /** Highlight length in UTF-16 code units; 0 = caret only. */
    length: number;
}

/**
 * Locate a Postgres error position in the editor text.
 *
 * @param documentText - The full editor text the statement was taken from.
 * @param sentStart - The UTF-16 index in `documentText` where the sent SQL
 *   starts (the length of the leading whitespace the send trimmed off).
 * @param position - Postgres's 1-based character offset into the sent SQL.
 *
 * @returns The line, column, and highlight length; a position past the end is
 *   clamped to the end of the text.
 */
export function locateSqlError(documentText: string, sentStart: number, position: number): SqlErrorLocation {
    const offset = advanceCodePoints(documentText, sentStart, position - 1);
    const lines  = documentText.slice(0, offset).split("\n");

    return {
        line  : lines.length,
        column: lines[lines.length - 1].length + 1,
        length: tokenLength(documentText, offset),
    };
}

/**
 * Append the location to an error message, e.g. `… (line 2, column 1)`.
 *
 * @param message - The backend's error message.
 * @param location - Where the error sits in the editor.
 *
 * @returns The message with its `(line X, column Y)` suffix.
 */
export function formatSqlErrorMessage(message: string, location: SqlErrorLocation): string {
    return `${message} (line ${location.line}, column ${location.column})`;
}

/**
 * Step `count` code points forward from `start`, stopping at the end of `text`.
 *
 * @returns The UTF-16 index reached.
 */
function advanceCodePoints(text: string, start: number, count: number): number {
    let index = start;

    for (let step = 0; step < count && index < text.length; step++) {
        index += codePointWidth(text, index);
    }

    return Math.min(index, text.length);
}

/** The UTF-16 width (1, or 2 for a surrogate pair) of the character at `index`. */
function codePointWidth(text: string, index: number): number {
    return text.codePointAt(index)! > MAX_BMP_CODE_POINT ? 2 : 1;
}

/**
 * The length of the token starting at `offset`: an identifier run, a quoted run,
 * or a single character — and 0 at the end of the text or on a line break.
 *
 * @returns The token length in UTF-16 code units.
 */
function tokenLength(text: string, offset: number): number {
    if (offset >= text.length || text[offset] === "\n") {
        return 0;
    }

    const first = text[offset];

    if (first === "\"" || first === "'") {
        return quotedRunLength(text, offset);
    }

    if (IDENTIFIER_CHAR.test(String.fromCodePoint(text.codePointAt(offset)!))) {
        return identifierRunLength(text, offset);
    }

    return codePointWidth(text, offset);
}

/**
 * The length of the run of identifier characters starting at `offset`.
 *
 * @returns The run length in UTF-16 code units.
 */
function identifierRunLength(text: string, offset: number): number {
    let index = offset;

    while (index < text.length) {
        const character = String.fromCodePoint(text.codePointAt(index)!);

        if (!IDENTIFIER_CHAR.test(character)) {
            break;
        }

        index += character.length;
    }

    return index - offset;
}

/**
 * The length of the quoted run starting at the quote at `offset`, through its
 * matching closing quote. A doubled quote inside is an escape, not the end; an
 * unterminated quote runs to the end of its line.
 *
 * @returns The run length in UTF-16 code units, both quotes included.
 */
function quotedRunLength(text: string, offset: number): number {
    const quote = text[offset];
    let index   = offset + 1;

    while (index < text.length && text[index] !== "\n") {
        if (text[index] !== quote) {
            index++;
        } else if (text[index + 1] === quote) {
            index += 2;
        } else {
            return index + 1 - offset;
        }
    }

    return index - offset;
}
