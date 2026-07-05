// The shared client-side role-grants export: serialize a role's full grant set
// (every page — the grants are held in memory) and trigger a Blob download. Used
// by the RoleGrantsPanel toolbar button, the controller's Query-menu entry point
// (the active grants tab), and the roles context menu, so the column mapping and
// filename stay in one place. The table analogue is exportQueryResult.

import { toCSV, toJSON }      from "../data/serialize";
import type { ExportColumn }  from "../data/serialize";
import { download }           from "../data/download";
import { CSV_MIME, JSON_MIME } from "../data/mime";
import type { RolePrivilege } from "../contract";

/**
 * Serialize a role's full grant set and download it as CSV or JSON. Exports every
 * grant (all pages) — the complete list is in memory, so paging never limits it.
 *
 * @param role - The role name, used for the download filename.
 * @param privileges - The role's complete grant list.
 * @param format - The export format, "csv" or "json".
 */
export function exportRoleGrants(role: string, privileges: RolePrivilege[], format: "csv" | "json"): void {
    // The grant fields map one-to-one to columns: schema/table/privilege are
    // strings, grantable is a boolean.
    const columns: ExportColumn[] = [
        { name: "schema",    wireType: "string" },
        { name: "table",     wireType: "string" },
        { name: "privilege", wireType: "string" },
        { name: "grantable", wireType: "boolean" },
    ];

    const rows    = privileges as unknown as Record<string, unknown>[];
    const content = format === "csv" ? toCSV(columns, rows) : toJSON(columns, rows);
    const mime    = format === "csv" ? CSV_MIME : JSON_MIME;

    download(content, `${role}.grants.${format}`, mime);
}
