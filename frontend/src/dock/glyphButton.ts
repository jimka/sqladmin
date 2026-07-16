// A glyph-only toolbar button: a colored icon face whose label drives both the
// hover tooltip and the accessible name (aria-label). Shared by the dock work
// panels (table / view / query / role-grants), whose toolbars all build their
// actions this way. `glyphMenuButton` is the same face wired to a dropdown
// menu instead of a click handler.

import { Button }     from "@jimka/typescript-ui/component/button";
import { MenuButton } from "@jimka/typescript-ui/component/button";
import type { ButtonOptions }  from "@jimka/typescript-ui/component/button";
import type { MenuItemConfig } from "@jimka/typescript-ui/component/container";

/**
 * The shared glyph-only face: showText:false keeps the face glyph-only while
 * the label drives the tooltip and aria-label; showDescription:false keeps any
 * description (e.g. the Filter button's "(active)" state) in the tooltip
 * only. One owner, so the plain and menu variants cannot drift apart in a
 * toolbar that mixes them.
 *
 * @param glyph - Registered glyph name for the button face.
 * @param color - Foreground (glyph) color.
 * @param label - Hover tooltip and accessible name; not shown on the face.
 *
 * @returns The shared options bag for both `glyphButton` and `glyphMenuButton`.
 */
function glyphButtonOptions(glyph: string, color: string, label: string): ButtonOptions {
    return { glyph, text: label, showText: false, showDescription: false, foregroundColor: color, compact: true };
}

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
    const button = Button(glyphButtonOptions(glyph, color, label));

    button.on("action", handler);

    return button;
}

/**
 * Build a compact, glyph-only toolbar button whose click opens a dropdown menu
 * anchored under the button (flipping above it when the room below is short).
 *
 * @param glyph - Registered glyph name for the button face.
 * @param color - Foreground (glyph) color.
 * @param label - Hover tooltip and accessible name; not shown on the face.
 * @param menuItems - The dropdown's items, or a provider re-invoked on every open.
 *
 * @returns The wired menu button.
 */
export function glyphMenuButton(
    glyph: string, color: string, label: string, menuItems: MenuItemConfig[] | (() => MenuItemConfig[]),
): MenuButton {
    // Options-only call form, exactly as glyphButton constructs its Button — the
    // label rides in the bag as `text`, never positionally (MenuButton("x", {…})
    // as a *call* is TS2554, same as Button today). MenuButton wires its own
    // "action" listener, so there is no handler to pass.
    return MenuButton({ ...glyphButtonOptions(glyph, color, label), menuItems });
}
