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

import { Component, callable } from "@jimka/typescript-ui/core";
import { AccordionPanel }          from "@jimka/typescript-ui/component/container";
import type { Button }             from "@jimka/typescript-ui/component/button";
import { refreshTool, bindRefreshShortcut } from "./refreshTool";
import type { ExplorerTree }       from "../navigator/NavigatorTree";
import type { AccordionLayoutBinding } from "../data/layoutStore";

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
    /** The rail's saved section open flags + sizes plus their save hooks
     *  (`controller.layout.bindAccordion("database" | "roles")`). */
    layout: AccordionLayoutBinding;
}

// The tree section's floor and its preferred height. Both are set to the same
// value: under the accordion's resizable mode getMinSize is the gutter drag's
// stop, and a Tree reports a min of 0 (it overrides no getMinSize, and the
// default LayoutManager min is 0) — so without a floor the drag could erase
// the tree, and a first layout with no leftover height would store a zero size
// that proportional rescaling can never grow back. 96px is four rows at the
// library Tree's fixed 24px ROW_HEIGHT. Set as preferred too so the section
// never reports min > preferred; the weight below still grows the tree
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
class TreeExplorerView extends AccordionPanel {
    /** @param config - The view's id, its tree + refresh, and the two sections' labels/glyphs. */
    constructor(config: TreeExplorerConfig) {
        const tree    = config.explorer;
        const refresh = config.explorer.refresh;

        // The tree's section takes all the leftover height via its weight below;
        // TREE_MIN_HEIGHT is its floor, not its target. Pre-super: `this` is
        // unavailable until super() returns.
        tree.setPreferredSize({ width: 0, height: TREE_MIN_HEIGHT });
        tree.setMinSize({ width: 0, height: TREE_MIN_HEIGHT });

        // Also pre-super — AccordionPanel has no post-construction initiallyOpen
        // setter (see COMPONENT_CONVENTIONS.md's super-cascade trap).
        const open = config.layout.loadOpen();

        super({
            id: config.id,
            // Draggable gutter between the tree and the inspector, so the user
            // apportions the height. The tree's weight seeds the split at exactly
            // today's geometry (tree fills, inspector at its 220px preferred); a drag
            // is authoritative from then on and survives a section toggle and a rail
            // switch. Keep the tree's weight and the inspector's absence of one exactly
            // as-is — that asymmetry is what makes the inspector the persisted px entry
            // (see data/layoutStore.ts). Do not add setFillHeight: it would flip the
            // inspector to a ratio entry and silently discard every saved array.
            resizable: true,
            sections: [
                { label: config.treeLabel, component: tree, initiallyOpen: open[0], glyph: config.treeGlyph, tools: [...(config.treeTools ?? []), refreshTool(refresh)], weight: 1 },
                { label: config.inspectorLabel, component: config.inspector, initiallyOpen: open[1], glyph: config.inspectorGlyph ?? "circle-info" },
            ],
            onSectionToggle: config.layout.onToggle,
        });

        this.getAccordion().setCompact(true);
        this.getAccordion().setToolsVisibility("always");

        // Restore the saved gutter position, if any (a stale array is discarded by
        // the library; the accordion falls to normal first-layout sizing instead).
        const savedSizes = config.layout.loadSizes();

        if (savedSizes !== null) {
            this.getAccordion().applySectionSizes(savedSizes);
        }

        this.getAccordion().on("sectionresize", config.layout.onSizes);

        // Alt+R refreshes the tree while this rail has focus (see refreshTool).
        bindRefreshShortcut(this, refresh);
    }
}

const TreeExplorerViewCallable = callable(TreeExplorerView);
type TreeExplorerViewCallable = TreeExplorerView;
export { TreeExplorerViewCallable as TreeExplorerView };
