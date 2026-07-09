// Pure inference of FK cardinality (crow's-foot markers) and index-coverage
// (a warning-tinted stroke) over an already-assembled schema DiagramData. Kept
// separate from buildSchemaDiagram.ts so its own focused unit tests stay
// decoupled from graph assembly. No DOM, no ELK — type-only imports from the
// diagram barrel keep this node-vitest-testable, the same purity discipline
// as buildSchemaDiagram.ts:16-21 (never import UI-bundle runtime code, which
// runs DOM-touching module-level side effects on import).

import type { DiagramData, DiagramEdgeMarker } from "@jimka/typescript-ui/component/diagram";
import type { ColumnMeta, TableStructure } from "../contract";
import type { FkEdgeData } from "./buildSchemaDiagram";

// Themed warning stroke for an uncovered FK edge, applied by applyCoverageStyle.
// Reuses the library's notification-warning border var (amber/orange by
// default) so the overlay reads consistently with the rest of the theme.
const COVERAGE_WARNING_STROKE = "var(--ts-ui-notification-warning-border, rgb(200, 120, 0))";

/** A bare column identifier, e.g. `a` or a quoted `"MixedCase"` (unquoted on return). */
const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A trailing sort/null-ordering modifier stripped off an index column term. */
const TRAILING_MODIFIER = /\s+(ASC|DESC|NULLS\s+FIRST|NULLS\s+LAST)$/i;

/**
 * Splits `text` on top-level (depth-0) commas, leaving commas nested inside
 * parentheses (e.g. an expression index's function-call arguments) intact.
 *
 * @param text - The text to split.
 * @returns The comma-separated terms, un-trimmed.
 */
function splitTopLevel(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";

    for (const ch of text) {
        if (ch === "(") {
            depth++;
        } else if (ch === ")") {
            depth--;
        }

        if (ch === "," && depth === 0) {
            parts.push(current);
            current = "";
        } else {
            current += ch;
        }
    }

    parts.push(current);

    return parts;
}

/**
 * Parses the leading column list out of a `CREATE INDEX …` definition
 * (`pg_indexes.indexdef`). Conservative: any term that is not a bare (or
 * quoted) column identifier after stripping sort/null-ordering modifiers —
 * e.g. an expression like `lower(email)` — makes the whole index unparseable,
 * so it safely counts as "not covering" rather than guessing.
 *
 * @param definition - The full `CREATE INDEX …` text.
 * @returns The bare column names in order, or `null` when unparseable.
 */
export function parseIndexColumns(definition: string): string[] | null {
    const openIdx = definition.indexOf("(");

    if (openIdx === -1) {
        return null;
    }

    let depth = 0;
    let closeIdx = -1;

    for (let i = openIdx; i < definition.length; i++) {
        if (definition[i] === "(") {
            depth++;
        } else if (definition[i] === ")") {
            depth--;

            if (depth === 0) {
                closeIdx = i;
                break;
            }
        }
    }

    if (closeIdx === -1) {
        return null;
    }

    const terms   = splitTopLevel(definition.slice(openIdx + 1, closeIdx));
    const columns: string[] = [];

    for (const rawTerm of terms) {
        let term = rawTerm.trim();
        let stripped: string;

        do {
            stripped = term;
            term     = term.replace(TRAILING_MODIFIER, "").trim();
        } while (term !== stripped);

        if (term.length >= 2 && term.startsWith('"') && term.endsWith('"')) {
            columns.push(term.slice(1, -1));
            continue;
        }

        if (!BARE_IDENTIFIER.test(term)) {
            return null;
        }

        columns.push(term);
    }

    return columns;
}

/** True when `candidate` (order-insensitive) contains exactly the same columns as `fkColumns`. */
function columnSetEquals(candidate: string[], fkColumns: string[]): boolean {
    if (candidate.length !== fkColumns.length) {
        return false;
    }

    const set = new Set(candidate);

    return fkColumns.every(c => set.has(c));
}

/** True when `candidate` starts with `fkColumns`, in order (a leading-prefix match). */
function isLeadingPrefix(fkColumns: string[], candidate: string[]): boolean {
    if (candidate.length < fkColumns.length) {
        return false;
    }

    return fkColumns.every((c, i) => candidate[i] === c);
}

/**
 * True when the FK's local column set is backed by a PK/unique constraint or
 * a unique index with the exact same column set (order-insensitive). A unique
 * index/constraint on a superset of the FK columns does not count — uniqueness
 * needs an exact match.
 *
 * @param fkColumns - The FK's local columns, in key order.
 * @param structure - The referencing table's structure.
 * @returns Whether the FK is 1:1 (its parent has at most one matching child).
 */
export function isFkUnique(fkColumns: string[], structure: TableStructure): boolean {
    const constraintMatch = structure.constraints.some(c =>
        (c.type === "primaryKey" || c.type === "unique") && columnSetEquals(c.columns, fkColumns));

    if (constraintMatch) {
        return true;
    }

    return structure.indexes.some((idx) => {
        if (!idx.unique) {
            return false;
        }

        const cols = parseIndexColumns(idx.definition);

        return cols !== null && columnSetEquals(cols, fkColumns);
    });
}

/**
 * True when every one of the FK's local columns is `NOT NULL`.
 *
 * @param fkColumns - The FK's local columns.
 * @param columns - The referencing table's columns.
 * @returns Whether the FK is mandatory (every local column disallows NULL).
 */
