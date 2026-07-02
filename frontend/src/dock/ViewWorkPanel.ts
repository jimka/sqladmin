// The dock work panel for one view or materialized view: a read-only, paginated
// data grid with a Data | Definition toggle. Unlike TableWorkPanel there are NO
// write actions (Add/Delete/Save) — a view is read-only — so the store's
// mutation methods are never invoked and the write toolbar is omitted entirely.
//
// Expected behaviour (verified live — the DOM is not exercised by the node test
// harness; see vitest.config.ts):
//   * The Data page shows the view's rows through the same paginated AjaxStore a
//     table uses; every cell is locked (rowReadOnly).
//   * The Definition page shows the pg_get_viewdef SQL in a read-only, selectable
//     TextArea. The definition is fetched LAZILY on the first switch to the
//     Definition tab and cached, so re-toggling never refetches.
//   * A failed definition fetch surfaces via onError and leaves a short error
//     note in the pane rather than a blank area.
//   * Refresh reloads the grid (store.load(); no reject() — there are no pending
//     edits on a read-only store).

import { Component, Panel }        from "@jimka/typescript-ui/core";
import { Placement }               from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Card, Fit } from "@jimka/typescript-ui/layout";
import { ToolBar }                 from "@jimka/typescript-ui/component/menubar";
import { Spacer }                  from "@jimka/typescript-ui/component/container";
import { Button }                  from "@jimka/typescript-ui/component/button";
import { Table }                   from "@jimka/typescript-ui/component/table";
import type { ColumnSpec }         from "@jimka/typescript-ui/component/table";
import { TextArea }                from "@jimka/typescript-ui/component/input";
import { Glyph }                   from "@jimka/typescript-ui/component/display";
import type { AjaxStore }          from "@jimka/typescript-ui/data";
import { refresh }                 from "@jimka/typescript-ui/glyphs/solid/refresh";
import type { ColumnMeta }         from "../contract";

Glyph.register(refresh);

/** Neutral toolbar glyph color, matching TableWorkPanel's Refresh action. */
const BLUE = "rgb(30, 100, 200)";

// Card child ids the Data | Definition toggle switches between.
const DATA_PAGE       = "data";
const DEFINITION_PAGE = "definition";

/** Lazily fetch the view's definition SQL (bound to the ref by the controller). */
export type LoadDefinition = () => Promise<string>;

/**
 * Build the read-only work panel for a view/materialized view: a paginated data
 * grid plus a lazily-loaded Definition tab.
 *
 * @param store - The paginated AjaxStore over the view's rows (never written to).
 * @param columns - The view's introspected columns (drive the grid's columns).
 * @param loadDefinition - Fetches the pg_get_viewdef SQL on first Definition switch.
 * @param onError - Surfaces a failed definition fetch (the controller's notifyError).
 * @returns The assembled panel.
 */
export function ViewWorkPanel(
    store         : AjaxStore,
    columns       : ColumnMeta[],
    loadDefinition: LoadDefinition,
    onError       : (error: unknown) => void,
): Panel {
    // Read-only grid: every cell is locked (rowReadOnly), the same lock
    // StructurePanel/RoleGrantsPanel use.
    const dataGrid = Table(store, buildViewColumnSpec(columns));
    dataGrid.setId(DATA_PAGE);

    // Read-only, selectable definition text. Seeded with a loading note so the
    // first switch never shows a blank pane before the fetch resolves.
    const definitionArea = new TextArea("-- Loading definition…", { readOnly: true });
    definitionArea.setId(DEFINITION_PAGE);

    const card = new Card({ visibleComponentId: DATA_PAGE });
    const body = new Component();
    body.setLayoutManager(card);
    body.addComponent(dataGrid);
    body.addComponent(definitionArea);

    const toolBar = buildToolBar(store, card, definitionArea, loadDefinition, onError);

    const panel = Panel({ layoutManager: new BorderLayout() });
    panel.addComponent(toolBar, { placement: Placement.NORTH });
    panel.addComponent(Panel({ layoutManager: new Fit(), components: [body] }), { placement: Placement.CENTER });

    return panel;
}

/**
 * Build the data grid's column spec: one column per introspected field, with
 * every row locked read-only (a view is never edited through this panel).
 */
function buildViewColumnSpec(columns: ColumnMeta[]): ColumnSpec {
    return { columns: columns.map(c => ({ field: c.name })), rowReadOnly: () => true };
}

/**
 * Build the toolbar: a Data | Definition segmented toggle, a flex spacer, and a
 * Refresh button. The toggle drives the Card; the Definition button triggers the
 * lazy, once-only definition fetch.
 */
function buildToolBar(
    store         : AjaxStore,
    card          : Card,
    definitionArea: TextArea,
    loadDefinition: LoadDefinition,
    onError       : (error: unknown) => void,
): ToolBar {
    const dataButton       = new Button({ text: "Data", compact: true });
    const definitionButton = new Button({ text: "Definition", compact: true });

    /** Reflect the active page by disabling its (already-selected) toggle button. */
    const syncActive = (activeId: string): void => {
        dataButton.setEnabled(activeId !== DATA_PAGE);
        definitionButton.setEnabled(activeId !== DEFINITION_PAGE);
    };

    const showData = (): void => {
        card.setVisibleComponentId(DATA_PAGE);
        syncActive(DATA_PAGE);
    };

    // Once-guard: set before the await so a rapid double-click can't double-fetch,
    // and the cached text is reused on every later toggle.
    let definitionRequested = false;

    const showDefinition = (): void => {
        card.setVisibleComponentId(DEFINITION_PAGE);
        syncActive(DEFINITION_PAGE);

        if (definitionRequested) {
            return;
        }

        definitionRequested = true;
        void loadDefinitionInto(definitionArea, loadDefinition, onError);
    };

    dataButton.on("action", showData);
    definitionButton.on("action", showDefinition);
    syncActive(DATA_PAGE);

    return new ToolBar({
        components: [
            dataButton,
            definitionButton,
            // Flex spacer pushes Refresh to the far right, away from the toggle.
            Spacer.flex(),
            // No reject() before load(): a read-only store has no pending edits.
            glyphButton("refresh", BLUE, "Refresh", () => void store.load()),
        ],
    });
}

/**
 * Fetch the definition SQL and place it in the text area, or on failure leave a
 * short error note and surface the error.
 */
async function loadDefinitionInto(
    definitionArea: TextArea,
    loadDefinition: LoadDefinition,
    onError       : (error: unknown) => void,
): Promise<void> {
    try {
        const sql = await loadDefinition();
        definitionArea.setValue(sql);
    } catch (error) {
        definitionArea.setValue("-- Failed to load the view definition.");
        onError(error);
    }
}

/** A glyph-only toolbar button: colored icon, hover tooltip + accessible name, click handler. */
function glyphButton(glyph: string, color: string, label: string, handler: () => void): Button {
    // showText:false keeps the face glyph-only while the label drives both the
    // hover tooltip and the aria-label (accessible name) — no manual setLabel.
    const button = Button({ glyph, text: label, showText: false, foregroundColor: color, compact: true });

    button.on("action", handler);

    return button;
}
