// The global query accelerators, single-sourced so the menu shortcut hints, the
// document-level keydown listeners, and the start-page keyboard hints never
// drift apart. The library's MenuItemConfig.shortcut is a DISPLAY hint only — it
// does not bind the key (MenuItem.ts) — so the app installs the real accelerators
// as document keydown listeners matched by the isXChord helpers.
//
// Alt+<letter> chords are used: free of the app's other accelerators (the
// editor's Ctrl/Cmd+Enter and Ctrl/Cmd+↑/↓) and, unlike the browser-reserved
// Ctrl/Cmd+N, reliably interceptable. N = new, S = saved, H = history.

/** Display labels shown on the menu items and the start-page hints. */
export const NEW_QUERY_SHORTCUT     = "Alt+N";
export const OPEN_SAVED_SHORTCUT    = "Alt+S";
export const QUERY_HISTORY_SHORTCUT = "Alt+H";

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
