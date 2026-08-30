// Shared quick-search wiring for any `Table`-backed grid, used by
// recordViewControls.ts, which backs both TableWorkPanel.ts's data grid and
// QueryResultView.ts's QueryResultGrid.
//
// Row-hiding itself is never reimplemented here — a grid calls the library's
// own `Table.setQuickSearch` directly. What's left is the status line's
// match count and a record-view stepper's "does this record match" test:
// the grid exposes no query for either, so `quickSearchFields`/`matchesQuery`
// recompute it from the same public pieces `Table.setQuickSearch` itself
// uses (`Table.getCellText` plus the column's default Contains-filterable
// scope) — never from a record's raw stored value, so a formatted
// date/time/datetime or combo column matches the same way it renders.

import { Table, columnFilterOperators } from "@jimka/typescript-ui/component/table";
import type { ModelRecord }             from "@jimka/typescript-ui/data";

/**
 * The field names `Table.setQuickSearch` searches when called with no
 * explicit field list — every resolved, visible column offering a Contains
 * filter operator. Mirrors the library's own (private) default field scope
 * via the same public pieces it's built from, so a caller's own match count /
 * record stepper stays in step with what the grid itself shows/hides. Every
 * grid in this app renders every resolved column (none hides one), so
 * "visible" here is every column.
 *
 * Call this once, right after the grid is constructed, and reuse the result —
 * never recompute it later. `Table.getColumns()` returns the *source*
 * columns only while {@link Table.getDisplayMode} is `"normal"`; once a
 * caller flips a grid into `"rotated"` (record) view, it switches to the
 * two-column field/value projection instead, so a later call here would
 * return `["field", "value"]`-ish names that match nothing on a source
 * record — silently starving `matchesQuery` rather than throwing. A grid is
 * always `"normal"` at construction, before any caller has a chance to
 * rotate it, which is why its one call site captures this immediately.
 *
 * @param dataGrid - the table whose default search scope to compute.
 * @returns the field names to test.
 */
export function quickSearchFields(dataGrid: Table): string[] {
    return dataGrid.getColumns()
        .filter(c => c.isFilterable() && columnFilterOperators(c.getField().getType()).includes("contains"))
        .map(c => c.getField().getName());
}

/**
 * Whether `record` matches an active quick search: `needle` found in any of
 * `fields`' displayed cell text, resolved through the grid's own
 * `Table.getCellText` — so a date/time/datetime or combo column matches the
 * same way it renders, not its raw stored value. An empty `needle` matches
 * every record.
 *
 * @param dataGrid - the table to resolve each field's displayed text through.
 * @param fields - the field names to test (see `quickSearchFields`).
 * @param record - the record to test.
 * @param needle - the trimmed, lower-cased search text.
 * @returns whether any of `fields`' displayed text contains `needle`.
 */
export function matchesQuery(dataGrid: Table, fields: string[], record: ModelRecord, needle: string): boolean {
    return needle === "" || fields.some(f => dataGrid.getCellText(f, record).toLowerCase().includes(needle));
}
