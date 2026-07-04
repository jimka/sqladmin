// The localStorage inspector: a floating, resizable Window (reached from the
// Tools menu) that dumps every key currently in the browser's localStorage with
// its value pretty-printed, and offers a one-click "Clear SQL Admin data" that
// removes the app's own keys. A non-modal Window (not a Dialog) so it can stay
// open beside the app while you inspect or clear stored state.
//
// The dump is shown in a single read-only, scrolling TextArea rather than a
// stack of labels: localStorage values are multi-line JSON, and the library's
// one-line Text would clip them.
//
// Self-contained on window.localStorage: the app's persisted state is exactly
// the `sqladmin.*` keys (query history + saved queries, see data/queryStore.ts),
// which are read fresh on each access, so removing them here needs no cache
// invalidation. The Queries rail, if open, only reflects a clear on its next
// refresh.

import { Window }               from "@jimka/typescript-ui/overlay";
import { Panel }                from "@jimka/typescript-ui/core";
import type { Component }       from "@jimka/typescript-ui/core";
import { Border, HBox }         from "@jimka/typescript-ui/layout";
import { TextArea }             from "@jimka/typescript-ui/component/input";
import { Button }               from "@jimka/typescript-ui/component/button";
import { Spacer }               from "@jimka/typescript-ui/component/container";
import { Insets, Placement }    from "@jimka/typescript-ui/primitive";

// The prefix the app namespaces its persisted keys under (data/queryStore.ts).
// "Clear SQL Admin data" removes exactly these, leaving any unrelated origin
// keys the inspector also lists untouched.
const APP_KEY_PREFIX = "sqladmin.";

// Initial window geometry; the window is freely movable and resizable after.
const WIN_X = 120;
const WIN_Y = 120;
const WIN_W = 560;
const WIN_H = 460;

// Spacing and padding for the button row.
const BUTTON_SPACING = 8;
const PAD            = 12;

/** Every key currently in localStorage, in insertion order. */
function allKeys(): string[] {
    const keys: string[] = [];

    for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);

        if (key !== null) {
            keys.push(key);
        }
    }

    return keys;
}

/** A key's value, pretty-printed as JSON when it parses, else the raw string. */
function readValue(key: string): string {
    const raw = window.localStorage.getItem(key) ?? "";

    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
}

/** The full localStorage dump: each key followed by its pretty-printed value. */
function dumpStorage(): string {
    const keys = allKeys();

    if (keys.length === 0) {
        return "localStorage is empty.";
    }

    return keys.map(key => `${key}\n${readValue(key)}`).join("\n\n");
}

/** Remove the app's own (`sqladmin.*`) keys, leaving any other origin keys intact. */
function clearAppKeys(): void {
    for (const key of allKeys()) {
        if (key.startsWith(APP_KEY_PREFIX)) {
            window.localStorage.removeItem(key);
        }
    }
}

/**
 * Open the localStorage inspector window. Fire-and-forget: the window owns its
 * own lifecycle (title-bar close, or the in-content Close button).
 */
export function openLocalStorageWindow(): void {
    const win = new Window("Local Storage");

    win.setX(WIN_X);
    win.setY(WIN_Y);
    win.setWidth(WIN_W);
    win.setHeight(WIN_H);

    win.setContentFactory(() => buildContent(win));
    win.show();
}

/**
 * Build the window content: a read-only, scrolling dump of localStorage over a
 * trailing button row (Clear · Close). The dump is refreshed in place after a
 * clear so the view reflects the emptied storage without reopening the window.
 */
function buildContent(win: Window): Component {
    const view = new TextArea(dumpStorage());
    view.setReadOnly(true);

    const clearButton = Button({ text: "Clear SQL Admin data", showText: true, compact: true });
    clearButton.on("action", () => {
        clearAppKeys();
        view.setValue(dumpStorage());
    });

    const closeButton = Button({ text: "Close", showText: true, compact: true });
    closeButton.on("action", () => win.requestClose());

    const buttons = Panel({
        layoutManager: new HBox({ spacing: BUTTON_SPACING }),
        insets       : new Insets(PAD, PAD, PAD, PAD),
    });
    buttons.addComponent(Spacer.flex());
    buttons.addComponent(clearButton);
    buttons.addComponent(closeButton);

    const root = Panel({ layoutManager: new Border() });
    root.addComponent(view,    { placement: Placement.CENTER });
    root.addComponent(buttons, { placement: Placement.SOUTH });

    return root;
}
