// The shared sidebar explorer view: a compact two-section Accordion with an
// explorer tree (seeded at fill height) over a read-only inspector (seeded at
// its preferred 220px), with a draggable gutter between them so the user can
// apportion the height. The Database and Roles rails are the same shape — only
// their tree, labels, glyphs, and inspector differ — so the assembly lives
// here once.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): the base `extends
// AccordionPanel` directly, so the instance itself is the mountable component.
// DatabaseExplorerView/RolesExplorerView are thin subclasses that forward a
// config to `super(...)` (see those files).

import { Component }               from "@jimka/typescript-ui/core";
import { AccordionPanel }          from "@jimka/typescript-ui/component/container";
import type { Button }             from "@jimka/typescript-ui/component/button";
import { refreshTool, bindRefreshShortcut } from "./refreshTool";
import type { ExplorerTree }       from "../navigator/NavigatorTree";

/** One explorer view: a tree section over a read-only inspector section. */
export interface TreeExplorerConfig {
    /** Card-page key the activity-bar rail selects this view by (the view's id). */
    id: string;
    /** The built explorer tree and its refresh action. */
    explorer: ExplorerTree;
    /** The tree section's header label and glyph. */
    treeLabel: string;
    treeGlyph: string;
    /** Extra header tool buttons for the tree section, after Refresh (e.g. the
     *  Database view's "Create schema" tool). Omitted for a rail with none. */
    treeTools?: Button[];
    /** The read-only inspector component and its header label. */
    inspector: Component;
    inspectorLabel: string;
    /** The inspector section's glyph (defaults to `circle-info`). */
    inspectorGlyph?: string;
}

// The tree section's floor and its preferred height. Both are set to the same
// value: under the accordion's resizable mode getMinSize is the gutter drag's
// stop, and a Tree reports a min of 0 (it overrides no getMinSize, and the
// default LayoutManager min is 0) — so without a floor the drag could erase
// the tree, and a first layout with no leftover height would store a zero size
// that proportional rescaling can never grow back. 96px is four rows at the
// library Tree's fixed 24px ROW_HEIGHT. Set as preferred too so the section
// never reports min > preferred; the fillWeight below still grows the tree
// into all the leftover height, so the rendered result is unchanged.
const TREE_MIN_HEIGHT = 96;

/**
 * A sidebar explorer view: both sections stay open; the tree section takes a
 * fill weight so the accordion grows it into every pixel the inspector's
 * preferred height leaves — the tree seeds at fill, the inspector at its
 * preferred 220px. A draggable gutter (the accordion's resizable mode) lets
 * the user then apportion the height between the two, floored at
 * TREE_MIN_HEIGHT / PANEL_MIN_HEIGHT respectively. Constructed directly for a
 * one-off view, or subclassed (`DatabaseExplorerView`, `RolesExplorerView`) to
 * fix the config for a specific tree.
 */
export class TreeExplorerView extends AccordionPanel {
    /** @param config - The view's id, its tree + refresh, and the two sections' labels/glyphs. */
    constructor(config: TreeExplorerConfig) {
        const tree    = config.explorer;
        const refresh = config.explorer.refresh;

        // The tree's section takes all the leftover height via its fillWeight below;
        // TREE_MIN_HEIGHT is its floor, not its target. Pre-super: `this` is
        // unavailable until super() returns.
        tree.setPreferredSize(0, TREE_MIN_HEIGHT);
        tree.setMinSize(0, TREE_MIN_HEIGHT);

        super({
            id: config.id,
            // Draggable gutter between the tree and the inspector, so the user
            // apportions the height. The tree's fillWeight seeds the split at exactly
            // today's geometry (tree fills, inspector at its 220px preferred); a drag
            // is authoritative from then on and survives a section toggle and a rail
            // switch.
            resizable: true,
            sections: [
                { label: config.treeLabel, component: tree, initiallyOpen: true, glyph: config.treeGlyph, tools: [...(config.treeTools ?? []), refreshTool(refresh)], fillWeight: 1 },
                { label: config.inspectorLabel, component: config.inspector, initiallyOpen: true, glyph: config.inspectorGlyph ?? "circle-info" },
            ],
        });

        this.getAccordion().setCompact(true);
        this.getAccordion().setToolsVisibility("always");

        // Alt+R refreshes the tree while this rail has focus (see refreshTool).
        bindRefreshShortcut(this, refresh);
    }
}
