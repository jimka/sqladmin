// Every role-inspection and role-diagram action — the roles rail's list
// fetch, the grants tab, the membership/grants-graph diagrams, and the
// per-role export — split out of SqlAdminController.ts.

import { Util } from "@jimka/typescript-ui/core";
import type { DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { DbObjectRef, RoleDetail, RolePrivilege, RoleSummary } from "../contract";
import { getRoles, getRoleDetail } from "../data/api";
import { buildRoleMembershipDiagram } from "../data/buildRoleMembershipDiagram";
import { buildRoleGrantsDiagram } from "../data/buildRoleGrantsDiagram";
import { RoleGrantsPanel } from "../dock/RoleGrantsPanel";
import { RoleGrantsDiagramPanel } from "../dock/RoleGrantsDiagramPanel";
import { RoleMembershipDiagramPanel } from "../dock/RoleMembershipDiagramPanel";
import { exportRoleGrants } from "../dock/exportRoleGrants";
import { rolePath } from "../shell/routeTargets";
import type { PanelRoute } from "../shell/routeTargets";
import { matchesGrantedTable } from "../navigator/revealMatch";
import { roleGrantsPanelId, roleGrantsDiagramPanelId, roleMembershipDiagramPanelId } from "./controllerText";
import { PanelLoadError } from "./panelHost";
import type { PanelHost, ShowObjectContextMenu } from "./panelHost";
import type { RevealCoordinator } from "./revealCoordinator";
import type { ObjectPanels } from "./objectPanels";

// The registered glyph name for a role node in the diagram views (the
// membership root; buildRoleGrantsDiagram's/buildRoleMembershipDiagram's own
// role nodes carry the same literal — see SqlAdminController.ts's
// buildIdentityWidget for the identity-badge copy of this same glyph name).
const ROLE_GLYPH = "user";

export class RoleActions {
    private readonly host: PanelHost;
    private readonly reveal: RevealCoordinator;
    private readonly panels: ObjectPanels;
    private readonly showContextMenu: ShowObjectContextMenu;

    // The monotonic guard for the Roles view's detail fetch (showRoleProperties).
    private _roleSeq: number = 0;

    constructor(host: PanelHost, reveal: RevealCoordinator, panels: ObjectPanels, showContextMenu: ShowObjectContextMenu) {
        this.host            = host;
        this.reveal          = reveal;
        this.panels           = panels;
        this.showContextMenu = showContextMenu;
    }

    /**
     * Fetch the role list for the Roles view's tree. The connection id stays
     * encapsulated here; the caller maps the result to nodes and reports any
     * failure via {@link PanelHost.notifyError}.
     */
    loadRoles(): Promise<RoleSummary[]> {
        return getRoles(this.host.connectionId);
    }

    /**
     * Open (or focus) the selected role's grants tab in the Dock work area and
     * show its base info (attributes + memberships) in the roles inspector. The
     * grants tab opens at once behind the library's spinner, with the role detail
     * fetched behind it — so a slow fetch never blocks the tab from appearing
     * (mirroring how ObjectPanels.openTable defers a table's fetch). Reached by a
     * double-click or the roles rail's "Show data".
     */
    showRole(name: string): void {
        this.openRoleGrants(name);
    }

    /**
     * Show the selected role's base info (attributes + memberships) in the roles
     * inspector only, without opening its grants tab — the single-click preview.
     * Opening the grants tab is {@link showRole} (double-click / "Show data").
     */
    async showRoleProperties(name: string): Promise<void> {
        const detail = await this.fetchRoleDetail(name);

        if (detail) {
            this.host.rolesProperties.show(detail);
        }
    }

    /**
     * Open (or focus) the role-membership graph rooted at `name`: every role as
     * a node, `role -> parent` edges from each role's `memberOf`, driven by
     * RoleMembershipDiagramPanel (direction / depth / legend). The membership
     * DAG needs every role's detail, so this fans out N per-role fetches — there
     * is no combined role-detail endpoint to collapse this into, but N is a
     * small role list, so the fan-out is acceptable. Double-clicking another
     * role node shows its properties in the inspector; it does not open a
     * table tab.
     *
     * @param name - The role to root the graph at.
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    async openRoleMembershipDiagram(name: string, depth?: string): Promise<void> {
        const id = roleMembershipDiagramPanelId(this.host.connectionId, name);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const built = rolePath(name, "membership");
        const route: PanelRoute = { path: built.path, query: depth ? { depth } : undefined };

        this.host.openAsyncPanel({
            id,
            title         : `${name} (membership)`,
            glyph         : "diagram-project",
            route,
        }, async () => {
            // Runs behind the spinner; a throw here closes the tab and reaches
            // the "exception" handler.
            const roles   = await this.loadRoles();
            const details = await Promise.all(roles.map(r => getRoleDetail(this.host.connectionId, r.name)));

            const full = buildRoleMembershipDiagram(details, Util.measureTextWidths);
            const root: DiagramNodeData = { id: name, label: name, glyph: ROLE_GLYPH };

            this.host.status(`${name}: membership (${full.nodes.length} roles)`);

            return RoleMembershipDiagramPanel(full, root, roleName => void this.showRoleProperties(roleName), depth);
        });
    }

    /**
     * Open (or focus) the per-role grants graph for `name`: the role node at
     * the centre, one node per distinct table it holds a privilege on.
     * Double-clicking a table node reveals + opens it via openGrantedTable.
     *
     * @param name - The role whose grants to graph.
     */
    async openRoleGrantsDiagram(name: string): Promise<void> {
        const id = roleGrantsDiagramPanelId(this.host.connectionId, name);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const route = rolePath(name, "grants-diagram");

        this.host.openAsyncPanel({
            id,
            title         : `${name} (grants graph)`,
            glyph         : "diagram-project",
            route,
        }, async () => {
            const detail = await this.fetchRoleDetail(name);

            if (!detail) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, undefined, true);
            }

            const data = buildRoleGrantsDiagram(name, detail.privileges, Util.measureTextWidths);

            this.host.status(`${name}: grants graph (${data.nodes.length - 1} tables)`);

            return RoleGrantsDiagramPanel(
                data,
                (schema, table) => this.openGrantedTable(schema, table),
                // Grants are within the connected database (RolePrivilege carries
                // no database of its own), so the ref is built with the session
                // db — the same database every navigator object lives in.
                (schema, table, event) => this.showContextMenu({
                    connectionId: this.host.connectionId,
                    database    : this.host.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }, event),
            );
        });
    }

    /**
     * Fetch a role's detail and export its full grant set as CSV or JSON — the
     * roles context-menu convenience, usable on a role whose tab is not open.
     * Notifies when the role has no table grants.
     *
     * @param role - The role to export.
     * @param format - The export format, "csv" or "json".
     */
    async exportRole(role: string, format: "csv" | "json"): Promise<void> {
        let privileges: RolePrivilege[];

        try {
            privileges = (await getRoleDetail(this.host.connectionId, role)).privileges;
        } catch (err) {
            this.host.notifyError(err);

            return;
        }

        if (privileges.length === 0) {
            this.host.status(`${role} has no table grants to export`);

            return;
        }

        exportRoleGrants(role, privileges, format);
    }

    /**
     * Fetch a role's detail under the monotonic role guard, returning it only
     * while it is still the current selection (otherwise `null`); a failed fetch
     * reports the error and returns `null`. Shared by {@link showRole} and
     * {@link showRoleProperties} so rapid role clicks never render a stale role.
     */
    private async fetchRoleDetail(name: string): Promise<RoleDetail | null> {
        const seq = ++this._roleSeq;

        try {
            const detail = await getRoleDetail(this.host.connectionId, name);

            return seq === this._roleSeq ? detail : null;
        } catch (err) {
            if (seq === this._roleSeq) {
                this.host.notifyError(err);
            }

            return null;
        }
    }

    /**
     * Open the role's table grants in a Dock tab, or focus the existing one, and
     * refresh the roles inspector for the selection. The tab is deduped by role
     * (mirroring how a table opens its data tab); the grids are read-only and a
     * role's grants do not change within a session, so a re-selection focuses the
     * open tab and only re-previews the inspector, without rebuilding the grid.
     *
     * The role detail is fetched behind the tab's own spinner (not before the tab
     * opens) so opening never blocks on the round-trip, and it feeds both the
     * grants grid and the inspector. Unlike the transient inspector preview
     * (fetchRoleDetail), the fetch here is unguarded: a grants tab is deduped and
     * persistent, so there is no stale selection to discard — a failure closes
     * the tab and reports through the Dock "exception" handler.
     */
    private openRoleGrants(role: string): void {
        const id = roleGrantsPanelId(this.host.connectionId, role);

        if (this.host.dock.focusPanel(id)) {
            void this.showRoleProperties(role);

            return;
        }

        const route = rolePath(role);

        this.host.openAsyncPanel({ id, title: `Grants: ${role}`, glyph: "key", route }, async () => {
            const detail = await getRoleDetail(this.host.connectionId, role);

            this.host.rolesProperties.show(detail);

            // Track the grant set so the active-tab export (Tools menu) can reach
            // it while this tab is focused, mirroring the query-panel result map.
            this.host.setActiveRoleGrants(id, { role, privileges: detail.privileges });

            return RoleGrantsPanel(role, detail.privileges);
        });
    }

    /**
     * Reveal a granted table in the navigator by schema+name and open it
     * (best-effort). `RolePrivilege` carries no database (the roles endpoint is
     * not database-scoped), so — unlike ObjectPanels.openReferencedTable, which
     * matches on database + schema + name — this matches on schema + name only
     * and adopts whichever database the first matching revealed navigator node
     * carries. The reveal waits for the navigator's own load first, so an early
     * double-click in a grants graph no longer misses a tree that is still
     * filling; if no node genuinely matches (the table's database was never
     * browsed), status-bars a "not found" message and opens nothing. Only
     * `openRoleGrantsDiagram` calls this.
     *
     * @param schema - The granted table's schema.
     * @param table - The granted table's name.
     */
    private openGrantedTable(schema: string, table: string): void {
        void (async () => {
            const node = await this.reveal.findInNavigator(matchesGrantedTable(schema, table));

            if (!node) {
                this.host.status(`${schema}.${table}: not found in navigator`);

                return;
            }

            await this.panels.openTable(node.data as DbObjectRef, node);
            this.reveal.selectNavigatorNode(node);
        })();
    }
}
