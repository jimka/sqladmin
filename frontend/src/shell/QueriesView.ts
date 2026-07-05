// The "Queries" activity-bar view — the third Card page in the sidebar deck
// (added on the documented Phase-2 seam: one more rail button + one more deck
// page). An Accordion of two sections, Saved and Recent, each a library List
// over the per-connection saved queries and run history from the controller's
// stores.
//
// Interaction model:
//   - single-click   selects a row and arms the section's header tools;
//   - double-click   *executes* — opens the query in a new panel AND runs it;
//   - right-click    opens a context menu (Execute query / Open query);
//   - hover          shows the full SQL in a tooltip (rows are truncated);
//   - header tools   Open (open without running), Remove / Save…, and Refresh,
//                    all acting on the selected row (Refresh re-reads the store).
//
// Each section's list re-populates on the controller's onWorkspaceChanged seam
// (and on Refresh), so the view is always current.

import { Component, Panel }        from "@jimka/typescript-ui/core";
import { Fit }                     from "@jimka/typescript-ui/layout";
import { Event }                   from "@jimka/typescript-ui/core";
import { Text }                    from "@jimka/typescript-ui/component/input";
import { Button }                  from "@jimka/typescript-ui/component/button";
import { AccordionPanel }          from "@jimka/typescript-ui/component/container";
import { List, GlyphListItemRenderer } from "@jimka/typescript-ui/component/list";
import { Glyph }                   from "@jimka/typescript-ui/component/display";
import { Menu }                    from "@jimka/typescript-ui/overlay";
import { folder_open }             from "@jimka/typescript-ui/glyphs/solid/folder_open";
import { trash }                   from "@jimka/typescript-ui/glyphs/solid/trash";
import { floppy_disk }             from "@jimka/typescript-ui/glyphs/solid/floppy_disk";
import { clock_rotate_left }       from "@jimka/typescript-ui/glyphs/solid/clock_rotate_left";
import { terminal }                from "@jimka/typescript-ui/glyphs/solid/terminal";
import { refreshTool, bindRefreshShortcut } from "./refreshTool";
import { SIDEBAR_FILL_HINT }       from "./sidebarFillHint";
import type { SqlAdminController } from "../SqlAdminController";
import { PRIMARY_COLOR, DESTRUCTIVE_COLOR, MUTED_TEXT_COLOR } from "../theme";

// terminal marks every list row as a query (matching the query dock tab).
Glyph.register(folder_open, trash, floppy_disk, clock_rotate_left, terminal);

// A one-line SQL preview length. Long enough to recognise a statement in the
// narrow sidebar column, short enough not to wrap the row.
const SNIPPET_MAX = 60;

/** A list row plus whatever a section's actions need to act on it. */
interface QueryRow {
    /** The List item key (unique within the section). */
    key: string;
    /** The one-line row label. */
    label: string;
    /** The full SQL — opened/executed, and shown in the hover tooltip. */
    sql: string;
    /** The saved-query name (Saved rows only). */
    name?: string;
}

/** One selection-driven header tool for a section. */
interface RowAction {
    /** The registered glyph name for the button face. */
    glyph: string;
    /** The button's foreground color. */
    color: string;
    /** Hover tooltip / accessible name. */
    label: string;
    /** Run the action against the selected row. */
    run: (row: QueryRow) => void;
}

/** The configuration for one accordion section. */
interface SectionConfig {
    /** The section header label and glyph. */
    title: string;
    glyph: string;
    /** Text shown in place of the list when there are no rows. */
    empty: string;
    /** Snapshot the section's current rows from the store. */
    rows: () => QueryRow[];
    /** Open a row without running it (the Open tool, context "Open query"). */
    open: (row: QueryRow) => void;
    /** Execute a row — open AND run it (double-click, context "Execute query"). */
    execute: (row: QueryRow) => void;
    /** The section's second armed tool: Remove (Saved) or Save… (Recent). */
    secondary: RowAction;
}

/**
 * Build the Queries view: an Accordion of the Saved and Recent sections over the
 * controller's stores.
 *
 * @param controller - The mediator owning the query stores and open actions.
 * @param id - The Card-page key the activity-bar rail selects this view by; it
 *   becomes the view component's id, which the deck's `Card` matches against.
 *
 * @returns The Queries view component.
 */
