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
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): the view `extends
// AccordionPanel` directly, so the instance itself is the mountable component.
// `rebuild` and the section wiring stay constructor-local closures (per the
// plan's Architecture Decisions) — nothing here is a plain method registered
// by reference, so no instance fields are needed.

import { Component, Panel }        from "@jimka/typescript-ui/core";
import { Fit }                     from "@jimka/typescript-ui/layout";
import { Event }                   from "@jimka/typescript-ui/core";
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
import type { SqlAdminController } from "../SqlAdminController";
import { PRIMARY_COLOR, DESTRUCTIVE_COLOR } from "../theme";

// terminal marks every list row as a query (matching the query dock tab).
Glyph.register(folder_open, trash, floppy_disk, clock_rotate_left, terminal);

// Each section's floor and preferred height. Under the accordion's resizable
// mode getMinSize is the gutter drag's stop; a Fit Panel over a zero-preferred
// List reports a min of only its 8px insets, which would let a drag reduce a
// section to a sliver. 96px mirrors treeExplorerView's TREE_MIN_HEIGHT. Set as
// preferred too so a section never reports min > preferred; the equal
// weights still split all the leftover height, so the rendered result is
// unchanged.
const SECTION_MIN_HEIGHT = 96;

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
    /** Placeholder text the list shows inside its scroll area when it has no rows. */
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
 * The Queries view: an Accordion of the Saved and Recent sections over the
 * controller's stores.
 */
export class QueriesView extends AccordionPanel {
    /**
     * @param controller - The mediator owning the query stores and open actions.
     * @param id - The Card-page key the activity-bar rail selects this view by; it
     *   becomes the view component's id, which the deck's `Card` matches against.
     */
    constructor(controller: SqlAdminController, id: string) {
        // `this` is unavailable until super() returns, so both sections are
        // built as locals first.
        const layout = controller.layout.bindAccordion("queries");
        const open   = layout.loadOpen();

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

        super({
            id,
            // Draggable gutter between Saved and Recent, so the user apportions the
            // height; the equal weights below seed the split evenly, as before.
            resizable: true,
            sections: [
                // Equal fill weights split the leftover height between the two lists.
                { label: "Saved",  component: saved.host,  initiallyOpen: open[0], glyph: "floppy-disk",       tools: saved.tools,  weight: 1 },
                { label: "Recent", component: recent.host, initiallyOpen: open[1], glyph: "clock-rotate-left", tools: recent.tools, weight: 1 },
            ],
            onSectionToggle: layout.onToggle,
        });

        const accordion = this.getAccordion();
        accordion.setCompact(true);
        // Keep the header tools visible (not hover-only) so the affordances are
        // always discoverable, matching the Database view's tools.
        accordion.setToolsVisibility("always");

        // Restore the saved Saved/Recent proportion, if any (both sections are
        // weighted, so both persist as ratios; a stale array is discarded by the
        // library, falling back to the equal-weight seed above).
        const savedSizes = layout.loadSizes();

        if (savedSizes !== null) {
            accordion.applySectionSizes(savedSizes);
        }

        accordion.on("sectionresize", layout.onSizes);

        // The menu's "Open Saved…" / "Query History…" land the keyboard on the
        // right list: expand its section and focus it. Saved is section 0,
        // Recent is 1.
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
        bindRefreshShortcut(this, rebuild);
    }
}

/** A section's live handles: its content host, its header tools, and a refresh. */
interface Section {
    /** The section body — holds the section's List, which shows an empty-state placeholder when it has no rows. */
    host: Panel;
    /** The header tool buttons (stable across refreshes). */
    tools: Button[];
    /** Re-read the store and repopulate the list (and tool state). */
    refresh: () => void;
    /** Focus the section's list, seeding a keyboard cursor on the first row. */
    focusList: () => void;
}

/**
 * Build one accordion section: a content host holding a single long-lived List
 * (which shows an empty-state placeholder when it has no rows), plus its header
 * tools bound to the current selection.
 *
 * @param config - The section configuration.
 *
 * @returns The section's host, tools, and refresh callback.
 */
