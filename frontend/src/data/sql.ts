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
 * Build `SELECT * FROM "schema"."name" [LIMIT n]` for a table/view.
 *
 * @param ref - The table/view to browse (its schema and name are quoted).
 * @param limit - Row cap; defaults to a small preview limit. Pass `null` to omit
 *     the LIMIT entirely — e.g. to EXPLAIN a relation's plan, where a LIMIT node
 *     would mask the underlying query's real cost.
 * @returns The generated SQL string.
 */
export function buildSelectSql(ref: DbObjectRef, limit: number | null = DEFAULT_LIMIT): string {
    const relation = `${quoteIdent(ref.schema ?? "")}.${quoteIdent(ref.name ?? "")}`;

    return limit === null ? `SELECT * FROM ${relation}` : `SELECT * FROM ${relation} LIMIT ${limit}`;
}

/**
 * Build a call statement for a function or procedure. A function is invoked in
 * a `SELECT * FROM …` — which works for scalar and set-returning routines
 * alike (a scalar function in the FROM list yields a single one-column row) —
 * while a procedure is invoked with `CALL` (a procedure cannot be SELECTed).
 * That `SELECT` vs `CALL` split is the one practical difference the app draws
 * between the two kinds.
 *
 * A routine that takes arguments seeds its identity-argument signature as a
 * comment inside the parentheses for the user to replace with real values,
 * left as one block rather than split on commas (a type like `numeric(10, 2)`
 * would break naive comma-splitting). {@link routineCallIsComplete} reports
 * whether the generated call is directly runnable (no arguments to fill).
 *
 * @param ref - the function/procedure to call (its `isProcedure` selects the
 *   verb, its `signature` seeds the argument comment).
 * @returns the generated call SQL.
 */
export function buildRoutineCallSql(ref: DbObjectRef): string {
    const routine = `${quoteIdent(ref.schema ?? "")}.${quoteIdent(ref.name ?? "")}`;
    const verb = ref.isProcedure ? "CALL" : "SELECT * FROM";

    if (routineCallIsComplete(ref)) {
        return `${verb} ${routine}();`;
    }

    return `${verb} ${routine}(\n    /* ${ref.signature} */\n);`;
}

/**
 * Whether {@link buildRoutineCallSql} produced a directly-runnable call — true
 * only for a zero-argument routine, whose parentheses are already complete.
 *
 * @param ref - the function/procedure being called.
 * @returns true when the routine takes no arguments.
 */
export function routineCallIsComplete(ref: DbObjectRef): boolean {
    return (ref.signature ?? "") === "";
}
