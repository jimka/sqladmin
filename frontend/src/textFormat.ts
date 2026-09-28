// The app's small pure value-to-display-string helpers. Imports nothing from
// the library, so this module runs under the node vitest.

/** Human-readable Yes/No for a boolean flag row. */
export function yesNo(value: boolean): string {
    return value ? "Yes" : "No";
}

/**
 * The status bar's caret readout: `Ln 12, Col 4`, plus `(N char(s)[, M lines] selected)`
 * when the selection holds characters. The line count appears only for a selection
 * spanning more than one line.
 *
 * The numbers are passed through unconverted from the library's CodeEditor, whose
 * `CodeEditorCursorPosition` / `CodeEditorSelection` fit these structural types:
 * the column and character count are UTF-16 units and a tab is one column.
 *
 * @param caret - The caret's 1-based line and column (the selection's moving end).
 * @param selection - The primary selection's character count and the number of lines it touches.
 * @returns The readout text.
 */
export function formatCaretReadout(
    caret: { line: number; column: number },
    selection: { characterCount: number; lineCount: number },
): string {
    const position = `Ln ${caret.line}, Col ${caret.column}`;

    if (selection.characterCount === 0) {
        return position;
    }

    const chars = selection.characterCount === 1 ? "1 char" : `${selection.characterCount} chars`;
    const lines = selection.lineCount > 1 ? `, ${selection.lineCount} lines` : "";

    return `${position} (${chars}${lines} selected)`;
}
