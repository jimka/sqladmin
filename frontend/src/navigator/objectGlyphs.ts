// The glyph for each database-object kind, shared by the navigator rows and the
// dock tabs (a relation tab shows its kind). This module owns the registration of
// those glyphs too, so both consumers get them without depending on import order.

import { Glyph }       from "@jimka/typescript-ui/component/display";
import { database }    from "@jimka/typescript-ui/glyphs/solid/database";
import { folder }      from "@jimka/typescript-ui/glyphs/solid/folder";
import { table }       from "@jimka/typescript-ui/glyphs/solid/table";
import { eye }         from "@jimka/typescript-ui/glyphs/solid/eye";
import { layer_group } from "@jimka/typescript-ui/glyphs/solid/layer_group";
import type { DbObjectKind } from "../contract";

Glyph.register(database, folder, table, eye, layer_group);

/**
 * The registered glyph name for each object kind. Database and schema are
 * containers; the object leaves (table / view / materialized view) reuse the same
 * glyphs their dock tabs carry.
 */
export const KIND_GLYPH: Record<DbObjectKind, string> = {
    database:         "database",
    schema:           "folder",
    table:            "table",
    view:             "eye",
    materializedView: "layer-group",
};