function buildSection(config: SectionConfig): Section {
    const host = Panel({
        layoutManager: new Fit(),
        preferredSize: { width: 0, height: SECTION_MIN_HEIGHT },
        minSize      : { width: 0, height: SECTION_MIN_HEIGHT },
    });

    const menu = new Menu();

    // The rows currently shown. The single long-lived List renders them and
    // shows `config.empty` as its placeholder when there are none — so the stable
    // header tools always act on the live selection without a list rebuild.
    let rows: QueryRow[] = [];

    const list = buildList(config.empty);
    wireRow(list, () => rows, config, menu);
    list.on("change", syncTools);
    host.addComponent(list);

    const refresh = (): void => {
        rows = config.rows();
        list.setItems(rows.map(row => ({ key: row.key, label: row.label, glyph: "terminal", tooltip: row.sql })));
        syncTools();
    };

    // The armed tools (Open + the section's Remove/Save…) act on the selection,
    // so they stay disabled until a row is picked; Refresh is always available.
    const openAction: RowAction = { glyph: "folder-open", color: PRIMARY_COLOR, label: "Open", run: config.open };
    const armed = [openAction, config.secondary].map(action => actionButton(action, () => selectedRow(list, rows)));
    const tools = [...armed, refreshTool(refresh)];

    /** Enable the armed tools only while a row is selected. */
    function syncTools(): void {
        const on = list.getSelectedIndex() >= 0;
        armed.forEach(button => button.setEnabled(on));
    }

    /**
     * Focus the list (the menu's "Open Saved…" / "Query History…" landing), and
     * seed a keyboard cursor on the first row when nothing is selected so Enter
     * acts immediately. A no-op for an empty section (nothing to land on).
     */
    function focusList(): void {
        if (rows.length === 0) {
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
 * @param getRows - Reads the section's live rows (the single list outlives any
 *   one `rows` snapshot, so handlers must index the current array).
 * @param config - The section config supplying open/execute.
 * @param menu - The reused context menu to show on right-click.
 */
function wireRow(list: List, getRows: () => QueryRow[], config: SectionConfig, menu: Menu): void {
    list.on("dblclick", (index: number) => {
        if (index >= 0) {
            config.execute(getRows()[index]);
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
        (e.ctrlKey || e.metaKey ? config.execute : config.open)(getRows()[index]);
    });

    list.on("contextmenu", (index: number, e: MouseEvent) => {
        // Highlight the right-clicked row (fires change → arms the tools). The
        // list has already suppressed the native menu and resolved the index.
        list.setSelectedIndex(index, true);
        // The library Menu light-dismisses on an outside pointerdown, so pressing
        // another list row (a preventDefaulted pointerdown that suppresses the
        // compat mousedown) closes it — no app-side dismissal listener needed.
        menu.show(e.clientX, e.clientY, [
            { text: "Execute", action: () => config.execute(getRows()[index]) },
            { text: "Open",    action: () => config.open(getRows()[index]) },
        ]);
    });
}

/** The selected row of a section's list, or `undefined` when nothing is selected. */
function selectedRow(list: List, rows: QueryRow[]): QueryRow | undefined {
    const index = list.getSelectedIndex();

    return index >= 0 ? rows[index] : undefined;
}

/**
 * Build the section's selectable List. Carries no intrinsic height — the
 * section's weight grows it into the leftover space, and it scrolls its own
 * overflow. Rows are set later by the section's `refresh`; until then the list
 * shows `emptyText` as its placeholder.
 *
 * @param emptyText - Placeholder shown inside the scroll area when the list is empty.
 *
 * @returns The List component.
 */
function buildList(emptyText: string): List {
    return new List({
        preferredSize:   { width: 0, height: 0 },
        emptyText,
        // Rail-width rows can't show a whole query, and the tail of one is often
        // the part that identifies it (the WHERE, the ORDER BY). Scroll to it
        // rather than ellipsising it away.
        horizontalScrolling: true,
        // Render each row as a query glyph beside its label.
        rendererFactory: () => new GlyphListItemRenderer(),
    });
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

/**
 * Collapse a query's whitespace into a one-line preview.
 *
 * Deliberately uncapped: the Recent list scrolls horizontally, so the row is the
 * thing that decides how much of a query is visible. Cutting the string here
 * would put a hard `…` in the middle of that scroll — the row would scroll to an
 * ellipsis rather than to the rest of the query.
 */
function snippet(sql: string): string {
    return sql.replace(/\s+/g, " ").trim();
}
