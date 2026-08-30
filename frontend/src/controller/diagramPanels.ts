// Every diagram/graph opener — the schema and database ER diagrams, a
// relation-rooted FK diagram, and the schema-wide/relation-rooted
// dependency and inheritance graphs — split out of SqlAdminController.ts.
// The dependency and inheritance families share one body
// (openSchemaRelationGraph/openRootedRelationGraph) parameterized by
// `RelationGraphKind`, since after diagram-panel-family-convergence they
// differ only in fetch/glyph/panel-id, not in shape.

import type { DiagramData, DiagramNodeData } from "@jimka/typescript-ui/component/diagram";
import type { TreeNode } from "@jimka/typescript-ui/component/tree";
import type { RelationNodeData } from "../data/buildRelationGraph";
import { buildRelationGraph, relationNodeId } from "../data/buildRelationGraph";
import type { ColumnMeta, DbObjectRef, RelationNodeRef } from "../contract";
import { Util } from "@jimka/typescript-ui/core";
import { getSchemaGraph, getDatabaseGraph, getDependencies, getInheritance } from "../data/api";
import type { SchemaTables } from "../data/buildDatabaseDiagram";
import { buildSchemaDiagram } from "../data/buildSchemaDiagram";
import { annotateFkCardinality } from "../data/fkCardinality";
import { SchemaDiagramPanel } from "../dock/SchemaDiagramPanel";
import { DatabaseDiagramPanel } from "../dock/DatabaseDiagramPanel";
import { RelationDiagramPanel } from "../dock/RelationDiagramPanel";
import { RelationGraphPanel } from "../dock/RelationGraphPanel";
import { RootedRelationGraphPanel } from "../dock/RootedRelationGraphPanel";
import { objectPath, databaseDiagramPath } from "../shell/routeTargets";
import type { PanelRoute } from "../shell/routeTargets";
import { KIND_GLYPH } from "../navigator/objectGlyphs";
import { diagramPanelId, databaseDiagramPanelId, relationDiagramPanelId, dependencyPanelId, relationDependencyPanelId, inheritancePanelId, relationInheritancePanelId } from "./controllerText";
import { PanelLoadError } from "./panelHost";
import type { PanelHost, ShowObjectContextMenu } from "./panelHost";
import type { ObjectPanels } from "./objectPanels";
import { LAYERED_RIGHT, LAYERED_DOWN } from "../data/diagramLayout";

// Dependency graph reads left-to-right as a dependency flow (view -> underlying),
// matching the FK schema diagram's RIGHT layered layout.
const DEPENDENCY_LAYOUT = LAYERED_RIGHT;

// Inheritance reads top-to-bottom as a containment tree (parent above children).
const INHERITANCE_LAYOUT = LAYERED_DOWN;

/**
 * What the dependency and inheritance graph open paths differ by — everything
 * `openSchemaRelationGraph`/`openRootedRelationGraph` need to build either
 * graph without branching on which one it is.
 */
interface RelationGraphKind {
    /** Route key, title suffix, and status-line word ("dependencies"/"inheritance"). */
    key: "dependencies" | "inheritance";
    /** The tab glyph. */
    glyph: string;
    /** The whole schema's graph, or null after the failure was already reported. */
    fetch: (ref: DbObjectRef) => Promise<DiagramData | null>;
    /** The schema-wide tab's panel id. */
    schemaPanelId: (ref: DbObjectRef) => string;
    /** The relation-rooted tab's panel id. */
    relationPanelId: (ref: DbObjectRef) => string;
}

export class DiagramPanels {
    private readonly host: PanelHost;
    private readonly panels: ObjectPanels;
    private readonly showContextMenu: ShowObjectContextMenu;

    constructor(host: PanelHost, panels: ObjectPanels, showContextMenu: ShowObjectContextMenu) {
        this.host            = host;
        this.panels          = panels;
        this.showContextMenu = showContextMenu;
    }

