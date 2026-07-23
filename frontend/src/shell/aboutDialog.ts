// The "About" dialog: a small, dismiss-only modal reached from the far-right of
// the menu bar. It presents a one-line description of what SQLAdmin is, who
// wrote it, and where the app and its UI library live on GitHub. Built on the
// library's Dialog (an in-app, styled overlay) so it matches the rest of the
// app's modals; the body is a single authored Markdown string rendered by the
// library's read-only Markdown viewer.

import { Dialog, DialogButtons } from "@jimka/typescript-ui/overlay";
import { Panel }                 from "@jimka/typescript-ui/core";
import { VBox }                  from "@jimka/typescript-ui/layout";
import { Markdown }              from "@jimka/typescript-ui/component/display";
import { Insets }                from "@jimka/typescript-ui/primitive";
import { APP_NAME, APP_TAGLINE, APP_VERSION } from "../appIdentity";

// The dialog's fixed width. The Dialog sizes its height to the wrapped content
// (it measures the content at this width), so the body copy can be natural
// sentences that wrap rather than hand-broken single lines.
const DIALOG_WIDTH = 460;

// The content's padding inset.
const CONTENT_PAD = 16;

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
    const content = Panel({
        // Stretch the content to the dialog's content width so the Markdown has
        // a concrete width to wrap and self-measure within.
        layoutManager: new VBox({ stretching: true }),
        insets       : new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
    });

    const md = Markdown(ABOUT_MARKDOWN);
    content.addComponent(md);

    const dialog = Dialog({
        title           : `About ${APP_NAME}`,
        contentComponent: content,
        buttons         : [DialogButtons.Close],
        width           : DIALOG_WIDTH,
        closeOnBackdrop : true,
    });

    void dialog.show().then(() => md.dispose());
}
