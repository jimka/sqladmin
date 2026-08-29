// A dismiss-only information modal: a padded content wrapper around the
// caller's body, a title bar, and a footer that always ends in Close. The
// base owns the padded wrapper (a single 16px inset on all four sides) so
// every caller gets identical padding without declaring its own CONTENT_PAD.
// The content must never set its own `autoScroll`: `Dialog`'s own content
// container (`_contentContainer`) already wraps whatever `contentComponent`
// it is handed in a Panel with `autoScroll: "y"`, so a second one nests one
// scroll region inside another — see shortcutsDialog.ts's history for the
// double-scrollbar defect this was written to prevent from recurring.

import { Dialog, DialogButtons }        from "@jimka/typescript-ui/overlay";
import type { DialogButtonConfig }      from "@jimka/typescript-ui/overlay";
import { Panel, callable }              from "@jimka/typescript-ui/core";
import type { Component }               from "@jimka/typescript-ui/core";
import { VBox }                         from "@jimka/typescript-ui/layout";
import { Insets }                       from "@jimka/typescript-ui/primitive";

// The content's padding inset. Exists only here — every caller used to
// declare its own identical CONTENT_PAD = 16.
const CONTENT_PAD = 16;

/** Construction inputs for {@link DismissDialog}. */
export interface DismissDialogOptions {
    /** Title-bar text. */
    title: string;
    /** The dialog body. Mounted inside the padded content wrapper this class owns. */
    content: Component;
    /** Dialog panel width in pixels. */
    width: number;
    /**
     * Extra footer buttons rendered to the LEFT of the always-present Close
     * button, in array order. Omit for a Close-only dialog.
     */
    extraButtons?: DialogButtonConfig[];
}

/**
 * A dismiss-only information modal. Wraps `options.content` in a padded
 * `Panel` before handing it to `Dialog` as `contentComponent`, so callers
 * never build that wrapper themselves.
 */
class DismissDialog extends Dialog {
    /**
     * @param options - the dialog's title, body, width, and any extra
     *   footer buttons rendered to the left of the always-present Close button.
     */
    constructor(options: DismissDialogOptions) {
        const body = Panel({
            // Stretch the content to the dialog's content width so it has a
            // concrete width to wrap and self-measure within.
            layoutManager: new VBox({ itemAlign: "stretch" }),
            insets:        new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
            components:    [options.content],
        });

        super({
            title:            options.title,
            contentComponent: body,
            buttons:          [...(options.extraButtons ?? []), DialogButtons.Close],
            width:            options.width,
            closeOnBackdrop:  true,
        });
    }
}

// Callable-class export: consumers may write `DismissDialog(options)`, no `new`.
const DismissDialogCallable = callable(DismissDialog);
type  DismissDialogCallable = DismissDialog;
export { DismissDialogCallable as DismissDialog };
