// Pure, DOM-free helpers for the EXPLAIN / EXPLAIN ANALYZE feature: build the
// EXPLAIN prefix client-side (the backend runs it as opaque SQL) and a
// best-effort read-only classifier that gates the EXPLAIN ANALYZE warning.
// Kept here beside sql.ts so the app's node-only vitest can red-green both
// without a backend or a DOM. The editor's own text is never mutated — the
// prefix is applied only to the copy sent to the run path.

import type { ExplainFormat } from "../contract";

/** How to build an EXPLAIN run: whether to ANALYZE (execute) and the output format. */
export interface ExplainOptions {
    analyze: boolean;
    format: ExplainFormat;
}

// First-keyword classes for the read-only guard. A plain read starts with one
// of these; a WITH is read-only only when its top-level body keyword is one of
// the read ones (a data-modifying CTE lives inside parens and never surfaces at
// depth 0). Everything else — writes, DDL, unknown — is treated as not read-only.
const READ_KEYWORDS: ReadonlySet<string> = new Set(["SELECT", "TABLE", "VALUES", "SHOW"]);

// The top-level query keywords a WITH statement's body can begin with — used to
// find where the CTE list ends and classify the main statement.
const BODY_KEYWORDS: ReadonlySet<string> =
    new Set(["SELECT", "VALUES", "TABLE", "INSERT", "UPDATE", "DELETE", "MERGE"]);

/**
 * Build `EXPLAIN [(ANALYZE, )FORMAT …] <sql>` from a statement and options.
 *
 * Uses PostgreSQL's parenthesized option list (`EXPLAIN (ANALYZE, FORMAT TEXT)
 * <sql>`) for clarity. Returns a new string; `sql` is trimmed but not mutated.
 *
 * @param sql - The user's statement to explain.
 * @param opts - Whether to ANALYZE and which output format to request.
 * @returns The prefixed EXPLAIN SQL to send to the run path.
 */
export function buildExplainSql(sql: string, opts: ExplainOptions): string {
    const format  = opts.format === "json" ? "JSON" : "TEXT";
    const options = opts.analyze ? `(ANALYZE, FORMAT ${format})` : `(FORMAT ${format})`;

    return `EXPLAIN ${options} ${sql.trim()}`;
}

/**
 * Best-effort lexical check: is `sql`'s first statement a read (SELECT / TABLE /
 * VALUES / SHOW, or a WITH whose top-level body is a SELECT / VALUES / TABLE)?
 *
 * Conservative by design — comments and whitespace are stripped, then the first
 * keyword decides; an unknown or ambiguous statement returns false. This gates
 * the frontend EXPLAIN ANALYZE warning only; the backend's rolled-back ANALYZE
 * transaction is the authoritative side-effect net, so a false "read-only" (e.g.
 * a data-modifying CTE) is still caught server-side.
 *
 * @param sql - The statement to classify.
 * @returns True when the statement plainly reads and nothing else.
 */
export function isReadOnlyStatement(sql: string): boolean {
    const tokens = topLevelTokens(stripComments(sql));

    if (tokens.length === 0) {
        return false;
    }

    const first = tokens[0].word;

    if (READ_KEYWORDS.has(first)) {
        return true;
    }

    if (first === "WITH") {
        const body = firstBodyKeyword(tokens);

        return body !== null && READ_KEYWORDS.has(body);
    }

    return false;
}

/**
 * Strip SQL line (`-- … EOL`) and block (`/* … *​/`) comments.
 *
 * Best-effort lexical: it does not honour string/identifier literals that
 * contain comment markers, which is acceptable for a first-keyword classifier.
 *
 * @param sql - The raw statement text.
 * @returns The statement with comment spans removed.
 */
function stripComments(sql: string): string {
    // Remove block comments first, then line comments; both replaced with a
    // space so adjacent tokens don't fuse (e.g. "a/**/b" -> "a b").
    return sql
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*/g, " ");
}

/** One SQL word with the parenthesis nesting depth at which it starts. */
interface DepthToken {
    word: string;
    depth: number;
}

/**
 * Tokenize `sql` into uppercased word runs, tagging each with its paren depth.
 *
 * A single character-level pass tracks `(`/`)` nesting so the caller can tell a
 * top-level (depth 0) keyword from one buried inside a CTE's parenthesized body.
 *
 * @param sql - Comment-stripped statement text.
 * @returns The word tokens in order, each with its starting paren depth.
 */
function topLevelTokens(sql: string): DepthToken[] {
    const tokens: DepthToken[] = [];
    let depth   = 0;
    let current = "";
    let start   = 0;

    /** Flush the accumulating word (if any) as a token at `start`'s depth. */
    const flush = (): void => {
        if (current !== "") {
            tokens.push({ word: current.toUpperCase(), depth: start });
            current = "";
        }
    };

    for (const ch of sql) {
        if (/[A-Za-z0-9_]/.test(ch)) {
            if (current === "") {
                start = depth;
            }

            current += ch;
        } else {
            flush();

            if (ch === "(") {
                depth += 1;
            } else if (ch === ")" && depth > 0) {
                depth -= 1;
            }
        }
    }

    flush();

    return tokens;
}

/**
 * Find the top-level body keyword of a WITH statement — the first token at paren
 * depth 0 (after the leading WITH) that names a query kind. A data-modifying CTE
 * sits inside parens (depth > 0), so only the main statement surfaces here.
 *
 * @param tokens - The statement's depth-tagged tokens (first is WITH).
 * @returns The uppercased body keyword, or null if none is found.
 */
function firstBodyKeyword(tokens: DepthToken[]): string | null {
    for (let i = 1; i < tokens.length; i += 1) {
        const token = tokens[i];

        if (token.depth === 0 && BODY_KEYWORDS.has(token.word)) {
            return token.word;
        }
    }

    return null;
}
