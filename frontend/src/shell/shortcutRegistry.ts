// The keyboard-shortcut registry: the single source of truth the shortcut legend
// (start page + Keyboard Shortcuts dialog) renders from. It is a DISPLAY view
// over queryShortcuts.ts — it re-uses that module's key strings (never literals)
// and adds only the display metadata the keys don't carry (label, category,
// scope). Key MATCHING stays in queryShortcuts' isXChord helpers; this module
// defines no matching logic. Pure data + grouping, no typescript-ui import, so it
// runs under the project's DOM-less node vitest (mirroring startPageWelcome.ts).

import {
    RUN_SHORTCUT, SAVE_SHORTCUT, CLEAR_SHORTCUT, HISTORY_RECALL_SHORTCUT,
    EXPLAIN_SHORTCUT, EXPLAIN_ANALYZE_SHORTCUT,
    NEW_QUERY_SHORTCUT, OPEN_SAVED_SHORTCUT, QUERY_HISTORY_SHORTCUT,
    DATABASES_RAIL_SHORTCUT, ROLES_RAIL_SHORTCUT, QUERIES_RAIL_SHORTCUT,
    REFRESH_SHORTCUT, HELP_SHORTCUT,
} from "./queryShortcuts";

/** The legend's display grouping. */
export type ShortcutCategory = "editor" | "query" | "navigation";

/** Where a shortcut is actually bound (documentation only). */
export type ShortcutScope = "editor" | "global";

/** One shortcut's display record. */
export interface ShortcutEntry {
    /** Stable id (e.g. "run", "new-query"). */
    id: string;
    /** Display key string, Ctrl/Cmd convention (from queryShortcuts constants). */
    keys: string;
    /** Human label ("Run the query"). */
    label: string;
    /** Display grouping. */
    category: ShortcutCategory;
    /** Where the key is actually bound (documentation only). */
    scope: ShortcutScope;
}

/** A category's entries under a human heading, for the rendered legend. */
export interface ShortcutGroup {
    category: ShortcutCategory;
    /** Human heading for the category ("Editor" / "Query" / "Navigation"). */
    title: string;
    entries: ShortcutEntry[];
}

/** Every app shortcut, the source of truth for the legend. */
export const SHORTCUTS: readonly ShortcutEntry[] = [
    { id: "run",             keys: RUN_SHORTCUT,             label: "Run the query",                 category: "editor",     scope: "editor" },
    { id: "save",            keys: SAVE_SHORTCUT,            label: "Save the query",                category: "editor",     scope: "editor" },
    { id: "clear",           keys: CLEAR_SHORTCUT,           label: "Clear the editor",              category: "editor",     scope: "editor" },
    { id: "history-recall",  keys: HISTORY_RECALL_SHORTCUT,  label: "Browse query history",          category: "editor",     scope: "editor" },
    { id: "explain",         keys: EXPLAIN_SHORTCUT,         label: "Explain the statement",         category: "editor",     scope: "editor" },
    { id: "explain-analyze", keys: EXPLAIN_ANALYZE_SHORTCUT, label: "Explain Analyze the statement", category: "editor",     scope: "editor" },
    { id: "new-query",       keys: NEW_QUERY_SHORTCUT,       label: "New query",                     category: "query",      scope: "global" },
    { id: "open-saved",      keys: OPEN_SAVED_SHORTCUT,      label: "Open saved queries",            category: "query",      scope: "global" },
    { id: "query-history",   keys: QUERY_HISTORY_SHORTCUT,   label: "Query history",                 category: "query",      scope: "global" },
    { id: "databases-rail",  keys: DATABASES_RAIL_SHORTCUT,  label: "Databases rail",                category: "navigation", scope: "global" },
    { id: "roles-rail",      keys: ROLES_RAIL_SHORTCUT,      label: "Roles rail",                    category: "navigation", scope: "global" },
    { id: "queries-rail",    keys: QUERIES_RAIL_SHORTCUT,    label: "Queries rail",                  category: "navigation", scope: "global" },
    { id: "refresh",         keys: REFRESH_SHORTCUT,         label: "Refresh the active view",       category: "navigation", scope: "global" },
    { id: "help",            keys: HELP_SHORTCUT,            label: "Keyboard shortcuts",            category: "navigation", scope: "global" },
];

// The canonical category order the legend renders in, paired with each group's
// human heading. Iterating this (not the entries) fixes the display order
// independent of the SHORTCUTS array's ordering.
const CATEGORY_ORDER: readonly { category: ShortcutCategory; title: string }[] = [
    { category: "editor",     title: "Editor" },
    { category: "query",      title: "Query" },
    { category: "navigation", title: "Navigation" },
];

/**
 * Group shortcut entries by category in the canonical order
 * Editor -> Query -> Navigation, skipping any category with no entries.
 *
 * @param entries - The entries to group; defaults to the full registry.
 *
 * @returns One group per non-empty category, in canonical order.
 */
export function groupByCategory(entries: readonly ShortcutEntry[] = SHORTCUTS): ShortcutGroup[] {
    const groups: ShortcutGroup[] = [];

    for (const { category, title } of CATEGORY_ORDER) {
        const inCategory = entries.filter(entry => entry.category === category);

        if (inCategory.length === 0) {
            continue;
        }

        groups.push({ category, title, entries: inCategory });
    }

    return groups;
}
