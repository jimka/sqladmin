// The shared Export toolbar button for the dock work panels: a glyph-only button
// that pops a CSV / JSON chooser at the click point. The table, view, and
// role-grants panels all export the same two formats through the same affordance,
// so the button, its menu, and its glyph registration live here once.
//
// (QueryPanel keeps its own export menu — its result can be either rows or an
// EXPLAIN plan, so its chooser branches over more than the two formats here.)

import { Button } from "@jimka/typescript-ui/component/button";
import { Menu } from "@jimka/typescript-ui/overlay";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { file_export } from "@jimka/typescript-ui/glyphs/solid/file_export";
import { file_csv } from "@jimka/typescript-ui/glyphs/solid/file_csv";
import { file_code } from "@jimka/typescript-ui/glyphs/solid/file_code";
import { glyphButton } from "./glyphButton";
import { PRIMARY_COLOR } from "../theme";

Glyph.register(file_export, file_csv, file_code);

/**
 * Build a glyph-only Export button that opens a CSV / JSON chooser at the click
 * point and calls `onExport` with the chosen format. The menu is created once and
 * reused across clicks.
 *
 * @param label - The button's hover tooltip / accessible name (e.g. "Export table (CSV / JSON)").
 * @param onExport - Runs the export in the chosen format.
 *
 * @returns The wired Export button.
 */
export function buildExportButton(label: string, onExport: (format: "csv" | "json") => void): Button {
    const menu = Menu();

    return glyphButton("file-export", PRIMARY_COLOR, label, event => {
        menu.show(event.clientX, event.clientY, [
            { text: "Export CSV (.csv)",   glyph: "file-csv",  action: () => onExport("csv") },
            { text: "Export JSON (.json)", glyph: "file-code", action: () => onExport("json") },
        ]);
    });
}
