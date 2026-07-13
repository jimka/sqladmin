// The "Keyboard Shortcuts" dialog: a dismiss-only modal listing every app
// shortcut, reached from the ? accelerator and the menu-bar Shortcuts button.
// Built on the library's Dialog to match the app's other modals, mirroring
// aboutDialog.ts — but without the Markdown disposal, because the legend is pure
// Text/Grid and holds no theme subscription.

import { Dialog, DialogButtons } from "@jimka/typescript-ui/overlay";
import { Panel }                 from "@jimka/typescript-ui/core";
import { VBox }                  from "@jimka/typescript-ui/layout";
import { Insets }                from "@jimka/typescript-ui/primitive";
import { buildShortcutLegend }   from "./shortcutLegend";

// The dialog's fixed width. The Dialog sizes its height to the content measured
// at this width; wide enough for the longest "keys  label" row without wrapping.
const DIALOG_WIDTH = 420;

// The content's padding inset, matching the About dialog's.
const CONTENT_PAD = 16;

/**
 * Open the modal Keyboard Shortcuts dialog. Fire-and-forget: the only outcome is
 * dismissal (Close, Escape, backdrop, or the title-bar close), so the resolved
 * result is intentionally ignored — and no dispose is needed, since the legend
 * holds no subscriptions.
 */
export function openShortcutsDialog(): void {
    // The Dialog caps its own height to the viewport and scrolls its content
    // container when the legend is taller than the window, re-fitting live as the
    // viewport resizes. So the content is left uncapped: a fixed maxSize captured
    // here would be a stale ceiling that stops the dialog growing back when the
    // viewport is later enlarged. autoScroll keeps the eased wheel scroll for the
    // capped case, matching the smooth scroll everywhere else.
    const content = Panel({
        layoutManager: new VBox({ stretching: true }),
        insets       : new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
        autoScroll   : "y",
    });
    content.addComponent(buildShortcutLegend());

    const dialog = Dialog({
        title           : "Keyboard Shortcuts",
        contentComponent: content,
        buttons         : [DialogButtons.Close],
        width           : DIALOG_WIDTH,
        closeOnBackdrop : true,
    });

    void dialog.show();
}
