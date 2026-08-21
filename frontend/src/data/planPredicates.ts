// Pure, DOM-free readers that pull indexable column references out of a
// Postgres EXPLAIN plan's deparsed predicate text (Filter / Index Cond / Hash
// Cond / Merge Cond / Join Filter) and out of a "Sort Key" array. Feeds the
// heuristic index advisor (suggestIndexes.ts); kept in its own module so the
// app's node-only vitest can red-green the parsing in isolation.
//
// This is a small hand-rolled scanner, not a SQL expression parser — the
// same choice fkCardinality.ts's parseIndexColumns makes for `indexdef` text.
// Postgres's plan text is deparsed output, not user SQL, so a handful of
// patterns cover the shapes that matter; anything outside them is dropped
// rather than guessed at. Concretely, this module refuses to parse (and
// drops, never mis-reads):
//   - a condition with a top-level (depth-0) OR — the whole condition yields
//     no evidence, since one column set cannot serve either branch;
//   - a comparison whose left (or right) side is an expression rather than a
//     bare, optionally-aliased column — `lower(col)`, arithmetic, etc.;
//   - `<>` (and any operator other than `=`, `<`, `<=`, `>`, `>=`) — not a
//     B-tree-indexable comparison;
//   - a sort key term that isn't a bare column reference (after stripping
//     ASC/DESC/NULLS FIRST/NULLS LAST) — drops the *whole* Sort Key array,
//     since a one-column index can't serve a sort it can only partly express.
//
// A string literal containing an unbalanced quote can still mis-split a
// condition on a false top-level AND; the result is a dropped conjunct, never
// a wrong column. A quoted identifier containing a dot (`"my.col"`) defeats
// the naive alias/column split; it resolves to no known alias and is dropped
// — conservative, not wrong.

/** How a predicate uses a column: `=`/`= ANY` versus an ordered comparison. */
export type PredicateRole = "equality" | "range";

/** A column reference read out of plan text, with its alias qualifier when present. */
export interface ColumnRef {
    alias?: string;
    column: string;
}

/** A column reference plus the role the predicate used it in. */
export interface PredicateRef extends ColumnRef {
    role: PredicateRole;
}

// A bare (optionally alias-qualified) column identifier — the only shape a
// term can reduce to and still be recognised, e.g. "status" or "o.status".
const BARE_COLUMN_REF = /^(?:([A-Za-z_][A-Za-z0-9_]*)\.)?([A-Za-z_][A-Za-z0-9_]*)$/;

// A trailing `::type` (or `::type[]`) cast suffix, stripped one layer at a
// time so a repeated cast (rare, but cheap to handle) still reduces fully.
const TRAILING_CAST = /::[A-Za-z_][A-Za-z0-9_]*(\[\])?$/;

// A trailing sort/null-ordering modifier on one "Sort Key" term.
const TRAILING_SORT_MODIFIER = /\s+(ASC|DESC|NULLS\s+FIRST|NULLS\s+LAST)$/i;

// The comparison operators recognised at the top level of a conjunct, mapped
// to the role they give their columns. `<>` is deliberately absent: it is
// still *recognised* (so the scanner doesn't misread it as `<` followed by a
// stray `>`), but maps to no role, so a conjunct built on it yields nothing.
const OPERATOR_ROLE: Partial<Record<string, PredicateRole>> = {
    "=" : "equality",
    "<" : "range",
    "<=": "range",
    ">" : "range",
    ">=": "range",
};

/**
 * Invoke `visit` for every character index of `text` that sits at paren depth
 * 0 and outside a single-quoted string literal (`''` is the escaped quote).
 * The shared low-level scanner behind both the top-level AND/OR split and the
 * top-level comparison-operator search — both need to skip over parenthesized
 * sub-expressions and string-literal content the same way.
 *
 * @param text - The text to scan.
 * @param visit - Called with each top-level index, left to right.
 */
function forEachTopLevelChar(text: string, visit: (i: number) => void): void {
    let depth = 0;
    let inQuote = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inQuote) {
            if (ch === "'") {
                if (text[i + 1] === "'") {
                    i++; // escaped quote — stays inside the literal
                } else {
                    inQuote = false;
                }
            }

            continue;
        }

        if (ch === "'") {
            inQuote = true;
            continue;
        }

        if (ch === "(") {
            depth++;
            continue;
        }

        if (ch === ")") {
            depth--;
            continue;
        }

        if (depth === 0) {
            visit(i);
        }
    }
}

/**
 * True when `word` occurs at `text[i..]` as a whole word — not a substring of
 * a longer identifier.
 *
 * @param text - The text being scanned.
 * @param i - The candidate start index.
 * @param word - The exact-case word to match (e.g. "AND").
 * @returns Whether `word` matches at `i` with non-identifier characters (or
 *   the string boundary) on both sides.
 */
function matchesWord(text: string, i: number, word: string): boolean {
    if (text.slice(i, i + word.length) !== word) {
        return false;
    }

    const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

    return !isWordChar(text[i - 1]) && !isWordChar(text[i + word.length]);
}

/**
 * Strip one layer of parentheses when `text` is entirely wrapped by a single
 * matching pair — the first `(` closes exactly at the last character, not
 * partway through. Leaves `text` unchanged otherwise (e.g. `(a) op (b)`, whose
 * leading `(` closes long before the end).
 *
 * @param text - The text to (maybe) unwrap.
 * @returns The unwrapped, trimmed text, or `text` unchanged.
 */
