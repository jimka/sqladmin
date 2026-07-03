// A glyph-only refresh button for an accordion section header (the `tools` slot
// of an AccordionSectionConfig). The title drives the hover tooltip and the
// accessible name via showText:false, so the header stays icon-only.

import { Button } from "@jimka/typescript-ui/component/button";

// The shared blue for every Refresh action across the app, matching the table
// toolbar's Refresh (TableWorkPanel's BLUE) so all refresh tools read alike.
const REFRESH_COLOR = "rgb(30, 100, 200)";

/** Build a compact "Refresh" tool button that runs `onRefresh` when clicked. */
export function refreshTool(onRefresh: () => void): Button {
    const button = Button({ glyph: "arrows-rotate", text: "Refresh", showText: false, foregroundColor: REFRESH_COLOR, compact: true });

    button.on("action", onRefresh);

    return button;
}
