// Owns the two sidebar trees' reveal/select wiring — the "find this node,
// bring its tree's view forward, select it" tail repeated across seven call
// sites in SqlAdminController.ts before this split. No library value import:
// `ExplorerTree`/`TreeNode` are type-only and `matchesObject`/`matchesRole`/
// `matchesRoleSection` come from the DOM-free navigator/revealMatch.ts, so
// this module loads under the node vitest harness — mirroring
// startPageWelcome.ts's own header.

import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { ExplorerTree } from "../shell/explorerTree";
import type { DbObjectRef } from "../contract";
import type { NodeMatch } from "../navigator/revealMatch";
import { matchesObject, matchesRole, matchesRoleSection } from "../navigator/revealMatch";

/** What a reveal does once its node is found. */
export interface RevealOptions {
    /** Also expand the revealed node (a schema's categories, a role section's leaves). */
    expand?: boolean;
    /**
     * Start a panel open alongside the reveal, handed the still-pending reveal
     * so a slow tree search never delays the tab. Called synchronously.
     */
    open?: (revealed: Promise<TreeNode | undefined>) => void;
}

/** The per-tree handles a reveal needs: which view to bring forward, and which tree to search. */
interface SideHandles {
    show: () => void;
    tree: () => ExplorerTree | null;
}

export class RevealCoordinator {
    private readonly connectionId: string;
    private readonly database: string | undefined;

    private _navigator: ExplorerTree | null = null;
    // The Roles rail's tree, registered the same way the navigator is, so a role
    // opened from a route or a link can drive its selection too.
    private _rolesTree: ExplorerTree | null = null;

    // Shell-injected handles (mirroring how ActivityBar takes a SidebarSizer):
    // bring the Database / Roles view forward, so a reveal never searches a
    // tree whose deck page is hidden.
    private _showDatabaseView: (() => void) | null = null;
    private _showRolesView: (() => void) | null = null;

    /**
     * @param connectionId - The connection {@link revealSchema}'s synthesized
     *   schema ref carries.
     * @param database - The connected database {@link revealSchema}'s
     *   synthesized schema ref carries.
     */
    constructor(connectionId: string, database: string | undefined) {
        this.connectionId = connectionId;
        this.database = database;
    }

    /**
     * Register the navigator tree so the focused tab can drive its
     * selection and table-DDL launchers can trigger its top-level `refresh`.
     */
    setNavigator(tree: ExplorerTree): void {
        this._navigator = tree;
    }

    /**
     * Register the roles tree so a role open can drive its selection, mirroring
     * {@link setNavigator}.
     */
    setRolesTree(tree: ExplorerTree): void {
        this._rolesTree = tree;
    }

    /**
     * Register the shell's Database-view selector, so a navigator reveal can
     * bring the tree it searches forward.
     *
     * @param select - Makes the Database activity-bar view the active one.
     */
    setShowDatabaseView(select: () => void): void {
        this._showDatabaseView = select;
    }

    /**
     * Register the shell's Roles-view selector, so a roles-tree reveal can
     * bring the tree it searches forward.
     *
     * @param select - Makes the Roles activity-bar view the active one.
     */
    setShowRolesView(select: () => void): void {
        this._showRolesView = select;
    }

    /** Refresh the navigator's top level (every DDL flow's success path). */
    refreshNavigator(): void {
        this._navigator?.refresh?.();
    }

    /** Select `node` in the navigator (the focus-driven sidebar sync). */
    selectNavigatorNode(node: TreeNode): void {
        this._navigator?.selectNode(node);
    }

    /** Bring the Database view forward, reveal the first matching node, select it. */
    revealInNavigator(match: NodeMatch, options?: RevealOptions): void {
        this.revealAndSelect("navigator", match, options);
    }

    /** The roles-side twin of revealInNavigator. */
    revealInRoles(match: NodeMatch, options?: RevealOptions): void {
        this.revealAndSelect("roles", match, options);
    }

