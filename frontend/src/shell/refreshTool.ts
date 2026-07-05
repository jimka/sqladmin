// A glyph-only refresh button for an accordion section header (the `tools` slot
// of an AccordionSectionConfig). The title drives the hover tooltip and the
// accessible name via showText:false, so the header stays icon-only.
//
// `bindRefreshShortcut` wires the same Alt+R accelerator to a rail: when focus is
// anywhere in the rail's subtree, Alt+R refreshes it and stops there, so the
// document-level Alt+R (which refreshes the active data grid) does not also fire
// — the shortcut acts on whichever refreshable view currently has focus.

import { Button } from "@jimka/typescript-ui/component/button";
import { Event }  from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import { isRefreshChord } from "./queryShortcuts";
import { PRIMARY_COLOR } from "../theme";

/** Build a compact "Refresh" tool button that runs `onRefresh` when clicked. */
export function refreshTool(onRefresh: () => void): Button {
    const button = Button({ glyph: "arrows-rotate", text: "Refresh (Alt+R)", showText: false, foregroundColor: PRIMARY_COLOR, compact: true });

    button.on("action", onRefresh);

    return button;
}

/**
 * Bind Alt+R, scoped to a rail's subtree, to its refresh. Consuming the event
 * (stopPropagation) keeps the document-level Alt+R — which targets the active
 * data grid — from also firing while the rail has focus.
 *
 * @param view - The rail's root component; keydown anywhere within it is caught.
 * @param onRefresh - The rail's refresh action.
 */
export function bindRefreshShortcut(view: Component, onRefresh: () => void): void {
    Event.addSubtreeListener(view, "keydown", (event: KeyboardEvent) => {
        if (isRefreshChord(event)) {
            event.preventDefault();
            event.stopPropagation();
            onRefresh();
        }
    });
}
