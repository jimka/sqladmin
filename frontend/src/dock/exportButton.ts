// The shared Export toolbar button for the dock work panels: a glyph-only button
// that opens a CSV / JSON chooser under the button. The table, view, and
// role-grants panels all export the same two formats through the same affordance,
// so the button, its menu, and its glyph registration live here once.
//
// (QueryPanel keeps its own export menu — its result can be either rows or an
// EXPLAIN plan, so its chooser branches over more than the two formats here.)

import { MenuButton } from "@jimka/typescript-ui/component/button";
import { Glyph } from "@jimka/typescript-ui/component/display";
import { file_export } from "@jimka/typescript-ui/glyphs/solid/file_export";
import { file_csv } from "@jimka/typescript-ui/glyphs/solid/file_csv";
import { file_code } from "@jimka/typescript-ui/glyphs/solid/file_code";
import { glyphMenuButton } from "./glyphButton";
import { buildTableExportItems } from "./menuItems";
import { PRIMARY_COLOR } from "../theme";

Glyph.register(file_export, file_csv, file_code);

/**
 * Build a glyph-only Export button that opens a CSV / JSON chooser under the
 * button and calls `onExport` with the chosen format. The dropdown is created
 * lazily and reused across opens.
 *
 * @param label - The button's hover tooltip / accessible name (e.g. "Export table (CSV / JSON)").
 * @param onExport - Runs the export in the chosen format.
 *
 * @returns The wired Export button.
 */
export function buildExportButton(label: string, onExport: (format: "csv" | "json") => void): MenuButton {
    return glyphMenuButton("file-export", PRIMARY_COLOR, label, buildTableExportItems(onExport));
}