    /**
     * Bring the Database view forward and reveal the first matching node,
     * awaitable and without selecting it — for a caller that must read the node
     * before deciding what to open (RoleActions.openGrantedTable).
     */
    findInNavigator(match: NodeMatch): Promise<TreeNode | undefined> {
        return this.find("navigator", match);
    }

    /**
     * Bring the Database view forward and select `ref`'s navigator node.
     *
     * The caller-side reveal a route handler pairs with its own `open*` call,
     * the same way `ObjectPanels.openReferencedTable` pairs one with
     * `openTable` — the sidebar follows an *open*, not a focus, so
     * `SqlAdminController.syncToPanel`'s focus-driven selection stays as it
     * is. Best-effort and fire-and-forget: a ref naming no navigator node only
     * switches the view.
     *
     * @param ref - The object just opened.
     */
    selectObject(ref: DbObjectRef): void {
        // A database-wide ref names no navigator node (the tree is rooted at
        // schemas — the app connects to one database per session), so switch the
        // view and stop: revealByPredicate walks depth first, so a search would
        // lazily fetch every schema's objects only to find nothing. Keyed on
        // `schema` rather than `kind === "database"` so any future schema-less
        // ref is covered by the same rule.
        if (!ref.schema) {
            this._showDatabaseView?.();

            return;
        }

        this.revealInNavigator(matchesObject(ref));
    }

    /**
     * Bring the Roles view forward and select `name`'s roles-tree node — the
     * roles-side twin of {@link selectObject}. Best-effort and
     * fire-and-forget: a name matching no leaf only switches the view.
     *
     * @param name - The role just opened.
     */
    selectRole(name: string): void {
        this.revealInRoles(matchesRole(name));
    }

    /**
     * Switch the sidebar to the Database view and expand `schema`'s own
     * navigator node (its category children become visible) — no tab opens.
     * Best-effort, mirroring selectObject: a schema matching no navigator
     * node only switches the view.
     *
     * @param schema - The schema to reveal.
     */
    revealSchema(schema: string): void {
        const ref: DbObjectRef = { connectionId: this.connectionId, database: this.database ?? "", schema, kind: "schema" };

        this.revealInNavigator(matchesObject(ref), { expand: true });
    }

    /**
     * Switch the sidebar to the Roles view and expand the named section's
     * group node ("Users" / "Groups" / "Predefined") — its role leaves
     * become visible — no tab opens. Best-effort, mirroring selectRole: a
     * section matching no group node only switches the view.
     *
     * @param section - The RolesTree section label to reveal.
     */
    revealRoleSection(section: string): void {
        this.revealInRoles(matchesRoleSection(section), { expand: true });
    }

    /** The per-tree handles a reveal needs: which view to bring forward, and which tree to search. */
    private side(side: "navigator" | "roles"): SideHandles {
        return side === "navigator"
            ? { show: () => this._showDatabaseView?.(), tree: () => this._navigator }
            : { show: () => this._showRolesView?.(),    tree: () => this._rolesTree };
    }

    /**
     * Bring the tree's view forward and reveal the first node `match` accepts, once
     * that tree has finished loading. The view switch comes first because revealing
     * means searching and scrolling, which is pointless while the tree's deck page is
     * hidden; the whenLoaded wait is what makes a reveal issued at boot search a
     * populated tree rather than one still filling.
     */
    private async find(side: "navigator" | "roles", match: NodeMatch): Promise<TreeNode | undefined> {
        const handles = this.side(side);

        handles.show();
        await handles.tree()?.whenLoaded();

        return (await handles.tree()?.revealByPredicate(match)) ?? undefined;
    }

    private revealAndSelect(side: "navigator" | "roles", match: NodeMatch, options?: RevealOptions): void {
        const handles  = this.side(side);
        const revealed = this.find(side, match);

        // Started before the reveal is awaited, so the tab appears at once and the
        // selection lands whenever the tree search resolves.
        options?.open?.(revealed);

        void revealed.then(node => {
            if (!node) {
                return;
            }

            handles.tree()?.selectNode(node);

            if (options?.expand) {
                handles.tree()?.expandNode(node);
            }
        });
    }
}
