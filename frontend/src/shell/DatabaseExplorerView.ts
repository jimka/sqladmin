// The Database explorer — the single Card page in the activity bar's deck (the
// Phase-2 seam adds more pages). A compact Accordion of two sections: the lazy
// object navigator over the read-only Properties inspector. Both sections stay
// open; the navigator carries an outsized preferred height so the accordion's
// shrink hands it all the space the fixed-height Properties section leaves — the
// navigator fills, Properties stays compact. (The accordion has no per-section
// fill weight; see LIBRARY_NOTES.md.)

import { Component }               from "@jimka/typescript-ui/core";
import { AccordionPanel }          from "@jimka/typescript-ui/component/container";
import { NavigatorTree }           from "../navigator/NavigatorTree";
import type { SqlAdminController } from "../SqlAdminController";

// A preferred height large enough to always overflow the sidebar, so the
// accordion's shrink gives the navigator section every pixel the fixed-height
// Properties section leaves.
const NAV_FILL_HINT = 10000;

/**
 * Build the Database explorer view (Navigator + Properties accordion).
 *
 * @param controller - The mediator owning the navigator's data and the
 *   Properties inspector.
 * @param id - The Card-page key the activity-bar rail selects this view by; it
 *   becomes the view component's id, which the deck's `Card` matches against.
 *
 * @returns The explorer view component.
 */
export function DatabaseExplorerView(controller: SqlAdminController, id: string): Component {
    const navigator = NavigatorTree(controller);

    navigator.setPreferredSize(0, NAV_FILL_HINT);

    const view = new AccordionPanel({
        id,
        sections: [
            { label: "Navigator", component: navigator, initiallyOpen: true, glyph: "database" },
            { label: "Properties", component: controller.properties.component, initiallyOpen: true, glyph: "circle-info" },
        ],
    });

    view.getAccordion().setCompact(true);

    return view;
}
