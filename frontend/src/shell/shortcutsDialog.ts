// The "Keyboard Shortcuts" dialog: a dismiss-only modal listing every app
// shortcut, reached from the ? accelerator and the menu-bar Shortcuts button.
// Built on `DismissDialog` to match the app's other modals, mirroring
// aboutDialog.ts and changelogDialog.ts.

import { DismissDialog }       from "./DismissDialog";
import { buildShortcutLegend } from "./shortcutLegend";

// The dialog's fixed width. The Dialog sizes its height to the content measured
// at this width; wide enough for the longest "keys  label" row without wrapping.
const DIALOG_WIDTH = 420;

/**
 * Open the modal Keyboard Shortcuts dialog. Fire-and-forget: the only outcome is
 * dismissal (Close, Escape, backdrop, or the title-bar close), so the resolved
 * result is intentionally ignored — and no dispose is needed, since the legend
 * holds no subscriptions.
 */
export function openShortcutsDialog(): void {
    const dialog = new DismissDialog({
        title:   "Keyboard Shortcuts",
        content: buildShortcutLegend(),
        width:   DIALOG_WIDTH,
    });

    void dialog.show();
}