    /**
     * Open a read-only entity-relationship diagram for a whole schema in the Dock
     * (deduped by panel id): tables as nodes, foreign keys as edges, auto-laid-out
     * by ELK. Selecting a node opens that table's data tab via ObjectPanels.openReferencedTable.
     *
     * @param ref - The schema to diagram (kind "schema"; database + schema set).
     * @param _node - The schema's navigator node; accepted for call-site parity
     *   with the panel openers but unused — the diagram tab is not registered
     *   in the open-panel registry, so there is no node to remember.
     */
    async openSchemaDiagram(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        const id = diagramPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, "diagram") ?? undefined;

        this.host.openAsyncPanel({
            id,
            title         : `${ref.schema} (diagram)`,
            glyph         : "diagram-project",
            ref,
            route,
        }, async () => {
            const data = await this.buildSchemaGraphData(ref);

            if (!data) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            this.host.status(`${ref.schema}: diagram (${data.nodes.length} tables)`);

            return SchemaDiagramPanel(
                data,
                table => this.panels.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : ref.schema,
                    name        : table,
                    kind        : "table",
                }),
                (table, event) => this.showContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : ref.schema,
                    name        : table,
                    kind        : "table",
                }, event),
            );
        });
    }

    /**
     * Fetch a whole schema's ER graph in one bulk request and assemble the
     * nodes+edges via buildSchemaDiagram. Shared by the schema diagram and the
     * relation-rooted diagram (which walks this full graph from a chosen
     * root). Returns null on failure, having already reported the error.
     *
     * @param ref - The schema to fetch (database + schema set).
     * @param opts - `withColumns` builds card-mode nodes (table cards +
     *   column-to-column FK ports) from the endpoint's always-fetched columns
     *   — used by the relation-rooted diagram; omitted (or false) keeps the
     *   flat table-to-table graph the schema-wide diagram shows.
     * @returns The full schema graph, or null if the fetch failed.
     */
    private async buildSchemaGraphData(ref: DbObjectRef, opts?: { withColumns?: boolean }): Promise<DiagramData | null> {
        try {
            const graph      = await getSchemaGraph(ref);
            const tables     = graph.tables.map(t => t.name);
            const structures = graph.tables.map(t => t.structure);
            const columns    = graph.tables.map(t => t.columns);

            const columnsByTable: Map<string, ColumnMeta[]> | undefined =
                opts?.withColumns ? new Map(graph.tables.map(t => [t.name, t.columns])) : undefined;

            // The measurer is injected here, rather than inside buildSchemaDiagram
            // or uniformNodeWidth, because this is the first module in the chain
            // allowed to touch the DOM — both of those stay pure and
            // node-vitest-testable (see buildSchemaDiagram.ts's header note).
            const diagram = buildSchemaDiagram(tables, structures, columnsByTable, Util.measureTextWidths);

            return annotateFkCardinality(diagram, tables, structures, columns);
        } catch (err) {
            this.host.notifyError(err, ref);

            return null;
        }
    }

    /**
     * Open a read-only entity-relationship diagram spanning every schema in a
     * database in the Dock (deduped by panel id). The panel defaults to a
     * legible schema-overview graph and offers a rooted/filtered Tables mode;
     * selecting a table opens its data tab via ObjectPanels.openReferencedTable,
     * reading *that leaf's own* schema off its node data (unlike the
     * single-schema diagram, which hardcodes `schema: ref.schema` — a database
     * diagram spans many schemas, so the schema varies per node).
     *
     * @param ref - The database to diagram (kind "database"; database set).
     * @param _node - The database's navigator node; accepted for call-site
     *   parity with the other open methods but unused — the diagram tab is not
     *   registered in the open-panel registry, so there is no node to remember.
     */
    async openDatabaseDiagram(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        const id = databaseDiagramPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const route = databaseDiagramPath();

        this.host.openAsyncPanel({
            id,
            title         : `${ref.database} (diagram)`,
            glyph         : "circle-nodes",
            ref,
            route,
        }, async () => {
            const schemas = await this.buildDatabaseGraphData(ref);

            if (!schemas) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            const tableCount = schemas.reduce((total, s) => total + s.tables.length, 0);

            this.host.status(`${ref.database}: diagram (${tableCount} tables)`);

            return DatabaseDiagramPanel(
                schemas,
                (schema, table) => this.panels.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }),
                (schema, table, event) => this.showContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema,
                    name        : table,
                    kind        : "table",
                }, event),
            );
        });
    }

    /**
     * Fetch every schema's tables + structures for the database diagram in one
     * bulk request. The on-screen graph size is bounded by
     * DatabaseDiagramPanel's rooted+prune+per-schema-hide filter layer, not by
     * this fetch. Returns null on failure, having already reported the error.
     *
     * @param ref - The database to fetch (database set).
     * @returns Every schema's tables + structures, or null if the fetch failed.
     */
    private async buildDatabaseGraphData(ref: DbObjectRef): Promise<SchemaTables[] | null> {
        try {
            const graph = await getDatabaseGraph(ref);

            return graph.schemas.map(s => ({
                schema    : s.schema,
                tables    : s.tables.map(t => t.name),
                structures: s.tables.map(t => t.structure),
            } satisfies SchemaTables));
        } catch (err) {
            this.host.notifyError(err, ref);

            return null;
        }
    }

    /**
     * Open a relation-rooted foreign-key diagram in the Dock (deduped by panel
     * id): the relation as the emphasized root, its FK neighbours out to a
     * user-chosen direction and depth, with a legend that hides nodes. Reuses the
     * schema-wide structure fetch and walks it from the root. A view /
     * materialized-view root shows alone — PostgreSQL foreign keys are
     * table-only. Node activation reuses ObjectPanels.openReferencedTable.
     *
     * @param ref - The relation to root at (kind table/view/matview; name set).
     * @param _node - The relation's navigator node; accepted for call-site parity
     *   with the other open methods but unused (the diagram tab is not tracked
     *   in the open-panel registry).
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    async openRelationDiagram(ref: DbObjectRef, _node?: TreeNode, depth?: string): Promise<void> {
        const id = relationDiagramPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const built = objectPath(ref, "diagram");
        const route: PanelRoute | undefined = built ? { path: built.path, query: depth ? { depth } : undefined } : undefined;

        this.host.openAsyncPanel({
            id,
            title         : `${ref.name} (relations)`,
            glyph         : "diagram-project",
            tooltip       : this.host.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const full = await this.buildSchemaGraphData(ref, { withColumns: true });

            if (!full) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            const root: DiagramNodeData = { id: ref.name!, label: ref.name!, glyph: KIND_GLYPH[ref.kind] };

            this.host.status(`${ref.schema}.${ref.name}: relations`);

            return RelationDiagramPanel(
                full,
                root,
                table => this.panels.openReferencedTable({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : ref.schema,
                    name        : table,
                    kind        : "table",
                }),
                (table, event) => this.showContextMenu({
                    connectionId: ref.connectionId,
                    database    : ref.database,
                    schema      : ref.schema,
                    name        : table,
                    kind        : "table",
                }, event),
                depth,
            );
        });
    }

    /**
     * Fetch a schema's view/matview dependency graph: the view -> underlying
     * relation edges from the dependencies endpoint, assembled via
     * buildRelationGraph with dashed edges (distinguishing dependency edges
     * from a plain FK diagram's). Returns null on failure, having already
     * reported the error.
     *
     * @param ref - The schema to fetch (database + schema set).
     * @returns The full dependency graph, or null if the fetch failed.
     */
    private async fetchDependencyGraph(ref: DbObjectRef): Promise<DiagramData | null> {
        try {
            const edges = await getDependencies(ref.connectionId, ref.database!, ref.schema!);

            return buildRelationGraph(edges, ref.schema!, DEPENDENCY_LAYOUT, true, Util.measureTextWidths);
        } catch (err) {
            this.host.notifyError(err, ref);

            return null;
        }
    }

    /**
     * Fetch a schema's inheritance/partitioning graph: the parent -> child
     * edges from the inheritance endpoint, assembled via buildRelationGraph
     * with plain edges. Returns null on failure, having already reported the
     * error.
     *
     * @param ref - The schema to fetch (database + schema set).
     * @returns The full inheritance graph, or null if the fetch failed.
     */
    private async fetchInheritanceGraph(ref: DbObjectRef): Promise<DiagramData | null> {
        try {
            const edges = await getInheritance(ref.connectionId, ref.database!, ref.schema!);

            return buildRelationGraph(edges, ref.schema!, INHERITANCE_LAYOUT, undefined, Util.measureTextWidths);
        } catch (err) {
            this.host.notifyError(err, ref);

            return null;
        }
    }

    /** What the dependency and inheritance graph paths differ by. */
    private graphKind(key: "dependencies" | "inheritance"): RelationGraphKind {
        return key === "dependencies"
            ? {
                key,
                glyph          : "share-nodes",
                fetch          : ref => this.fetchDependencyGraph(ref),
                schemaPanelId  : ref => dependencyPanelId(ref),
                relationPanelId: ref => relationDependencyPanelId(ref),
            }
            : {
                key,
                glyph          : "sitemap",
                fetch          : ref => this.fetchInheritanceGraph(ref),
                schemaPanelId  : ref => inheritancePanelId(ref),
                relationPanelId: ref => relationInheritancePanelId(ref),
            };
    }

    /**
     * The activate / context-menu arrow pair every dependency/inheritance
     * graph panel wires: both route through openReferencedTable /
     * showContextMenu, built from the activated node's own schema/name/kind
     * but `ref`'s connectionId/database — a graph node can name a relation in a
     * different schema than the one being diagrammed, but never a different
     * database.
     *
     * @param ref - The schema or relation the graph was opened for.
     * @returns The `onSelect`/`onContextMenu` pair to hand a graph panel.
     */
    private relationGraphHandlers(ref: DbObjectRef): {
        onSelect: (node: RelationNodeData) => void;
        onContextMenu: (node: RelationNodeData, event: MouseEvent) => void;
    } {
        return {
            onSelect: nd => this.panels.openReferencedTable({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            }),
            onContextMenu: (nd, event) => this.showContextMenu({
                connectionId: ref.connectionId,
                database    : ref.database,
                schema      : nd.schema,
                name        : nd.name,
                kind        : nd.kind,
            }, event),
        };
    }

    /**
     * Open a read-only dependency/inheritance graph for a whole schema in the
     * Dock (deduped by panel id): the schema's relations as nodes, laid out
     * left-to-right by ELK. Node activation is kind-aware: a view opens
     * read-only, a table opens for data.
     *
     * @param ref - The schema to diagram (kind "schema"; database + schema set).
     * @param kind - Which graph (dependencies or inheritance) to open.
     */
    private async openSchemaRelationGraph(ref: DbObjectRef, kind: RelationGraphKind): Promise<void> {
        const id = kind.schemaPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const route = objectPath(ref, kind.key) ?? undefined;

        this.host.openAsyncPanel({
            id,
            title         : `${ref.schema} (${kind.key})`,
            glyph         : kind.glyph,
            ref,
            route,
        }, async () => {
            const data = await kind.fetch(ref);

            if (!data) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            this.host.status(`${ref.schema}: ${kind.key} (${data.nodes.length} relations)`);

            const { onSelect, onContextMenu } = this.relationGraphHandlers(ref);

            return RelationGraphPanel(data, onSelect, onContextMenu);
        });
    }

    /**
     * Open a relation-rooted dependency/inheritance graph in the Dock (deduped
     * by panel id): the relation as the emphasized root plus its connected
     * component within the direction/depth the panel's own controls choose
     * (seeded at Both/1) from the whole schema's graph. Node activation is
     * kind-aware via ObjectPanels.openReferencedTable.
     *
     * @param ref - The relation to root at (kind table/view/matview; name set).
     * @param kind - Which graph (dependencies or inheritance) to open.
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    private async openRootedRelationGraph(ref: DbObjectRef, kind: RelationGraphKind, depth?: string): Promise<void> {
        const id = kind.relationPanelId(ref);

        if (this.host.dock.focusPanel(id)) {
            return;
        }

        const built = objectPath(ref, kind.key);
        const route: PanelRoute | undefined = built ? { path: built.path, query: depth ? { depth } : undefined } : undefined;

        this.host.openAsyncPanel({
            id,
            title         : `${ref.name} (${kind.key})`,
            glyph         : kind.glyph,
            tooltip       : this.host.panelTooltip(ref),
            ref,
            route,
        }, async () => {
            const full = await kind.fetch(ref);

            if (!full) {
                // The helper already reported. Throwing closes the tab without a second toast.
                throw new PanelLoadError(null, ref, true);
            }

            const root: DiagramNodeData = {
                id   : relationNodeId(ref as RelationNodeRef),
                label: ref.name!,
                glyph: KIND_GLYPH[ref.kind],
                data : { schema: ref.schema!, name: ref.name!, kind: ref.kind },
            };

            this.host.status(`${ref.schema}.${ref.name}: ${kind.key}`);

            const { onSelect, onContextMenu } = this.relationGraphHandlers(ref);

            return RootedRelationGraphPanel(full, root, onSelect, onContextMenu, depth);
        });
    }

    /**
     * Open a read-only view/matview dependency graph for a whole schema in the
     * Dock (deduped by panel id): views/matviews as nodes, edges to the
     * relations they read, laid out left-to-right by ELK. Node activation is
     * kind-aware: a view opens read-only, a table opens for data.
     *
     * @param ref - The schema to diagram (kind "schema"; database + schema set).
     * @param _node - The schema's navigator node; accepted for call-site parity
     *   with the other open methods but unused — the tab is not registered in
     *   the open-panel registry, so there is no node to remember.
     */
    async openSchemaDependencyGraph(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        return this.openSchemaRelationGraph(ref, this.graphKind("dependencies"));
    }

    /**
     * Open a relation-rooted dependency graph in the Dock (deduped by panel
     * id): the relation as the emphasized root plus its connected dependency
     * component within the direction/depth the panel's own controls choose
     * (seeded at Both/1) from the whole schema's dependency graph. Node
     * activation is kind-aware via ObjectPanels.openReferencedTable.
     *
     * @param ref - The relation to root at (kind table/view/matview; name set).
     * @param _node - The relation's navigator node; accepted for call-site
     *   parity with the other open methods but unused.
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    async openRelationDependencyGraph(ref: DbObjectRef, _node?: TreeNode, depth?: string): Promise<void> {
        return this.openRootedRelationGraph(ref, this.graphKind("dependencies"), depth);
    }

    /**
     * Open a read-only table inheritance/partitioning graph for a whole schema
     * in the Dock (deduped by panel id): a top-to-bottom tree, parent -> child.
     * Node activation is kind-aware via ObjectPanels.openReferencedTable.
     *
     * @param ref - The schema to diagram (kind "schema"; database + schema set).
     * @param _node - The schema's navigator node; accepted for call-site parity
     *   with the other open methods but unused.
     */
    async openSchemaInheritanceGraph(ref: DbObjectRef, _node?: TreeNode): Promise<void> {
        return this.openSchemaRelationGraph(ref, this.graphKind("inheritance"));
    }

    /**
     * Open a relation-rooted inheritance/partitioning graph in the Dock
     * (deduped by panel id): the relation as the emphasized root plus its
     * connected inheritance component within the direction/depth the panel's
     * own controls choose (seeded at Both/1) from the whole schema's
     * inheritance graph. Node activation is kind-aware via
     * ObjectPanels.openReferencedTable.
     *
     * @param ref - The relation to root at (kind table; name set).
     * @param _node - The relation's navigator node; accepted for call-site
     *   parity with the other open methods but unused.
     * @param depth - A `DEPTH_CHOICES` entry (see `depthChoices.ts`) the Depth
     *   control opens at; anything else opens at the default.
     */
    async openRelationInheritanceGraph(ref: DbObjectRef, _node?: TreeNode, depth?: string): Promise<void> {
        return this.openRootedRelationGraph(ref, this.graphKind("inheritance"), depth);
    }
}
