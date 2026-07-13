// The glyph for each database-object kind, shared by the navigator rows and the
// dock tabs (a relation tab shows its kind). This module owns the registration of
// those glyphs too, so both consumers get them without depending on import order.
// KIND_GLYPH itself is built from the objectKinds.ts registry (the single source
// of each kind's glyph name) rather than a hand-maintained literal, so a phase
// that appends a kind there need not also touch this Record.

import { Glyph }        from "@jimka/typescript-ui/component/display";
import { database }     from "@jimka/typescript-ui/glyphs/solid/database";
import { folder }       from "@jimka/typescript-ui/glyphs/solid/folder";
import { table }        from "@jimka/typescript-ui/glyphs/solid/table";
import { eye }          from "@jimka/typescript-ui/glyphs/solid/eye";
import { layer_group }  from "@jimka/typescript-ui/glyphs/solid/layer_group";
import { arrow_up_1_9 } from "@jimka/typescript-ui/glyphs/solid/arrow_up_1_9";
import type { DbObjectKind } from "../contract";
import { OBJECT_KINDS }      from "./objectKinds";

Glyph.register(database, folder, table, eye, layer_group, arrow_up_1_9);

/**
 * The registered glyph name for each object kind, built from the
 * `objectKinds.ts` registry. `Object.fromEntries` returns a plain
 * `Record<string, string>`, so the cast trades the object-literal's
 * compile-time exhaustiveness check for the registry's single-source-of-truth
 * guarantee: as long as `OBJECT_KINDS` covers every `DbObjectKind` (which its
 * own tests pin), this Record does too.
 */
export const KIND_GLYPH: Record<DbObjectKind, string> =
    Object.fromEntries(OBJECT_KINDS.map(k => [k.kind, k.glyph])) as Record<DbObjectKind, string>;