export function QueriesView(controller: SqlAdminController, id: string): Component {
    const saved = buildSection({
        title    : "Saved",
        glyph    : "floppy-disk",
        empty    : "No saved queries",
        rows     : () => controller.savedList().map(q => ({ key: q.name, label: q.name, sql: q.sql, name: q.name })),
        open     : row => controller.openSavedQuery(row.name!, false),
        execute  : row => controller.openSavedQuery(row.name!, true),
        secondary: { glyph: "trash", color: DESTRUCTIVE_COLOR, label: "Remove",
                     run: row => controller.removeSavedQuery(row.name!) },
    });

    const recent = buildSection({
        title    : "Recent",
        glyph    : "clock-rotate-left",
        empty    : "No recent queries",
        rows     : () => controller.historyList().map((h, i) => ({ key: String(i), label: snippet(h.sql), sql: h.sql })),
        open     : row => controller.openQuery(row.sql, false),
        execute  : row => controller.openQuery(row.sql, true),
        secondary: { glyph: "floppy-disk", color: PRIMARY_COLOR, label: "Save under a name",
                     run: row => void controller.promptAndSaveQuery(row.sql) },
    });

    const view = new AccordionPanel({
        id,
        sections: [
            { label: "Saved",  component: saved.host,  initiallyOpen: true, glyph: "floppy-disk",       tools: saved.tools },
            { label: "Recent", component: recent.host, initiallyOpen: true, glyph: "clock-rotate-left", tools: recent.tools },
        ],
    });

    const accordion = view.getAccordion();
    accordion.setCompact(true);
    // Keep the header tools visible (not hover-only) so the affordances are
    // always discoverable, matching the Database view's tools.
    accordion.setToolsVisibility("always");

    // The menu's "Open Saved…" / "Query History…" land the keyboard on the right
    // list: expand its section and focus it. Saved is section 0, Recent is 1.
    controller.setQueriesSectionFocus(section => {
        const target = section === "saved" ? saved : recent;
        accordion.openSection(section === "saved" ? 0 : 1);
        target.focusList();
    });

    const rebuild = (): void => {
        saved.refresh();
        recent.refresh();
    };

    controller.onWorkspaceChanged(rebuild);
    rebuild();

    // Alt+R re-reads both sections' stores while this rail has focus (see refreshTool).
    bindRefreshShortcut(view, rebuild);

    return view;
}

/** A section's live handles: its content host, its header tools, and a refresh. */
interface Section {
    /** The section body — swaps between the list and the empty hint. */
    host: Panel;
    /** The header tool buttons (stable across refreshes). */
    tools: Button[];
    /** Re-read the store and repopulate the list (and tool state). */
    refresh: () => void;
    /** Focus the section's list, seeding a keyboard cursor on the first row. */
    focusList: () => void;
}

/**
 * Build one accordion section: a content host holding the current List (or an
 * empty hint), plus its header tools bound to the current selection.
 *
 * @param config - The section configuration.
 *
 * @returns The section's host, tools, and refresh callback.
 */
function buildSection(config: SectionConfig): Section {
    const host = Panel({ layoutManager: new Fit() });
    const menu = new Menu();

    // The rows currently shown and the list rendering them — refreshed in place
    // so the stable header tools always act on the live selection.
    let rows: QueryRow[]  = [];
    let list: List | null = null;

    const refresh = (): void => {
        rows = config.rows();
        host.removeAllComponents();

        if (rows.length === 0) {
            list = null;
            host.addComponent(hintText(config.empty));
            host.doLayout();
            syncTools();

            return;
        }

        list = buildList(rows);
        wireRow(list, rows, config, menu);

        list.on("change", syncTools);

        host.addComponent(list);
        host.doLayout();
        syncTools();
    };

    // The armed tools (Open + the section's Remove/Save…) act on the selection,
    // so they stay disabled until a row is picked; Refresh is always available.
    const openAction: RowAction = { glyph: "folder-open", color: PRIMARY_COLOR, label: "Open", run: config.open };
    const armed = [openAction, config.secondary].map(action => actionButton(action, () => selectedRow(list, rows)));
    const tools = [...armed, refreshTool(refresh)];

    /** Enable the armed tools only while a row is selected. */
    function syncTools(): void {
        const on = list !== null && list.getSelectedIndex() >= 0;
        armed.forEach(button => button.setEnabled(on));
    }

    /**
     * Focus the list (the menu's "Open Saved…" / "Query History…" landing), and
     * seed a keyboard cursor on the first row when nothing is selected so Enter
     * acts immediately. A no-op for an empty section (no list to focus).
     */
    function focusList(): void {
        if (!list) {
            return;
        }

        const target = list;

        if (target.getSelectedIndex() < 0) {
            // setSelectedIndex sets both the selection and the focus index, and
            // fires change → syncTools arms the header tools.
            target.setSelectedIndex(0, true);
        }

        // Focus after the next layout flush, not now: this runs from
        // controller.showQueriesView, which reveals the Queries view and opens its
        // section — both via scheduleLayout — so on this tick the list is not yet
        // in its final attached, laid-out state. afterNextLayout follows the
        // batched layout pass deterministically, so focus lands on the settled
        // list; a bare requestAnimationFrame only races that flush.
        Component.afterNextLayout(() => target.focus());
    }

    return { host, tools, refresh, focusList };
}

