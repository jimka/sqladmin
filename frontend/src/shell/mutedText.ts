// Small muted-text builders shared by the shell's Start page and Shortcuts
// dialog, so a section heading and a secondary line read the same
// (MUTED_TEXT_COLOR) everywhere the shell uses them.

import { Component } from "@jimka/typescript-ui/core";
import { Text }       from "@jimka/typescript-ui/component/input";
import { MUTED_TEXT_COLOR } from "../theme";

/** A bold, muted section heading. */
export function mutedHeading(text: string): Component {
    const header = new Text(text, { fontWeight: "600" });
    header.setForegroundColor(MUTED_TEXT_COLOR);

    return header;
}

/** A muted text line. */
export function mutedText(text: string): Component {
    const line = new Text(text);
    line.setForegroundColor(MUTED_TEXT_COLOR);

    return line;
}
