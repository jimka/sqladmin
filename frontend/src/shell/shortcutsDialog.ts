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
    // Cap the legend viewport to the window so the dialog never grows past the
    // screen. The Dialog sizes its height to the content's preferred height;
    // maxSize caps that preferred height, so a legend taller than the window
    // scrolls inside a viewport-fitting dialog rather than overflowing it — and
    // because the content then fits the dialog's own region exactly, this panel
    // (with its eased autoScroll) is the sole scroller, matching the smooth wheel
    // scroll everywhere else (the same autoScroll + maxSize idiom as FilterDialog).
    // CHROME leaves room for the title bar, button row, and top/bottom margins.
    const CHROME = 160;
    const maxContentHeight = Math.max(200, window.innerHeight - CHROME);

    const content = Panel({
        layoutManager: new VBox({ stretching: true }),
        insets       : new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
        autoScroll   : "y",
        maxSize      : { width: Number.MAX_VALUE, height: maxContentHeight },
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
