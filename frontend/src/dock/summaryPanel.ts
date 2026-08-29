import { Panel } from "@jimka/typescript-ui/core";
import { VBox }  from "@jimka/typescript-ui/layout";
import { Text }  from "@jimka/typescript-ui/component/input";

/**
 * Build the minimal read-only summary shown above the Save SQL preview: one
 * line per changed column, from `describeColumnSpecs`. Display-only — the
 * previewed (and possibly hand-edited) SQL text is authoritative at execute,
 * the same trust model every other DDL phase's preview dialog uses.
 *
 * @param lines - one summary line per changed column.
 * @returns the summary panel to host above the SQL preview editor.
 */
export function summaryPanel(lines: string[]): Panel {
    return Panel({
        layoutManager: new VBox({ itemAlign: "stretch" }),
        components:    lines.map(line => new Text(line)),
    });
}
