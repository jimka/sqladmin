// The app's keyboard accelerators, single-sourced so the menu shortcut hints,
// the document-level keydown listeners, the start-page shortcut legend, and the
// QueryPanel toolbar tooltips never drift apart. The library's
// MenuItemConfig.shortcut is a DISPLAY hint only — it does not bind the key
// (MenuItem.ts) — so the app installs the real accelerators as document keydown
// listeners matched by the isXChord helpers.
//
// Alt+<letter> chords are used for the global accelerators: free of the app's
// other accelerators (the editor's Ctrl/Cmd+Enter and Ctrl/Cmd+↑/↓) and, unlike
// the browser-reserved Ctrl/Cmd+N, reliably interceptable. N = new, S = saved,
// H = history; the rail switches are D = Databases, O = rOles (R is taken by
// Refresh), Q = Queries; and R = Refresh the active view. The editor-scoped
// chords — Run/Save/Clear, the Ctrl/Cmd+↑/↓ history recall, and Explain /
// Explain-Analyze (Ctrl/Cmd+E / Ctrl/Cmd+Shift+E) — are bound inside QueryPanel,
// but their display strings live here too so the legend and the panel tooltips
// share one source. The Help chord (?) opens the Keyboard Shortcuts dialog.

/** Display labels shown on the menu items and the start-page hints. */
export const NEW_QUERY_SHORTCUT     = "Alt+N";
export const OPEN_SAVED_SHORTCUT    = "Alt+S";
export const QUERY_HISTORY_SHORTCUT = "Alt+H";
export const DATABASES_RAIL_SHORTCUT = "Alt+D";
export const ROLES_RAIL_SHORTCUT     = "Alt+O";
export const QUERIES_RAIL_SHORTCUT   = "Alt+Q";
export const REFRESH_SHORTCUT        = "Alt+R";

// The editor-scoped display strings. They use the Ctrl/Cmd convention (matching
// the start page's existing hints and Mac-correct); the matchers accept
// `ctrlKey || metaKey`, so display and binding stay consistent. `↑`/`↓` denote
// the arrow keys the CodeEditor's history recall walks.
export const RUN_SHORTCUT             = "Ctrl/Cmd+Enter";
export const SAVE_SHORTCUT            = "Ctrl/Cmd+S";
export const CLEAR_SHORTCUT           = "Alt+C";
export const OLDER_QUERY_SHORTCUT     = "Ctrl/Cmd+↑";
export const NEWER_QUERY_SHORTCUT     = "Ctrl/Cmd+↓";
export const HISTORY_RECALL_SHORTCUT  = "Ctrl/Cmd+↑ / ↓";
export const EXPLAIN_SHORTCUT         = "Ctrl/Cmd+E";
export const EXPLAIN_ANALYZE_SHORTCUT = "Ctrl/Cmd+Shift+E";

/** The Help chord (?) that opens the Keyboard Shortcuts dialog. */
export const HELP_SHORTCUT = "?";

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

/**
 * Whether the keydown target is a text-editing context that should keep printable
 * keys. DOM refs live only inside this body (never at import scope), so the module
 * stays safe to import from the node-run registry test.
 *
 * @param target - The keydown event's target.
 *
 * @returns `true` when focus is in an input/textarea/contenteditable/CodeEditor.
 */
function isEditableTarget(target: EventTarget | null): boolean {
    // `typeof` guards a non-DOM host (the node-run registry test imports this
    // module): a bare `instanceof HTMLElement` throws ReferenceError there.
    if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) {
        return false;
    }

    const tag = target.tagName;

    return tag === "INPUT"
        || tag === "TEXTAREA"
        || target.isContentEditable
        || target.closest(".cm-editor") !== null; // CodeMirror (CodeEditor) root
}

/**
 * Whether a keydown is the Help chord (?). Guards against firing while the user
 * is typing: ? is printable (Shift+/), so — unlike the Alt chords — it must be
 * ignored when focus is in an input/textarea/CodeEditor, or it would swallow a
 * literal ? the user meant to type.
 *
 * @param event - The keydown event.
 *
 * @returns `true` when the event is `?` and focus is not in an editable field.
 */
export function isHelpChord(event: KeyboardEvent): boolean {
    return !event.ctrlKey
        && !event.metaKey
        && !event.altKey
        && event.key === "?"
        && !isEditableTarget(event.target);
}
