// A glyph-only refresh button for an accordion section header (the `tools` slot
// of an AccordionSectionConfig). The title drives the hover tooltip and the
// accessible name via showText:false, so the header stays icon-only.

import { Button } from "@jimka/typescript-ui/component/button";

/** Build a compact "Refresh" tool button that runs `onRefresh` when clicked. */
export function refreshTool(onRefresh: () => void): Button {
    const button = Button({ glyph: "arrows-rotate", text: "Refresh", showText: false, compact: true });

    button.on("action", onRefresh);

    return button;
}
