// The global query accelerators, single-sourced so the menu shortcut hints, the
// document-level keydown listeners, and the start-page keyboard hints never
// drift apart. The library's MenuItemConfig.shortcut is a DISPLAY hint only — it
// does not bind the key (MenuItem.ts) — so the app installs the real accelerators
// as document keydown listeners matched by the isXChord helpers.
//
// Alt+<letter> chords are used: free of the app's other accelerators (the
// editor's Ctrl/Cmd+Enter and Ctrl/Cmd+↑/↓) and, unlike the browser-reserved
// Ctrl/Cmd+N, reliably interceptable. N = new, S = saved, H = history; the rail
// switches are D = Databases, O = rOles (R is taken by Refresh), Q = Queries;
// and R = Refresh the active view. (The Explain / Explain-Analyze chords —
// Ctrl+E / Ctrl+Shift+E — are editor-scoped and live in QueryPanel, not here,
// because the Explain engine is local to the active query panel.)

/** Display labels shown on the menu items and the start-page hints. */
export const NEW_QUERY_SHORTCUT     = "Alt+N";
export const OPEN_SAVED_SHORTCUT    = "Alt+S";
export const QUERY_HISTORY_SHORTCUT = "Alt+H";
export const DATABASES_RAIL_SHORTCUT = "Alt+D";
export const ROLES_RAIL_SHORTCUT     = "Alt+O";
export const QUERIES_RAIL_SHORTCUT   = "Alt+Q";
export const REFRESH_SHORTCUT        = "Alt+R";

/**
 * Whether a keydown is an `Alt+<key>` chord with no other modifier, so plain
 * typing is never swallowed.
 *
 * @param event - The keydown event.
 * @param key - The lowercase letter the chord binds.
 *
 * @returns `true` when the event is exactly `Alt+<key>`.
 */
function isAltChord(event: KeyboardEvent, key: string): boolean {
    return event.altKey
        && !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        && (event.key === key || event.key === key.toUpperCase());
}

/** Whether a keydown is the New-Query chord (Alt+N). */
export function isNewQueryChord(event: KeyboardEvent): boolean {
    return isAltChord(event, "n");
}

/** Whether a keydown is the Open-Saved chord (Alt+S) — focuses the Saved list. */
export function isOpenSavedChord(event: KeyboardEvent): boolean {
    return isAltChord(event, "s");
}

/** Whether a keydown is the Query-History chord (Alt+H) — focuses the Recent list. */
export function isQueryHistoryChord(event: KeyboardEvent): boolean {
    return isAltChord(event, "h");
}

/** Whether a keydown is the Databases-rail chord (Alt+D) — opens the Databases rail. */
export function isDatabasesRailChord(event: KeyboardEvent): boolean {
    return isAltChord(event, "d");
}

/** Whether a keydown is the Roles-rail chord (Alt+O) — opens the Roles rail. */
export function isRolesRailChord(event: KeyboardEvent): boolean {
    return isAltChord(event, "o");
}

/** Whether a keydown is the Queries-rail chord (Alt+Q) — opens the Queries rail. */
export function isQueriesRailChord(event: KeyboardEvent): boolean {
    return isAltChord(event, "q");
}

/** Whether a keydown is the Refresh chord (Alt+R) — refreshes the active view. */
export function isRefreshChord(event: KeyboardEvent): boolean {
    return isAltChord(event, "r");
}

/**
 * Whether a keydown is the Explain chord (Ctrl/Cmd+E). Unlike the rail chords
 * these ride Ctrl/Cmd (matching the editor's Run/Save family) and are bound
 * scoped to the surface that explains — the query editor and the view panel —
 * not at the document level.
 */
export function isExplainChord(event: KeyboardEvent): boolean {
    return (event.ctrlKey || event.metaKey)
        && !event.shiftKey
        && !event.altKey
        && (event.key === "e" || event.key === "E");
}

/** Whether a keydown is the Explain-Analyze chord (Ctrl/Cmd+Shift+E). */
export function isExplainAnalyzeChord(event: KeyboardEvent): boolean {
    return (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && !event.altKey
        && (event.key === "e" || event.key === "E");
}
