// A glyph-only "Show database diagram" button for the Database rail's
// tree-section header (the `tools` slot of an AccordionSectionConfig,
// alongside createSchemaTool's Create-schema button and refreshTool's
// Refresh button) — see treeExplorerView.ts's `treeTools`.
// "Database diagram" used to live in the schema node's context menu, but it
// is database-scoped, not schema-scoped (it diagrams every schema, not just
// the clicked one), so it moved here next to the section it actually affects
// — the same move createSchemaTool already made.

import { Button } from "@jimka/typescript-ui/component/button";
import { PRIMARY_COLOR } from "../theme";

/** Build a compact "Show database diagram" tool button that runs `onShow` when clicked. */
export function showDatabaseDiagramTool(onShow: () => void): Button {
    const button = Button({ glyph: "circle-nodes", text: "Show database diagram", showText: false, foregroundColor: PRIMARY_COLOR, compact: true });

    button.on("action", onShow);

    return button;
}
