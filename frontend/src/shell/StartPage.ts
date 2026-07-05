// The empty-workspace start page — an app-owned welcome surface shown in the
// shell's CENTER (a Card deck alongside the Dock) whenever no dock panels are
// open. The controller toggles this deck off the Dock's "emptychange" event, so
// no panel bookkeeping lives here; the page itself is a plain composed Panel of
// quick actions, recent tables, saved queries, connection info, and keyboard
// hints. It rebuilds on the controller's onWorkspaceChanged seam so the
// recent/saved lists stay current.

import { Component, Panel }         from "@jimka/typescript-ui/core";
import { VBox }                     from "@jimka/typescript-ui/layout";
import { Insets }                   from "@jimka/typescript-ui/primitive";
import { Text }                     from "@jimka/typescript-ui/component/input";
import { Button }                   from "@jimka/typescript-ui/component/button";
import { Glyph }                    from "@jimka/typescript-ui/component/display";
import { plus }                     from "@jimka/typescript-ui/glyphs/solid/plus";
import { NEW_QUERY_SHORTCUT, OPEN_SAVED_SHORTCUT, QUERY_HISTORY_SHORTCUT } from "./queryShortcuts";
import type { SavedQuery }          from "../data/queryStore";
import type { SqlAdminController }  from "../SqlAdminController";
import { MUTED_TEXT_COLOR }         from "../theme";

Glyph.register(plus);

// Padding around the welcome content, the vertical gap between stacked entries,
// and the fixed height of each action button — comfortable click targets that
// read as a "jump back in" list with a little more breathing room than the
// denser Queries-view lists.
const PAGE_PADDING = 24;
const ENTRY_SPACING = 6;
const BUTTON_HEIGHT = 30;

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

    /** Repopulate the page from the current stores. */
    function rebuild(): void {
        page.removeAllComponents();

        page.addComponent(heading("SQL Admin", "600"));
        page.addComponent(actionButton("New Query", () => controller.openQuery(), "plus"));

        appendList(page, "Recent tables", controller.recentTables(),
            ref => actionButton(ref.name ?? "(table)", () => controller.reopenTable(ref)));
        appendList(page, "Saved queries", controller.savedList(),
            (q: SavedQuery) => actionButton(q.name, () => controller.openSavedQuery(q.name)));

        page.addComponent(heading("Connection", "600"));
        page.addComponent(mutedText(controller.connectionId));

        page.addComponent(heading("Keyboard", "600"));
        for (const hint of keyboardHints()) {
            page.addComponent(mutedText(hint));
        }

        page.doLayout();
    }

    controller.onWorkspaceChanged(rebuild);
    rebuild();

    return page;
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

/** The keyboard hints shown at the bottom of the start page. */
function keyboardHints(): string[] {
    return [
        "Ctrl/Cmd+Enter — run the query",
        "Ctrl/Cmd+↑ / ↓ — browse query history",
        `${NEW_QUERY_SHORTCUT} — new query`,
        `${OPEN_SAVED_SHORTCUT} — saved queries`,
        `${QUERY_HISTORY_SHORTCUT} — query history`,
    ];
}
