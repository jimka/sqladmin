// The "About" dialog: a small, dismiss-only modal reached from the far-right of
// the menu bar. It presents a one-line description of what SQLAdmin is, who
// wrote it, and where the app and its UI library live on GitHub. Built on
// `DismissDialog` so it matches the rest of the app's modals; the body is a
// single authored Markdown string rendered by the library's read-only
// Markdown viewer.

import type { DialogButtonConfig } from "@jimka/typescript-ui/overlay";
import { Markdown, Glyph }         from "@jimka/typescript-ui/component/display";
import { DiagnosticsOverlay }      from "@jimka/typescript-ui/diagnostics";
import { gauge_high }              from "@jimka/typescript-ui/glyphs/solid/gauge_high";
import { DismissDialog }           from "./DismissDialog";
import { APP_NAME, APP_TAGLINE, APP_VERSION } from "../appIdentity";

Glyph.register(gauge_high);

// The extra Diagnostics button borrows the 'confirm' result (unused by Close
// alone) to signal itself; the dialog closes either way and openAboutDialog()
// branches on the resolved result. "Debug", not "Diagnostics": every Dialog
// footer button renders at a fixed 90px (Dialog.ts's BUTTON_WIDTH) regardless
// of label length, and "Diagnostics" truncates there — short single words
// (Confirm/Cancel/Close) are the button-label convention throughout the app.
const DIAGNOSTICS_BUTTON: DialogButtonConfig = { text: "Debug", result: "confirm", glyph: "gauge-high" };

// The dialog's fixed width. The Dialog sizes its height to the wrapped content
// (it measures the content at this width), so the body copy can be natural
// sentences that wrap rather than hand-broken single lines.
const DIALOG_WIDTH = 460;

// The dialog body, authored as Markdown, built from the shared appIdentity
// constants so the name/tagline/version can't drift from what the menu-bar
// AppHeader and the start page show. Reproduces the five facts the old
// hand-built line stack showed (app name, description, author, source URL,
// UI-library URL) plus a Version line the old stack had no source for. Blank
// lines between blocks are required so `marked` lexes separate paragraphs/headings.
const ABOUT_MARKDOWN = `# ${APP_NAME}

${APP_TAGLINE} Browse databases, schemas, tables and roles; run, explain and
export SQL.

**Version:** ${APP_VERSION}

**Author:** Jimmy Karlsson

**Source:** [github.com/jimka/sqladmin](https://github.com/jimka/sqladmin)

**UI library:** [github.com/jimka/typescript-ui](https://github.com/jimka/typescript-ui)`;

/**
 * Open the modal About dialog. Fire-and-forget: the only outcome is dismissal
 * (the single Close button, Escape, backdrop, or the title-bar close), so the
 * resolved result is intentionally ignored — but the Markdown body's theme
 * listener is disposed once dismissal resolves.
 */
export function openAboutDialog(): void {
    const dialog = new DismissDialog({
        title:        `About ${APP_NAME}`,
        content:      Markdown(ABOUT_MARKDOWN),
        width:        DIALOG_WIDTH,
        extraButtons: [DIAGNOSTICS_BUTTON],
    });

    void dialog.show().then((result) => {
        if (result === "confirm") {
            DiagnosticsOverlay.open();
        }
    });
}
