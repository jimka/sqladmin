// The WEST region: a VSCode-style activity bar — a vertical ToolBar rail of
// icon-only ToggleButtons (one per view) beside a Card deck showing the selected
// view. Phase 1 ships a single "Database" button; adding a view is one more
// button + one more Card page (the Phase-2 seam).
//
// The rail is an app-managed mode selector (ToggleButton has no built-in radio
// group) and stays visible at all times — only the deck collapses, VSCode-style.
// A click flips the button's selected state, then the handler reconciles:
//   - now selected (an inactive view was chosen) -> show that view (deselect the
//     others, switch the deck, expand);
//   - now deselected (the active view was clicked again) -> collapse the deck.
// Collapsing hides the deck and asks the shell to pin the sidebar to the rail
// width (via an injected SidebarSizer that drives the shell's Split — see
// setSizer) so the Dock reclaims the space, while the rail stays put; clicking
// the icon again expands. The same collapse/expand is exposed as
// `toggleCollapsed` for the menu's "Toggle Sidebar" command.

import { Component, Container }             from "@jimka/typescript-ui/core";
import { Placement, Insets }            from "@jimka/typescript-ui/primitive";
import { Border as BorderLayout, Card } from "@jimka/typescript-ui/layout";
import { ToolBar }                      from "@jimka/typescript-ui/component/menubar";
import { ToggleButton }                 from "@jimka/typescript-ui/component/button";
import { Tooltip }                      from "@jimka/typescript-ui/overlay";

// Width of the always-visible icon rail — one icon-button column, matching the
// narrow VSCode activity-bar strip — and of the explorer deck beside it when
// expanded (a comfortable navigator/properties column).
const RAIL_WIDTH = 40;
const DECK_WIDTH = 240;

// The shell (which owns the Split hosting this bar) needs the collapsed rail
// width to pin the sidebar pane, and the natural expanded width to seed it.
// Exported so those magic numbers stay single-sourced here.
export const SIDEBAR_RAIL_WIDTH    = RAIL_WIDTH;
export const SIDEBAR_DEFAULT_WIDTH = RAIL_WIDTH + DECK_WIDTH;

// Square size of the rail icons, pinned so they stay this size regardless of
// theme font metrics. Sized to read clearly within the RAIL_WIDTH column.
const GLYPH_SIZE = 24;

/** One view container in the activity bar: a rail button plus its deck page. */
export interface ActivityView {
    /** Selection key — set as the page component's id; the deck's Card matches it. */
    id:        string;
    /** Hover-tooltip label for the icon-only rail button. */
    label:     string;
    /** Optional accelerator (e.g. "Alt+D") appended to the hover tooltip. */
    shortcut?: string;
    /** Registry glyph name shown on the rail button. */
    glyph:     string;
    /** The view rendered in the deck when this button is active. */
    component: Component;
}

/**
 * Drives the width of the sidebar pane in the shell's Split. The shell owns the
 * Split and injects this so the bar can collapse/expand without knowing about
 * the Split, its pane references, or its remembered width.
 */
export interface SidebarSizer {
    /** Pin the sidebar pane to the rail width (min == max) and hold it there. */
    collapse(): void;
    /** Restore a draggable width (min < max) and reopen to the remembered width. */
    expand(): void;
}

/** The activity bar plus the external collapse control the menu drives. */
export interface ActivityBarHandle {
    /** The activity-bar component to mount in the shell's sidebar pane. */
    component: Component;
    /** Collapse the deck if expanded, or re-open the active view if collapsed. */
    toggleCollapsed(): void;
    /** Wire the Split-backed sizer once the shell has built the Split. */
    setSizer(sizer: SidebarSizer): void;
    /** Select and expand a view by its id (the menu's entry point to a view). */
    selectView(id: string): void;
}

/**
 * Build the activity bar for the shell's WEST region.
 *
 * @param views - The view containers; the first starts active and expanded.
 *
 * @returns The activity-bar component and its collapse toggle.
 */
export function ActivityBar(views: ActivityView[]): ActivityBarHandle {
    const card        = new Card();
    const deck        = Container({ layoutManager: card, insets: new Insets(0, 0, 0, 0) });
    const rail        = new ToolBar({ orientation: "vertical" });
    const activityBar = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
    const buttonById  = new Map<string, ToggleButton>();

    // The last-shown view (restored on expand), the current collapsed state, and
    // the shell-injected sizer that drives the sidebar pane in the Split.
    let activeId = views[0].id;
    let collapsed = false;
    let sizer: SidebarSizer | null = null;

    // Collapse hides the deck and asks the shell's Split to pin the sidebar to
    // the rail width; the rail stays visible. The Split ignores a pane's
    // preferred size after its one-time seed, so the width is driven through the
    // sizer's min/max pin rather than by mutating this bar's preferred size. The
    // sizer is absent only before the shell wires it (never during a toggle).
    //
    // Only act on an actual collapsed-state transition: showView calls this with
    // `false` on every view switch, but switching Databases <-> Roles is an
    // expanded->expanded change that must not touch the sidebar width. Re-running
    // sizer.expand() (setPaneSize + doLayout) on each switch let the pane creep
    // wider, and would also discard a width the user had dragged. Guarding on the
    // transition leaves the pane's width untouched across switches.
    const setCollapsed = (value: boolean): void => {
        if (value === collapsed) {
            return;
        }

        collapsed = value;
        deck.setDisplayed(!value);

        if (value) {
            sizer?.collapse();
        } else {
            sizer?.expand();
        }
    };

    // Make `id` the active view: select only its rail button, show its deck page,
    // and ensure the deck is expanded.
    const showView = (id: string): void => {
        buttonById.forEach((button, buttonId) => button.setSelected(buttonId === id));
        card.setVisibleComponentId(id);
        activeId = id;
        setCollapsed(false);
    };

    // Collapse the deck; the rail stays, with no active highlight while collapsed.
    const collapse = (): void => {
        buttonById.forEach(button => button.setSelected(false));
        setCollapsed(true);
    };

    const toggleCollapsed = (): void => {
        if (collapsed) {
            showView(activeId);
        } else {
            collapse();
        }
    };

    for (const view of views) {
        deck.addComponent(view.component);

        const button = new ToggleButton("", { selected: view.id === activeId, glyph: view.glyph });

        button.pinGlyphSize(GLYPH_SIZE);
        Tooltip.attach(button, view.shortcut ? `${view.label} (${view.shortcut})` : view.label);

        // The click already flipped `selected`: now-selected means this view was
        // chosen (show it); now-deselected means the active view was clicked off.
        button.on("action", () => (button.isSelected() ? showView(view.id) : collapse()));

        rail.addComponent(button);
        buttonById.set(view.id, button);
    }

    rail.setPreferredSize(RAIL_WIDTH, 0);
    card.setVisibleComponentId(activeId);

    // Zero the bar's content insets: with the default inset, collapsing the bar
    // to RAIL_WIDTH would squeeze the rail (the Border insets eat into the WEST
    // region), so the rail width — and thus the icon column — would change across
    // toggles. Flush insets keep the rail a constant width in both states.
    activityBar.addComponent(rail, { placement: Placement.WEST });
    activityBar.addComponent(deck, { placement: Placement.CENTER });
    activityBar.setPreferredSize(RAIL_WIDTH + DECK_WIDTH, 0);

    return {
        component: activityBar,
        toggleCollapsed,
        setSizer: (value: SidebarSizer): void => { sizer = value; },
        selectView: showView,
    };
}
