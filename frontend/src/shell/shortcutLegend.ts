// The rendered keyboard-shortcut legend: category headings over two-column
// keys->label grids, built from the pure shortcutRegistry. It is structured
// Text + Grid (not a Markdown table) so every row's keys column aligns within a
// group and the muted styling matches the rest of the start page. Being pure
// Text/Grid it holds no ThemeManager subscription, so — unlike the About Markdown
// body — it needs no dispose() on the dialog's dismissal or the start page's
// rebuild. One buildShortcutLegend() drops into both the start-page column and
// the Keyboard Shortcuts dialog.

import { Component, Panel }    from "@jimka/typescript-ui/core";
import { VBox, Grid }          from "@jimka/typescript-ui/layout";
import { Text }                from "@jimka/typescript-ui/component/input";
import { groupByCategory }     from "./shortcutRegistry";
import type { ShortcutGroup }  from "./shortcutRegistry";
import { MUTED_TEXT_COLOR }    from "../theme";

// The gap between the stacked category groups, and the tighter gap between a
// group's heading and its key rows. The group gap is a touch larger than the
// intra-group row spacing so each category reads as its own block; both are small
// fixed values chosen to match the start page's compact list rhythm rather than
// any library default (the default VBox spacing runs looser than this dense
// reference table wants).
const GROUP_SPACING = 12;
const ROW_SPACING   = 4;

/**
 * Build the keyboard-shortcut legend — a stack of category groups, each a bold
 * muted heading over a two-column grid of key string -> muted label. Rendered
 * from the shortcutRegistry so it never re-declares a key string.
 *
 * @returns The legend component (pure Text/Grid; no disposal needed).
 */
export function buildShortcutLegend(): Component {
    const legend = Panel({ layoutManager: new VBox({ stretching: true, spacing: GROUP_SPACING }) });

    for (const group of groupByCategory()) {
        legend.addComponent(buildGroup(group));
    }

    return legend;
}

/**
 * Build one category group: its heading over a keys->label grid.
 *
 * @param group - The category's title and entries.
 *
 * @returns The group's stacked component.
 */
function buildGroup(group: ShortcutGroup): Component {
    const block = Panel({ layoutManager: new VBox({ stretching: true, spacing: ROW_SPACING }) });

    block.addComponent(heading(group.title));
    block.addComponent(buildGrid(group));

    return block;
}

/**
 * Build a group's two-column grid: a content-sized keys track beside a weighted
 * label track, auto-flowing two cells (keys, then label) per entry.
 *
 * @param group - The category whose entries fill the grid.
 *
 * @returns The grid panel.
 */
function buildGrid(group: ShortcutGroup): Component {
    const grid = new Grid({
        columns:      2,
        spacing:      ROW_SPACING,
        columnTracks: [{ mode: "content" }, { mode: "weight", value: 1 }],
    });

    const rows = Panel({ layoutManager: grid });
    grid.setRows(group.entries.length);

    for (const entry of group.entries) {
        rows.addComponent(new Text(entry.keys));
        rows.addComponent(mutedText(entry.label));
    }

    return rows;
}

/** A bold, muted category heading. */
function heading(text: string): Component {
    const header = new Text(text, { fontWeight: "600" });
    header.setForegroundColor(MUTED_TEXT_COLOR);

    return header;
}

/** A muted label line. */
function mutedText(text: string): Component {
    const line = new Text(text);
    line.setForegroundColor(MUTED_TEXT_COLOR);

    return line;
}
