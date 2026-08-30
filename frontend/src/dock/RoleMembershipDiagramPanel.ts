// The role-membership graph, opened as its own Dock tab from the Roles rail's
// right-click membership item. Extends FilteredDiagramShell (see
// ./filteredDiagramShell.ts) with a fixed root for its WEST direction/depth+
// legend column; this class supplies the CENTER DiagramView over the whole
// role-membership DAG buildRoleMembershipDiagram assembled, narrowed to the
// chosen role's neighbourhood via the shared direction+depth traversal.
// Reuses RelationGraphPanel's node renderer (relationGraphNodeRenderer) so
// roles draw as plain glyph-and-label nodes, not the FK diagram's table
// cards — there is no per-node FK data for TableCardNode/applyCoverageStyle
// to read here. Double-clicking a node reports its role name back to the
// controller, which shows that role's properties in the inspector; there is
// no per-node object menu, so this panel wires no "contextmenu" listener.
// This tab's title names its root, so the root never changes and no
// `Root …` selector is built.
//
// Class-first (see ../../COMPONENT_CONVENTIONS.md): extends
// FilteredDiagramShell directly, which owns the whole derive/legend/filter
// lifecycle — this panel adds nothing beyond its view construction and one
// listener. The `JunctionDiagramView` and its badged base graph are built as
// locals before `super()` (they are `super()`'s children, and the pre-super()
// base seeds the view's own initial `data` so it renders before
// FilteredDiagramShell's constructor derives its own — see that class's
// header for why both calls agree); the "activate" listener is wired after
// `super()`.

import { callable } from "@jimka/typescript-ui/core";
import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { user }  from "@jimka/typescript-ui/glyphs/solid/user";
import { fixedRootBase } from "../data/relationDiagram";
import { relationGraphNodeRenderer } from "./RelationGraphPanel";
import { FilteredDiagramShell } from "./filteredDiagramShell";
import { depthChoice, depthFromChoice } from "./depthChoices";
import { JunctionDiagramView } from "./JunctionDiagramView";

// The role node glyph this panel renders. Registered here so the panel works
// standalone regardless of import order elsewhere (mirrors
// RoleGrantsDiagramPanel.ts's own `Glyph.register(user)` call for the same
// glyph).
Glyph.register(user);

/**
 * The role-membership diagram panel: the shell's WEST direction / depth +
 * legend column plus a CENTER DiagramView. The root node is emphasized;
 * double-clicking any node invokes `onSelectRole` with its role name.
 */
class RoleMembershipDiagramPanel extends FilteredDiagramShell {
    /**
     * @param full - The whole role-membership DAG (from buildRoleMembershipDiagram).
     * @param root - The rooted role's node data (id = the role name).
     * @param onSelectRole - Invoked with an activated node's role name.
     * @param initialDepth - The `DEPTH_CHOICES` entry the Depth control opens
     *   at (see `depthChoices.ts`); anything else opens at the default.
     */
    constructor(
        full: DiagramData,
        root: DiagramNodeData,
        onSelectRole: (role: string) => void,
        initialDepth?: string,
    ) {
        // Locals before super() — they are super()'s children (this is
        // unavailable until super() returns).
        const depth = depthChoice(initialDepth);
        const base  = fixedRootBase(full, root, "both", depthFromChoice(depth));
        const view = JunctionDiagramView({
            data: base,
            nodeRenderer: relationGraphNodeRenderer(root.id),
            initialFocusNode: root.id,
        });

        super({ view, full, fixedRoot: true, rootNode: root, initialDepth: depth });

        // Wire listeners after super() (this now available).
        this.view.on("activate", (n: DiagramNodeData) => onSelectRole(n.id));
    }
}

const RoleMembershipDiagramPanelCallable = callable(RoleMembershipDiagramPanel);
type RoleMembershipDiagramPanelCallable = RoleMembershipDiagramPanel;
export { RoleMembershipDiagramPanelCallable as RoleMembershipDiagramPanel };
