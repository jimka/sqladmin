// The shared sidebar explorer view: a compact two-section Accordion with an
// explorer tree (filling) over a read-only inspector (fixed height). The Database
// and Roles rails are the same shape — only their tree, labels, glyphs, and
// inspector differ — so the assembly lives here once.
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

/**
 * A sidebar explorer view: both sections stay open; the tree section takes a
 * fill weight so the accordion grows it into every pixel the fixed-height
 * inspector leaves — the tree fills, the inspector stays compact. Constructed
 * directly for a one-off view, or subclassed (`DatabaseExplorerView`,
 * `RolesExplorerView`) to fix the config for a specific tree.
 */
export class TreeExplorerView extends AccordionPanel {
    /** @param config - The view's id, its tree + refresh, and the two sections' labels/glyphs. */
    constructor(config: TreeExplorerConfig) {
        const tree    = config.explorer;
        const refresh = config.explorer.refresh;

        // The tree carries no intrinsic height — its section's fillWeight grows
        // it into the leftover space, so a 0 preferred keeps the sections
        // underflowing (the precondition for fill) regardless of the rail's
        // height. Pre-super: `this` is unavailable until super() returns.
        tree.setPreferredSize(0, 0);

        super({
            id: config.id,
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
