// The object-kind registry: the single source every per-kind navigator
// derivation (KIND_GLYPH, OBJECT_CATEGORIES, isRelation, and any future
// per-kind branch) reads from, instead of each maintaining its own switch or
// Record literal. Adding a new kind (e.g. phase 5's "function"/"type") is a
// ONE-LINE, additive change: append an entry to OBJECT_KINDS below (plus that
// kind's glyph import/registration in objectGlyphs.ts) — no existing line
// needs editing, so two phases adding kinds in parallel never collide on the
// same line. DOM-free: this module only holds data and pure lookups, so it
// (and its derivations) stay unit-testable under the node vitest harness
// (see memory "tsui DOM module side effects").

import type { DbObjectKind } from "../contract";

/**
 * One object kind's navigator metadata.
 *
 * `categoryLabel` groups the kind's leaves under a synthetic category node
 * (e.g. "Tables", "Sequences") in the schema's object list; a kind with no
 * label (database, schema) is a container, not a listed leaf, and never gets
 * a category group. `isRelation` marks the kinds that open a Dock data tab
 * on double-click and offer the relation context-menu items — a sequence is
 * a listed leaf (it has a category) but is NOT a relation (no rows to show).
 */
export interface ObjectKindInfo {
    kind: DbObjectKind;
    /** The registered glyph name (see objectGlyphs.ts's `Glyph.register` calls). */
    glyph: string;
    categoryLabel?: string;
    isRelation: boolean;
}

/**
 * The ordered kind registry. Category/glyph derivations iterate this array
 * directly, so the array's order is also the navigator's on-screen category
 * order (Tables, then Views, then Materialized Views, then Sequences).
 */
export const OBJECT_KINDS: readonly ObjectKindInfo[] = [
    { kind: "database", glyph: "database", isRelation: false },
    { kind: "schema", glyph: "folder", isRelation: false },
    { kind: "table", glyph: "table", categoryLabel: "Tables", isRelation: true },
    { kind: "view", glyph: "eye", categoryLabel: "Views", isRelation: true },
    { kind: "materializedView", glyph: "layer-group", categoryLabel: "Materialized Views", isRelation: true },
    { kind: "sequence", glyph: "arrow-up-1-9", categoryLabel: "Sequences", isRelation: false },
];

/**
 * Look up a kind's registry entry.
 *
 * @param kind - the object kind to resolve.
 * @throws Error if `kind` has no registry entry — should never happen, since
 *   every `DbObjectKind` member has a corresponding `OBJECT_KINDS` entry;
 *   this only guards against the two falling out of sync.
 * @returns the kind's `ObjectKindInfo`.
 */
function kindInfo(kind: DbObjectKind): ObjectKindInfo {
    const entry = OBJECT_KINDS.find(k => k.kind === kind);

    if (!entry) {
        throw new Error(`No registry entry for object kind '${kind}'`);
    }

    return entry;
}

/**
 * Whether `kind` opens a Dock data tab and offers the relation context-menu
 * items (table/view/materializedView) — false for containers (database,
 * schema) and for listed-but-non-tabular leaves (sequence).
 *
 * @param kind - the object kind to check, or `undefined` for a node with no
 *   `DbObjectRef` (a category group).
 * @returns whether `kind` is a relation.
 */
export function isRelationKind(kind: DbObjectKind | undefined): boolean {
    return kind !== undefined && kindInfo(kind).isRelation;
}

/**
 * The registered glyph name for `kind`.
 *
 * @param kind - the object kind to resolve.
 * @returns the glyph name.
 */
export function kindGlyph(kind: DbObjectKind): string {
    return kindInfo(kind).glyph;
}

/**
 * The navigator's object categories, in display order — one per
 * `OBJECT_KINDS` entry that carries a `categoryLabel`. Each groups the
 * leaves of one wire kind under a synthetic, non-selectable parent node; an
 * empty category is omitted by the caller so a schema shows only the groups
 * it actually has.
 *
 * @returns the `{label, kind}` pairs, in registry order.
 */
export function objectCategories(): { label: string; kind: DbObjectKind }[] {
    return OBJECT_KINDS
        .filter((entry): entry is ObjectKindInfo & { categoryLabel: string } => entry.categoryLabel !== undefined)
        .map(entry => ({ label: entry.categoryLabel, kind: entry.kind }));
}