/**
 * Wire a freshly built list's row gestures: Enter / double-click open the row,
 * Ctrl+Enter executes it, and right-click opens the Execute/Open context menu.
 *
 * @param list - The list whose rows to wire.
 * @param rows - The rows backing the list, in index order.
 * @param config - The section config supplying open/execute.
 * @param menu - The reused context menu to show on right-click.
 */
function wireRow(list: List, rows: QueryRow[], config: SectionConfig, menu: Menu): void {
    list.on("dblclick", (index: number) => {
        if (index >= 0) {
            config.execute(rows[index]);
        }
    });

    // Enter opens the keyboard-focused row; Ctrl/Cmd+Enter executes it. Runs
    // after the list's own Enter handling (which commits the focused row), so
    // getFocusedIndex points at the row the user acted on.
    Event.addListener(list, "keydown", (e: KeyboardEvent) => {
        if (e.key !== "Enter") {
            return;
        }

        const index = list.getFocusedIndex() >= 0 ? list.getFocusedIndex() : list.getSelectedIndex();

        if (index < 0) {
            return;
        }

        e.preventDefault();
        (e.ctrlKey || e.metaKey ? config.execute : config.open)(rows[index]);
    });

    list.on("contextmenu", (index: number, e: MouseEvent) => {
        // Highlight the right-clicked row (fires change → arms the tools). The
        // list has already suppressed the native menu and resolved the index.
        list.setSelectedIndex(index, true);
        // The library Menu light-dismisses on an outside pointerdown, so pressing
        // another list row (a preventDefaulted pointerdown that suppresses the
        // compat mousedown) closes it — no app-side dismissal listener needed.
        menu.show(e.clientX, e.clientY, [
            { text: "Execute", action: () => config.execute(rows[index]) },
            { text: "Open",    action: () => config.open(rows[index]) },
        ]);
    });
}

/** The selected row of a section's list, or `undefined` when nothing is selected. */
function selectedRow(list: List | null, rows: QueryRow[]): QueryRow | undefined {
    const index = list?.getSelectedIndex() ?? -1;

    return index >= 0 ? rows[index] : undefined;
}

/**
 * Build a selectable List for the section's rows, sized with a fill hint so it
 * fills the accordion section and scrolls its own overflow.
 *
 * @param rows - The section's rows.
 *
 * @returns The List component.
 */
function buildList(rows: QueryRow[]): List {
    const list = new List({
        preferredSize:   { width: 0, height: SIDEBAR_FILL_HINT },
        // Render each row as a query glyph beside its label.
        rendererFactory: () => new GlyphListItemRenderer(),
    });
    // setItems is the typed entry point for pre-formed {key, label} rows (the
    // constructor's `items` option is typed for the plain-string form). Every row
    // is a query, so each carries the terminal glyph; the full SQL rides along as
    // the row's hover tooltip (rows are truncated).
    list.setItems(rows.map(row => ({ key: row.key, label: row.label, glyph: "terminal", tooltip: row.sql })));

    return list;
}

/**
 * A glyph-only header tool that runs an action against the section's current
 * selection (a no-op when nothing is selected).
 *
 * @param action - The action spec.
 * @param selected - Resolves the section's currently selected row.
 *
 * @returns The button component.
 */
function actionButton(action: RowAction, selected: () => QueryRow | undefined): Button {
    // showText:false keeps the face glyph-only while the label drives both the
    // hover tooltip and the aria-label (accessible name).
    const button = Button({
        glyph          : action.glyph,
        text           : action.label,
        showText       : false,
        foregroundColor: action.color,
        compact        : true,
    });

    button.on("action", () => {
        const row = selected();

        if (row) {
            action.run(row);
        }
    });

    return button;
}

/** A muted empty-state hint row. */
function hintText(text: string): Component {
    const hint = new Text(text);
    hint.setForegroundColor(MUTED_TEXT_COLOR);

    return hint;
}

/** Collapse whitespace and truncate SQL to a one-line preview. */
function snippet(sql: string): string {
    const oneLine = sql.replace(/\s+/g, " ").trim();

    return oneLine.length > SNIPPET_MAX ? `${oneLine.slice(0, SNIPPET_MAX - 1)}…` : oneLine;
}
