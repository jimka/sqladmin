// The "About" dialog: a small, dismiss-only modal reached from the far-right of
// the menu bar. It presents a one-line description of what SQL Admin is, who
// wrote it, and where the app and its UI library live on GitHub. Built on the
// library's Dialog (an in-app, styled overlay) so it matches the rest of the
// app's modals; the content is a VBox of Text lines rather than a plain
// `message` so the heading can stand out from the body.

import { Dialog, DialogButtons } from "@jimka/typescript-ui/overlay";
import { Panel }                 from "@jimka/typescript-ui/core";
import type { Component }        from "@jimka/typescript-ui/core";
import { VBox }                  from "@jimka/typescript-ui/layout";
import { Text }                  from "@jimka/typescript-ui/component/input";
import { Insets }                from "@jimka/typescript-ui/primitive";

// Wide enough that each line below fits without wrapping (the Dialog auto-sizes
// its height from the content's single-line rows, so a wrapped line would be
// clipped — see the deliberately short lines in openAboutDialog).
const DIALOG_WIDTH = 460;

// Vertical rhythm for the stacked lines and the content's padding inset.
const LINE_SPACING = 8;
const CONTENT_PAD  = 16;

// Muted grey for secondary lines (author / links), matching the start page.
const MUTED_COLOR = "rgb(120, 120, 120)";

/** One line of about-text; `muted` greys secondary lines, `weight` bolds a heading. */
function line(text: string, opts?: { muted?: boolean; weight?: string }): Component {
    // Wrap rather than ellipsis-truncate: Text defaults to a single clipped line,
    // but the description and link lines are longer than the dialog is wide.
    const el = new Text(text, opts?.weight ? { fontWeight: opts.weight } : undefined);
    el.setWhiteSpace("normal");
    el.setWordBreak("break-word");

    if (opts?.muted) {
        el.setForegroundColor(MUTED_COLOR);
    }

    return el;
}

/**
 * Open the modal About dialog. Fire-and-forget: the only outcome is dismissal
 * (the single Close button, Escape, backdrop, or the title-bar close), so the
 * resolved result is intentionally ignored.
 */
export function openAboutDialog(): void {
    const content = Panel({
        // Stretch the lines to the content width so the wrapping Text has a width
        // to wrap within (a content-sized Text would stay one long clipped line).
        layoutManager: new VBox({ spacing: LINE_SPACING, stretching: true }),
        insets       : new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
    });

    // Kept to short, single-line rows: the Dialog derives its height from the
    // content's preferred (single-line) height, so a line long enough to wrap
    // would have its second line clipped.
    content.addComponent(line("SQL Admin", { weight: "600" }));
    content.addComponent(line("A browser-based PostgreSQL administration & query tool."));
    content.addComponent(line("Browse databases, schemas, tables and roles;"));
    content.addComponent(line("run, explain and export SQL."));
    content.addComponent(line("Author: Jimmy Karlsson", { muted: true }));
    content.addComponent(line("Source: github.com/jimka/sqladmin", { muted: true }));
    content.addComponent(line("UI library: github.com/jimka/typescript-ui", { muted: true }));

    const dialog = Dialog({
        title           : "About SQL Admin",
        contentComponent: content,
        buttons         : [DialogButtons.Close],
        width           : DIALOG_WIDTH,
        closeOnBackdrop : true,
    });

    void dialog.show();
}
