// The Changelog dialog: a dismiss-only modal rendering the repo root's
// CHANGELOG.md. Built on `DismissDialog`, so it matches the rest of the app's
// modals; the body is the real changelog file, inlined at build time
// (changelogText.ts) and rendered by the library's read-only Markdown viewer.
// Mirrors aboutDialog.ts.
//
// The title bar reads "SQLAdmin <version>", not "Changelog" — the changelog
// file itself opens with its own `# Changelog` heading, so titling the dialog
// the same word doubled it right above the identical, larger heading.

import { Markdown }              from "@jimka/typescript-ui/component/display";
import { DismissDialog }         from "./DismissDialog";
import { CHANGELOG_MARKDOWN }    from "./changelogText";
import { APP_NAME, APP_VERSION } from "../appIdentity";

// The dialog's fixed width. The Dialog sizes its height to the wrapped content
// (it measures the content at this width), so the body copy can be natural
// sentences that wrap rather than hand-broken single lines. Wider than About's
// 460: the changelog's bullets are multi-sentence paragraphs with nested
// indentation, which wrap every few words at 460.
const DIALOG_WIDTH = 600;

/**
 * Open the modal Changelog dialog. Fire-and-forget: the only outcome is
 * dismissal (the single Close button, Escape, backdrop, or the title-bar
 * close), so the resolved result is intentionally ignored — but the Markdown
 * body's theme listener is disposed once dismissal resolves, via
 * `DismissDialog`'s own teardown.
 */
export function openChangelogDialog(): void {
    const dialog = new DismissDialog({
        title:   `${APP_NAME} ${APP_VERSION}`,
        content: Markdown(CHANGELOG_MARKDOWN),
        width:   DIALOG_WIDTH,
    });

    void dialog.show();
}
