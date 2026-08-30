// A glyph-only refresh button for an accordion section header (the `tools` slot
// of an AccordionSectionConfig). Built through glyphButton, which owns the
// icon-only face's mechanics — the label drives the tooltip and accessible
// name, never the face itself.
//
// `bindRefreshShortcut` wires the same Alt+R accelerator to a rail: when focus is
// anywhere in the rail's subtree, Alt+R refreshes it and stops there, so the
// document-level Alt+R (which refreshes the active data grid) does not also fire
// — the shortcut acts on whichever refreshable view currently has focus.

import type { Button } from "@jimka/typescript-ui/component/button";
import { Event }  from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import { isRefreshChord, REFRESH_SHORTCUT } from "./queryShortcuts";
import { glyphButton } from "../dock/glyphButton";
import { PRIMARY_COLOR } from "../theme";

/** Build a compact "Refresh" tool button that runs `onRefresh` when clicked. */
export function refreshTool(onRefresh: () => void): Button {
    return glyphButton("refresh", PRIMARY_COLOR, `Refresh (${REFRESH_SHORTCUT})`, onRefresh);
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