export function isFkMandatory(fkColumns: string[], columns: ColumnMeta[]): boolean {
    return fkColumns.every((name) => {
        const col = columns.find(c => c.name === name);

        return col !== undefined && !col.nullable;
    });
}

/**
 * True when some index (or PK/unique constraint) has `fkColumns` as a leading
 * prefix of its own column list — the FK lookup (`WHERE fk_col = …`) can use
 * that index/constraint's underlying B-tree.
 *
 * @param fkColumns - The FK's local columns, in key order.
 * @param structure - The referencing table's structure.
 * @returns Whether the FK columns are covered by an index or constraint.
 */
export function isFkCovered(fkColumns: string[], structure: TableStructure): boolean {
    const constraintMatch = structure.constraints.some(c =>
        (c.type === "primaryKey" || c.type === "unique") && isLeadingPrefix(fkColumns, c.columns));

    if (constraintMatch) {
        return true;
    }

    return structure.indexes.some((idx) => {
        const cols = parseIndexColumns(idx.definition);

        return cols !== null && isLeadingPrefix(fkColumns, cols);
    });
}

/**
 * Builds the optional `"ON UPDATE … ON DELETE …"` edge label from a FK's
 * referential actions, omitting any side left at the Postgres default.
 *
 * @param onUpdate - The FK's `ON UPDATE` action.
 * @param onDelete - The FK's `ON DELETE` action.
 * @returns The label, or `undefined` when both actions are `"NO ACTION"`.
 */
function referentialActionLabel(onUpdate: string, onDelete: string): string | undefined {
    const parts: string[] = [];

    if (onUpdate !== "NO ACTION") {
        parts.push(`ON UPDATE ${onUpdate}`);
    }

    if (onDelete !== "NO ACTION") {
        parts.push(`ON DELETE ${onDelete}`);
    }

    return parts.length > 0 ? parts.join(" ") : undefined;
}

/** The crow's-foot `startMarker` for a `(unique, mandatory)` pair, per the plan's mapping table. */
function cardinalityStartMarker(unique: boolean, mandatory: boolean): DiagramEdgeMarker {
    if (unique) {
        return mandatory ? "one" : "zeroOrOne";
    }

    return mandatory ? "oneOrMany" : "zeroOrMany";
}

/**
 * Bakes cardinality `style` onto each FK edge and sets `uncovered` on its
 * {@link FkEdgeData}. `structures`/`columns` are positionally paired with
 * `tables` (the same order `buildSchemaGraphData` fetched them in). An edge
 * whose source table cannot be found in the maps is left without cardinality
 * style rather than throwing — a defensive fallback, not an expected path.
 *
 * @param data - The assembled schema `DiagramData` (from `buildSchemaDiagram`).
 * @param tables - The schema's table names, positionally paired with `structures`/`columns`.
 * @param structures - Each table's structure.
 * @param columns - Each table's columns.
 * @returns A new `DiagramData`; the input is not mutated.
 */
export function annotateFkCardinality(
    data: DiagramData,
    tables: string[],
    structures: TableStructure[],
    columns: ColumnMeta[][],
): DiagramData {
    const structureByTable = new Map(tables.map((t, i) => [t, structures[i]]));
    const columnsByTable   = new Map(tables.map((t, i) => [t, columns[i]]));

    const edges = data.edges.map((edge) => {
        const structure    = structureByTable.get(edge.source);
        const tableColumns = columnsByTable.get(edge.source);

        if (!structure || !tableColumns) {
            return edge;
        }

        const fkData    = edge.data as FkEdgeData;
        const unique    = isFkUnique(fkData.columns, structure);
        const mandatory = isFkMandatory(fkData.columns, tableColumns);
        const covered   = isFkCovered(fkData.columns, structure);
        const label     = referentialActionLabel(fkData.onUpdate, fkData.onDelete);

        return {
            ...edge,
            data: { ...fkData, uncovered: !covered } satisfies FkEdgeData,
            style: {
                ...edge.style,
                startMarker: cardinalityStartMarker(unique, mandatory),
                endMarker  : "one" as DiagramEdgeMarker,
                ...(label !== undefined ? { label } : {}),
            },
        };
    });

    return { ...data, edges };
}

/**
 * Returns a new `DiagramData` whose uncovered FK edges (per `annotateFkCardinality`)
 * get a warning stroke merged into their style when `show` is true; strips any
 * such stroke when `show` is false. Cardinality markers are always preserved.
 *
 * @param data - The (cardinality-)annotated `DiagramData`.
 * @param show - Whether to apply the coverage warning tint.
 * @returns A new `DiagramData`; the input is not mutated.
 */
export function applyCoverageStyle(data: DiagramData, show: boolean): DiagramData {
    const edges = data.edges.map((edge) => {
        const fkData = edge.data as FkEdgeData | undefined;

        if (show && fkData?.uncovered) {
            return { ...edge, style: { ...edge.style, stroke: COVERAGE_WARNING_STROKE } };
        }

        if (edge.style?.stroke === COVERAGE_WARNING_STROKE) {
            const { stroke: _stroke, ...rest } = edge.style;

            return { ...edge, style: rest };
        }

        return edge;
    });

    return { ...data, edges };
}
