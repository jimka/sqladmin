// A glyph-only toolbar button: a colored icon face whose label drives both the
// hover tooltip and the accessible name (aria-label). Shared by the dock work
// panels (table / view / query / role-grants), whose toolbars all build their
// actions this way.

import { Button } from "@jimka/typescript-ui/component/button";

/**
 * Build a compact, glyph-only toolbar button.
 *
 * @param glyph - Registered glyph name for the button face.
 * @param color - Foreground (glyph) color.
 * @param label - Hover tooltip and accessible name; not shown on the face.
 * @param handler - Click handler, passed the originating MouseEvent.
 *
 * @returns The wired button.
 */
export function glyphButton(
    glyph: string,
    color: string,
    label: string,
    handler: (event: MouseEvent) => void,
): Button {
    // showText:false keeps the face glyph-only while the label drives the tooltip
    // and aria-label. showDescription:false keeps any description (e.g. the Filter
    // button's "(active)" state) in the tooltip only, off the glyph-only face.
    const button = Button({ glyph, text: label, showText: false, showDescription: false, foregroundColor: color, compact: true });

    button.on("action", handler);

    return button;
}
