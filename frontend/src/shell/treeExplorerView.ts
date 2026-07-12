// The shared sidebar explorer view: a compact two-section Accordion with an
// explorer tree (filling) over a read-only inspector (fixed height). The Database
// and Roles rails are the same shape — only their tree, labels, glyphs, and
// inspector differ — so the assembly lives here once.

import { Component }               from "@jimka/typescript-ui/core";
import { AccordionPanel }          from "@jimka/typescript-ui/component/container";
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
    /** The read-only inspector component and its header label. */
    inspector: Component;
    inspectorLabel: string;
    /** The inspector section's glyph (defaults to `circle-info`). */
    inspectorGlyph?: string;
}

/**
 * Build a sidebar explorer view. Both sections stay open; the tree section takes
 * a fill weight so the accordion grows it into every pixel the fixed-height
 * inspector leaves — the tree fills, the inspector stays compact.
 *
 * @param config - The view's id, its tree + refresh, and the two sections' labels/glyphs.
 *
 * @returns The explorer view component.
 */
export function buildTreeExplorerView(config: TreeExplorerConfig): Component {
    const tree    = config.explorer;
    const refresh = config.explorer.refresh;

    // The tree carries no intrinsic height — its section's fillWeight grows it
    // into the leftover space, so a 0 preferred keeps the sections underflowing
    // (the precondition for fill) regardless of the rail's height.
    tree.setPreferredSize(0, 0);

    const view = new AccordionPanel({
        id: config.id,
        sections: [
            { label: config.treeLabel, component: tree, initiallyOpen: true, glyph: config.treeGlyph, tools: [refreshTool(refresh)], fillWeight: 1 },
            { label: config.inspectorLabel, component: config.inspector, initiallyOpen: true, glyph: config.inspectorGlyph ?? "circle-info" },
        ],
    });

    view.getAccordion().setCompact(true);
    view.getAccordion().setToolsVisibility("always");

    // Alt+R refreshes the tree while this rail has focus (see refreshTool).
    bindRefreshShortcut(view, refresh);

    return view;
}