function stripOuterParens(text: string): string {
    if (text[0] !== "(" || text[text.length - 1] !== ")") {
        return text;
    }

    let depth = 0;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === "(") {
            depth++;
        } else if (text[i] === ")") {
            depth--;

            if (depth === 0) {
                return i === text.length - 1 ? text.slice(1, -1).trim() : text;
            }
        }
    }

    return text;
}

/**
 * Reduce one comparison side to a bare column reference: strip wrapping
 * parens and trailing `::type` casts (in either order, repeatedly), then
 * require what remains to be a bare, optionally alias-qualified identifier.
 *
 * @param raw - The comparison side's raw text.
 * @returns The column reference, or `null` when the side is an expression
 *   this module does not recognise as a plain column.
 */
function parseColumnTerm(raw: string): ColumnRef | null {
    let term = raw.trim();

    for (;;) {
        const unwrapped = stripOuterParens(term);

        if (unwrapped !== term) {
            term = unwrapped;
            continue;
        }

        const uncast = term.replace(TRAILING_CAST, "").trim();

        if (uncast !== term) {
            term = uncast;
            continue;
        }

        break;
    }

    const match = BARE_COLUMN_REF.exec(term);

    if (!match) {
        return null;
    }

    const [, alias, column] = match;

    return alias ? { alias, column } : { column };
}

/**
 * Split `condition` into its top-level (depth-0) AND-separated conjuncts,
 * after stripping one layer of redundant outer parens.
 *
 * @param condition - The raw predicate text.
 * @returns The conjuncts, or `null` when a top-level OR poisons the whole
 *   condition (no single-table index can serve either branch).
 */
function splitConjuncts(condition: string): string[] | null {
    const text = stripOuterParens(condition.trim());
    const andIndices: number[] = [];
    let rejected = false;

    forEachTopLevelChar(text, (i) => {
        if (rejected) {
            return;
        }

        if (matchesWord(text, i, "OR")) {
            rejected = true;
        } else if (matchesWord(text, i, "AND")) {
            andIndices.push(i);
        }
    });

    if (rejected) {
        return null;
    }

    if (andIndices.length === 0) {
        return [text];
    }

    const parts: string[] = [];
    let start = 0;

    for (const i of andIndices) {
        parts.push(text.slice(start, i).trim());
        start = i + "AND".length;
    }

    parts.push(text.slice(start).trim());

    return parts;
}

/**
 * Find the first top-level comparison operator in `text` (leftmost, depth 0,
 * outside any string literal), preferring the two-character tokens (`<>`,
 * `<=`, `>=`) over their one-character prefixes.
 *
 * @param text - The conjunct text (already unwrapped of its own outer parens).
 * @returns The operator and its index, or `null` when none is found.
 */
function findTopLevelOperator(text: string): { index: number; token: string } | null {
    let found: { index: number; token: string } | null = null;

    forEachTopLevelChar(text, (i) => {
        if (found) {
            return;
        }

        const two = text.slice(i, i + 2);

        if (two === "<>" || two === "<=" || two === ">=") {
            found = { index: i, token: two };

            return;
        }

        const one = text[i];

        if (one === "=" || one === "<" || one === ">") {
            found = { index: i, token: one };
        }
    });

    return found;
}

/**
 * Parse one AND-conjunct into the column reference(s) it compares — one per
 * side that reduces to a bare column (a join condition like `a.x = b.y`
 * yields both sides; a literal comparison yields only the column side).
 *
 * @param raw - The conjunct text.
 * @returns The recognised column references, `[]` when the conjunct has no
 *   top-level indexable operator or neither side is a bare column.
 */
function parseConjunct(raw: string): PredicateRef[] {
    const term = stripOuterParens(raw.trim());
    const op = findTopLevelOperator(term);

    if (!op) {
        return [];
    }

    const role = OPERATOR_ROLE[op.token];

    if (!role) {
        return [];
    }

    const lhs = term.slice(0, op.index).trim();
    const rhs = term.slice(op.index + op.token.length).trim();
    const refs: PredicateRef[] = [];

    const lhsRef = parseColumnTerm(lhs);

    if (lhsRef) {
        refs.push({ ...lhsRef, role });
    }

    const rhsRef = parseColumnTerm(rhs);

    if (rhsRef) {
        refs.push({ ...rhsRef, role });
    }

    return refs;
}

/**
 * Read the indexable column references out of a Filter / Index Cond / Hash
 * Cond / Merge Cond / Join Filter text. Returns `[]` for a condition with a
 * top-level OR and for any conjunct that is not a bare column comparison.
 *
 * @param condition - The raw plan predicate text.
 * @returns One {@link PredicateRef} per recognised column, in plan-text order.
 */
export function parseConditionColumns(condition: string): PredicateRef[] {
    const conjuncts = splitConjuncts(condition);

    if (conjuncts === null) {
        return [];
    }

    return conjuncts.flatMap(parseConjunct);
}

/**
 * Read the column references out of a "Sort Key" array, stripping ASC/DESC
 * and NULLS FIRST/LAST. Returns `[]` if any term is not a bare column
 * reference — a single-relation index cannot partly serve a sort.
 *
 * @param sortKey - The raw "Sort Key" terms, in sort order.
 * @returns One {@link ColumnRef} per term, in the same order, or `[]`.
 */
export function parseSortKeyColumns(sortKey: string[]): ColumnRef[] {
    const refs: ColumnRef[] = [];

    for (const raw of sortKey) {
        let term = raw.trim();

        for (;;) {
            const stripped = term.replace(TRAILING_SORT_MODIFIER, "").trim();

            if (stripped === term) {
                break;
            }

            term = stripped;
        }

        const ref = parseColumnTerm(term);

        if (!ref) {
            return [];
        }

        refs.push(ref);
    }

    return refs;
}
