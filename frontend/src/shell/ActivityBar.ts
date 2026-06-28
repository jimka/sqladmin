// The WEST region: a VSCode-style activity bar — a vertical ToolBar rail of
// icon-only ToggleButtons (one per view) beside a Card deck showing the selected
// view. Phase 1 ships a single "Database" button; adding a view is one more
// button + one more Card page (the Phase-2 seam).
//
// The rail is an app-managed mode selector (ToggleButton has no built-in radio
// group) and stays visible at all times — only the deck collapses, VSCode-style.
// A click flips the button's selected state, then the handler reconciles:
//   - now selected (an inactive view was chosen) -> deselect the others, switch
//     the deck to that view, and expand;
//   - now deselected (the active view was clicked again) -> collapse the deck.
// Collapsing hides the deck and shrinks the bar to the rail width (so the Dock
// reclaims the space) while the rail stays put; clicking the icon again expands.
// selected <=> expanded is the single source of truth.

import { Component, Panel } from "@jimka/typescript-ui/core";
import { Placement } from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Card } from "@jimka/typescript-ui/layout";
import { ToolBar } from "@jimka/typescript-ui/component/menubar";
import { ToggleButton } from "@jimka/typescript-ui/component/button";
import { Tooltip } from "@jimka/typescript-ui/overlay";

// Width of the always-visible icon rail, and of the deck beside it when expanded.
const RAIL_WIDTH = 40;
const DECK_WIDTH = 240;

/** One view container in the activity bar: a rail button plus its deck page. */
export interface ActivityView {
    /** Selection key — set as the page component's id; the deck's Card matches it. */
    id:        string;
    /** Hover-tooltip label for the icon-only rail button. */
    label:     string;
    /** Registry glyph name shown on the rail button. */
    glyph:     string;
    /** The view rendered in the deck when this button is active. */
    component: Component;
}

/**
 * Build the activity bar for the shell's WEST region.
 *
 * @param views - The view containers; the first starts active and expanded.
 *
 * @returns The activity-bar component (rail + deck).
 */
export function ActivityBar(views: ActivityView[]): Component {
    const card = new Card();
    const deck = Panel({ layoutManager: card });
    const rail = new ToolBar({ orientation: "vertical" });
    const buttons: ToggleButton[] = [];
    const activityBar = Panel({ layoutManager: new BorderLayout() });

    // Collapse hides the deck and shrinks the bar to the rail width; the rail
    // stays visible. setPreferredSize does not relayout the parent, so ask the
    // shell to re-lay out its regions and reclaim the freed width for the Dock.
    const setCollapsed = (collapsed: boolean): void => {
        deck.setDisplayed(!collapsed);
        activityBar.setPreferredSize(collapsed ? RAIL_WIDTH : RAIL_WIDTH + DECK_WIDTH, 0);
        activityBar.getParentComponent()?.scheduleLayout();
    };

    for (const view of views) {
        deck.addComponent(view.component);

        const isFirst = view === views[0];
        const button = new ToggleButton("", { selected: isFirst });

        // setGlyph (not the `glyph` option): a ToggleButton forwards only `text`
        // to super, so the glyph passed in its options bag is recorded but never
        // rendered — the constructor-time glyph build already ran. See LIBRARY_NOTES.md.
        button.setGlyph(view.glyph);
        Tooltip.attach(button, view.label);

        button.on("action", () => {
            if (button.isSelected()) {
                buttons.forEach(other => { if (other !== button) other.setSelected(false); });
                card.setVisibleComponentId(view.id);
                setCollapsed(false);
            } else {
                setCollapsed(true);
            }
        });

        rail.addComponent(button);
        buttons.push(button);
    }

    rail.setPreferredSize(RAIL_WIDTH, 0);
    card.setVisibleComponentId(views[0].id);

    activityBar.addComponent(rail, { placement: Placement.WEST });
    activityBar.addComponent(deck, { placement: Placement.CENTER });
    activityBar.setPreferredSize(RAIL_WIDTH + DECK_WIDTH, 0);

    return activityBar;
}
