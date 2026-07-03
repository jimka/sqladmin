// The pure translation from the filter dialog's rows to the store's
// FilterDescriptor list. Kept DOM-free so vitest (node-only) can pin it — the
// dialog shell (FilterDialog.ts) is a thin collector that hands its rows here.
//
// Value coercion mirrors the wire contract: a number-wire column binds a JS
// number, a boolean-wire column binds a JS boolean, everything else passes the
// raw string, so the descriptor's `value` matches what the backend binds as a
// `$n` parameter (see backend/app/sql/compiler.py).

import type { FilterDescriptor } from "@jimka/typescript-ui/data";
import type { ColumnMeta } from "../contract";

/** The single-field operators the filter dialog offers (a subset of FilterDescriptor). */
export type FilterOperator =
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "contains"
    | "startsWith";

/** One condition row collected from the filter dialog. */
export interface FilterCondition {
    field: string; // a column name, or "" when the row is unset
    operator: FilterOperator;
    value: string; // raw text from the value field
}

/**
 * Translate the dialog's conditions into an AND-combined FilterDescriptor list.
 *
 * Incomplete rows (no field, or an empty value) are dropped, and a non-numeric
 * value on a numeric-wire column is dropped rather than binding a NaN. Input
 * order is preserved so the caller can AND-combine the descriptors by applying
 * each via `store.filterBy`.
 *
 * @param conditions - the raw rows collected from the dialog.
 * @param columns - the table's introspected columns, for wire-type coercion.
 * @returns the descriptors to apply, in the conditions' order.
 */
export function buildFilters(conditions: FilterCondition[], columns: ColumnMeta[]): FilterDescriptor[] {
    const byName = new Map(columns.map(c => [c.name, c]));
    const descriptors: FilterDescriptor[] = [];

    for (const condition of conditions) {
        if (condition.field === "" || condition.value === "") {
            continue;
        }

        const descriptor = descriptorFor(condition, byName.get(condition.field));

        if (descriptor !== null) {
            descriptors.push(descriptor);
        }
    }

    return descriptors;
}

/**
 * Reverse of {@link buildFilters} for the single-field descriptors this dialog
 * emits: turn a store's active FilterDescriptors back into dialog rows so
 * reopening the dialog shows the filter that is currently applied. Descriptor
 * shapes the dialog never produces (`in` / `and` / `or` / `not`) are skipped.
 *
 * @param filters - the store's active filter descriptors.
 * @returns one condition per single-field descriptor, in the filters' order.
 */
export function conditionsFromFilters(filters: FilterDescriptor[]): FilterCondition[] {
    const conditions: FilterCondition[] = [];

    for (const filter of filters) {
        const condition = conditionFor(filter);

        if (condition !== null) {
            conditions.push(condition);
        }
    }

    return conditions;
}

/**
 * Map one FilterDescriptor back to a dialog condition, or null when it is a
 * shape the dialog does not offer (`in` / `and` / `or` / `not`), so the caller
 * drops it.
 *
 * @param filter - one active filter descriptor.
 * @returns the equivalent condition, or null to skip it.
 */
function conditionFor(filter: FilterDescriptor): FilterCondition | null {
    switch (filter.type) {
        case "eq":
        case "neq":
        case "contains":
        case "startsWith":
        case "gt":
        case "gte":
        case "lt":
        case "lte":
            return { field: filter.field, operator: filter.type, value: stringifyValue(filter.value) };
        default:
            return null;
    }
}

/**
 * Render a descriptor's coerced value back to the text the value field shows,
 * inverting the wire coercions {@link buildFilters} applies (number/boolean/
 * string). Dates never occur here — the dialog only ever binds those three.
 *
 * @param value - the descriptor's value.
 * @returns the string form for the dialog's value field.
 */
function stringifyValue(value: number | string | boolean | Date): string {
    if (typeof value === "boolean") {
        return value ? "true" : "false";
    }

    return String(value);
}

/**
 * Build one descriptor from a complete condition, coercing the value to the
 * column's wire type. Returns null when the value can't be coerced (a
 * non-numeric string on a numeric column) so the caller drops the row.
 *
 * @param condition - a row with a non-empty field and value.
 * @param column - the matching column's metadata, or undefined if unknown.
 * @returns the descriptor, or null to drop the row.
 */
function descriptorFor(condition: FilterCondition, column: ColumnMeta | undefined): FilterDescriptor | null {
    const { field, operator, value } = condition;

    if (operator === "contains" || operator === "startsWith") {
        return { type: operator, field, value };
    }

    if (operator === "eq" || operator === "neq") {
        const coerced = coerceEquality(value, column);

        return coerced === null ? null : { type: operator, field, value: coerced };
    }

    // gt | gte | lt | lte — a comparison only makes sense against a number or a
    // string/date; a boolean-wire column never reaches the boolean branch here.
    const coerced = coerceComparison(value, column);

    return coerced === null ? null : { type: operator, field, value: coerced };
}

/**
 * Coerce a value for an equality operator (eq/neq): number-wire → number
 * (null on NaN), boolean-wire → true/false, else the raw string.
 *
 * @param value - the raw text from the value field.
 * @param column - the matching column's metadata, or undefined if unknown.
 * @returns the coerced value, or null to drop the row.
 */
function coerceEquality(value: string, column: ColumnMeta | undefined): number | boolean | string | null {
    if (column?.wireType === "number") {
        return toNumberOrNull(value);
    }

    if (column?.wireType === "boolean") {
        if (value === "true") {
            return true;
        }

        if (value === "false") {
            return false;
        }
    }

    return value;
}

/**
 * Coerce a value for a comparison operator (gt/gte/lt/lte): number-wire →
 * number (null on NaN), else the raw string (the backend compares it as text).
 *
 * @param value - the raw text from the value field.
 * @param column - the matching column's metadata, or undefined if unknown.
 * @returns the coerced value, or null to drop the row.
 */
function coerceComparison(value: string, column: ColumnMeta | undefined): number | string | null {
    if (column?.wireType === "number") {
        return toNumberOrNull(value);
    }

    return value;
}

/**
 * Parse a value as a number, returning null for a non-numeric string so the
 * caller drops the row rather than binding a NaN the backend can't compare.
 *
 * @param value - the raw text from the value field.
 * @returns the parsed number, or null when it isn't numeric.
 */
function toNumberOrNull(value: string): number | null {
    const parsed = Number(value);

    return Number.isNaN(parsed) ? null : parsed;
}
