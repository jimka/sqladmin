// The Changelog dialog: a dismiss-only modal rendering the repo root's
// CHANGELOG.md. Built on the library's Dialog (an in-app, styled overlay) so
// it matches the rest of the app's modals; the body is the real changelog
// file, inlined at build time (changelogText.ts) and rendered by the
// library's read-only Markdown viewer. Mirrors aboutDialog.ts.
//
// The title bar reads "SQLAdmin <version>", not "Changelog" — the changelog
// file itself opens with its own `# Changelog` heading, so titling the dialog
// the same word doubled it right above the identical, larger heading.
//
// The content panel carries no `autoScroll` of its own. Dialog's own
// `_contentContainer` (Dialog.ts) is already a Panel with `autoScroll: "y"`
// wrapping whatever `contentComponent` is handed to it, and — per Fit's
// `inflateForOverflow` — that alone is enough for the outer container to grow
// to the content's natural height and let its own `overflow-y: auto` scroll
// it once the dialog caps shorter than that. A second `autoScroll` here
// nested a scroll region inside that scroll region: two independent
// scrollbars stacked over the same one column of text. Leaving this content
// uncapped keeps it working exactly as before, just without the inner one.

import { Dialog, DialogButtons } from "@jimka/typescript-ui/overlay";
import { Panel }                 from "@jimka/typescript-ui/core";
import { VBox }                  from "@jimka/typescript-ui/layout";
import { Markdown }              from "@jimka/typescript-ui/component/display";
import { Insets }                from "@jimka/typescript-ui/primitive";
import { CHANGELOG_MARKDOWN }    from "./changelogText";
import { APP_NAME, APP_VERSION } from "../appIdentity";

// The dialog's fixed width. The Dialog sizes its height to the wrapped content
// (it measures the content at this width), so the body copy can be natural
// sentences that wrap rather than hand-broken single lines. Wider than About's
// 460: the changelog's bullets are multi-sentence paragraphs with nested
// indentation, which wrap every few words at 460.
const DIALOG_WIDTH = 600;

// The content's padding inset, matching the About dialog's.
const CONTENT_PAD = 16;

/**
 * Open the modal Changelog dialog. Fire-and-forget: the only outcome is
 * dismissal (the single Close button, Escape, backdrop, or the title-bar
 * close), so the resolved result is intentionally ignored — but the Markdown
 * body's theme listener is disposed once dismissal resolves.
 */
export function openChangelogDialog(): void {
    // The Dialog caps its own height to the viewport and scrolls its content
    // container when the changelog is taller than the window, re-fitting live
    // as the viewport resizes. So the content is left uncapped: a fixed
    // maxSize captured here would be a stale ceiling that stops the dialog
    // growing back when the viewport is later enlarged. See the module
    // comment for why this panel does not also set `autoScroll`.
    const content = Panel({
        // Stretch the content to the dialog's content width so the Markdown has
        // a concrete width to wrap and self-measure within.
        layoutManager: new VBox({ itemAlign: "stretch" }),
        insets       : new Insets(CONTENT_PAD, CONTENT_PAD, CONTENT_PAD, CONTENT_PAD),
    });

    const md = Markdown(CHANGELOG_MARKDOWN);
    content.addComponent(md);

    const dialog = Dialog({
        title           : `${APP_NAME} ${APP_VERSION}`,
        contentComponent: content,
        buttons         : [DialogButtons.Close],
        width           : DIALOG_WIDTH,
        closeOnBackdrop : true,
    });

    void dialog.show().then(() => md.dispose());
}
