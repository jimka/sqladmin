// Generate a browse query for a table/view: a quoted SELECT with a small row
// cap so "open as query" on a large table previews cheaply (a query panel has
// no pagination). This is the only place the app generates SQL — the front-end
// mirror of the backend's quote_ident.

import type { DbObjectRef } from "../contract";

// Default row cap on a generated browse query. Kept small so opening a large
// table as a query is cheap; the user can raise, lower, or delete the LIMIT.
const DEFAULT_LIMIT = 50;

/** Quote a SQL identifier: wrap in double quotes, doubling any embedded quote. */
function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build `SELECT * FROM "schema"."name" LIMIT n` for a table/view.
 *
 * @param ref - The table/view to browse (its schema and name are quoted).
 * @param limit - Row cap; defaults to a small preview limit.
 * @returns The generated SQL string.
 */
export function buildSelectSql(ref: DbObjectRef, limit: number = DEFAULT_LIMIT): string {
    return `SELECT * FROM ${quoteIdent(ref.schema ?? "")}.${quoteIdent(ref.name ?? "")} LIMIT ${limit}`;
}
