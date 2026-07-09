// The empty-workspace start page — an app-owned welcome surface shown in the
// shell's CENTER (a Card deck alongside the Dock) whenever no dock panels are
// open. The controller toggles this deck off the Dock's "emptychange" event, so
// no panel bookkeeping lives here; the page itself is a plain composed Panel laid
// out as a two-column "home": a full-width header (the app heading and, on an
// empty workspace, the welcome blurb) over a left column of quick actions /
// recent tables / saved queries and a right column of the keyboard-shortcut
// legend and connection info. It rebuilds on the controller's onWorkspaceChanged
// seam so the recent/saved lists stay current.

import { Component, Panel }         from "@jimka/typescript-ui/core";
import { VBox, HBox }               from "@jimka/typescript-ui/layout";
import { Insets }                   from "@jimka/typescript-ui/primitive";
import { Text }                     from "@jimka/typescript-ui/component/input";
import { Button }                   from "@jimka/typescript-ui/component/button";
import { Glyph, Markdown }          from "@jimka/typescript-ui/component/display";
import { plus }                     from "@jimka/typescript-ui/glyphs/solid/plus";
import { shouldShowWelcome }        from "./startPageWelcome";
import { buildShortcutLegend }      from "./shortcutLegend";
import type { SavedQuery }          from "../data/queryStore";
import type { SqlAdminController }  from "../SqlAdminController";
import { MUTED_TEXT_COLOR }         from "../theme";

Glyph.register(plus);

// Padding around the welcome content, the vertical gap between stacked entries,
// the horizontal gap between the two columns, and the fixed height of each action
// button — comfortable click targets that read as a "jump back in" list with a
// little more breathing room than the denser Queries-view lists. COLUMN_SPACING
// is wider than the vertical ENTRY_SPACING so the two columns read as distinct
// panes rather than one run-together block.
const PAGE_PADDING = 24;
const ENTRY_SPACING = 6;
const COLUMN_SPACING = 32;
const BUTTON_HEIGHT = 30;

// The empty-workspace welcome blurb, shown above the quick actions only when
// there are no recent tables and no saved queries (see shouldShowWelcome). It
// opens with a `##`-level heading, not another `#` app title, so it doesn't
// stutter against the "SQL Admin" heading already on the page.
const GETTING_STARTED_MARKDOWN = `## Getting started

Your workspace is empty. Open a new query or pick a table from the sidebar
to begin — your **recent tables** and **saved queries** collect here as you
work.

- **New Query** — open a blank SQL editor
- Click a table in the sidebar to inspect its structure and data
- Save a query to pin it to this page`;

/**
 * Build the start page shown when the workspace has no open panels.
 *
 * @param controller - The mediator supplying the quick actions and stored lists.
 *
 * @returns The start-page component.
 */
export function StartPage(controller: SqlAdminController): Component {
    const page = Panel({
        layoutManager: new VBox({ stretching: true, spacing: ENTRY_SPACING }),
        overflow     : "auto",
    });
    page.setInsets(new Insets(PAGE_PADDING, PAGE_PADDING, PAGE_PADDING, PAGE_PADDING));

    // The welcome blurb is transient: rebuilt (and disposed) each time the
    // workspace toggles between empty and non-empty. removeAllComponents()
    // below detaches it from the DOM but does not call dispose(), so its theme
    // listener must be released explicitly before each rebuild.
    let welcome: Markdown | null = null;

    /** Repopulate the page from the current stores. */
    function rebuild(): void {
        if (welcome) {
            welcome.dispose();
            welcome = null;
        }

        page.removeAllComponents();

        // Full-width header above the columns: the app heading, and — only on an
        // empty workspace — the transient welcome blurb.
        page.addComponent(heading("SQL Admin", "600"));

        if (shouldShowWelcome(controller)) {
            welcome = Markdown(GETTING_STARTED_MARKDOWN);
            page.addComponent(welcome);
        }

        page.addComponent(buildColumns(controller));

        page.doLayout();
    }

    controller.onWorkspaceChanged(rebuild);
    rebuild();

    return page;
}

/**
 * Build the two-column body: quick actions and stored lists on the left, the
 * shortcut legend and connection info on the right. Both columns take equal
 * weight and top-anchor their content so the page reads as a home rather than a
 * stretched split.
 *
 * @param controller - Supplies the quick actions, stored lists, and connection.
 *
 * @returns The columns container.
 */
function buildColumns(controller: SqlAdminController): Component {
    const columns = Panel({ layoutManager: new HBox({ spacing: COLUMN_SPACING }) });

    columns.addComponent(buildLeftColumn(controller), { weight: 1 });
    columns.addComponent(buildRightColumn(controller), { weight: 1 });

    return columns;
}

/**
 * Build the left column: the New Query action over the Recent tables and Saved
 * queries lists (each hidden while empty).
 *
 * @param controller - Supplies the quick actions and stored lists.
 *
 * @returns The left column panel.
 */
function buildLeftColumn(controller: SqlAdminController): Panel {
    const column = Panel({ layoutManager: new VBox({ stretching: true, spacing: ENTRY_SPACING }) });

    column.addComponent(actionButton("New Query", () => controller.openQuery(), "plus"));

    appendList(column, "Recent tables", controller.recentTables(),
        ref => actionButton(ref.name ?? "(table)", () => controller.reopenTable(ref)));
    appendList(column, "Saved queries", controller.savedList(),
        (q: SavedQuery) => actionButton(q.name, () => controller.openSavedQuery(q.name)));

    return column;
}

/**
 * Build the right column: the keyboard-shortcut legend over the connection info.
 *
 * @param controller - Supplies the connection id.
 *
 * @returns The right column panel.
 */
function buildRightColumn(controller: SqlAdminController): Panel {
    const column = Panel({ layoutManager: new VBox({ stretching: true, spacing: ENTRY_SPACING }) });

    column.addComponent(buildShortcutLegend());

    column.addComponent(heading("Connection", "600"));
    column.addComponent(mutedText(controller.connectionId));

    return column;
}

/**
 * Append a titled list section, or nothing when the list is empty (the start
 * page stays uncluttered before anything has been opened or saved).
 *
 * @param host - The page panel to append into.
 * @param title - The section header text.
 * @param items - The section's items.
 * @param rowFor - Builds a button for one item.
 */
function appendList<T>(
    host: Panel,
    title: string,
    items: T[],
    rowFor: (item: T) => Component,
): void {
    if (items.length === 0) {
        return;
    }

    host.addComponent(heading(title, "600"));

    for (const item of items) {
        host.addComponent(rowFor(item));
    }
}

/** A section heading (bold, muted). */
function heading(text: string, fontWeight: string): Component {
    const header = new Text(text, { fontWeight });
    header.setForegroundColor(MUTED_TEXT_COLOR);

    return header;
}

/** A muted informational line. */
function mutedText(text: string): Component {
    const line = new Text(text);
    line.setForegroundColor(MUTED_TEXT_COLOR);

    return line;
}

/**
 * A fixed-height, full-width quick-action button.
 *
 * @param text - The button label.
 * @param handler - The click action.
 * @param glyph - Optional leading glyph (registered name).
 *
 * @returns The button component.
 */
function actionButton(text: string, handler: () => void, glyph?: string): Component {
    const button = Button({ glyph, text, compact: true, preferredSize: { width: 0, height: BUTTON_HEIGHT } });
    button.on("action", handler);

    return button;
}
