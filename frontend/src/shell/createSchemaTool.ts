// A glyph-only "Create schema" button for the Database rail's tree-section
// header (the `tools` slot of an AccordionSectionConfig, alongside
// refreshTool's Refresh button) — see treeExplorerView.ts's `treeTools`.
// "Create schema…" used to live in the schema node's context menu, but it is
// database-scoped, not schema-scoped (see NavigatorTree.ts's schema-node
// comment), so it moved here next to the section it actually affects.

import type { Button } from "@jimka/typescript-ui/component/button";
import { glyphButton } from "../dock/glyphButton";
import { PRIMARY_COLOR } from "../theme";

/** Build a compact "Create schema" tool button that runs `onCreate` when clicked. */
export function createSchemaTool(onCreate: () => void): Button {
    return glyphButton("plus", PRIMARY_COLOR, "Create schema", onCreate);
}
