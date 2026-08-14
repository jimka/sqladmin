// Builds the app's Router: one route per view this app can deep-link to,
// each mapped onto the controller's existing `open*` methods (see
// SqlAdminController.ts). Consume-only — nothing here ever calls
// router.navigate or getHref; the URL is read once at boot (SqlAdminApp.ts's
// router.start()) and never written. Object identity (schema/name/role) comes
// from the path; view-mode properties (depth, rotated, record) come from the
// query string — see the plan's "Object identity lives in path segments;
// view-mode properties live in the query string" Architecture Decision.
//
// Every registered handler runs through `dispatch`, which catches a
// synchronous throw or a rejected promise and routes both to
// controller.notifyError — a route must never reject into SqlAdminApp's boot
// catch. A route that matches no pattern, or whose trailing view segment
// names nothing the object kind supports, reports through
// `reportUnknownLink` instead, leaving the start page as it is.

import { Router } from "@jimka/typescript-ui/router";
import type { SqlAdminController } from "../SqlAdminController";
import type { DbObjectRef } from "../contract";
import { RELATION_KINDS, relationView, schemaView, roleView, routeFlag } from "./routeTargets";
import type { RelationKind } from "./routeTargets";

/**
 * Run a route handler's body, reporting anything it throws or rejects with.
 * A route must never reject into SqlAdminApp's boot catch.
 *
 * @param controller - Reports the failure through `notifyError`.
 * @param open - The handler's body.
 */
function dispatch(controller: SqlAdminController, open: () => void | Promise<void>): void {
    try {
        void Promise.resolve(open()).catch((error: unknown) => controller.notifyError(error));
    } catch (error) {
        controller.notifyError(error);
    }
}

/**
 * Report a URL this app has no view for, leaving the start page as it is.
 *
 * @param controller - Reports the failure through `notifyError`.
 * @param path - The unmatched path.
 */
function reportUnknownLink(controller: SqlAdminController, path: string): void {
    controller.notifyError(new Error(`no view matches the link path "${path}"`));
}

/**
 * A relation ref in the session's database, from a route's path params.
 *
 * @param controller - Supplies the session's connectionId and database.
 * @param kind - The relation kind the route's first segment named.
 * @param schema - The route's `:schema` param.
 * @param name - The route's `:name` param.
 * @returns The ref, ready to pass to an `open*` method.
 */
function relationRef(controller: SqlAdminController, kind: RelationKind, schema: string, name: string): DbObjectRef {
    return { connectionId: controller.connectionId, database: controller.database, schema, name, kind };
}

/**
 * Build the app's Router with every route registered, ready to `start()`.
 * Does not start it — the caller starts it after mounting the shell.
 *
 * @param controller - The mediator every route dispatches onto.
 * @returns The router, unstarted.
 */
export function buildAppRouter(controller: SqlAdminController): Router {
    const router = new Router({
        mode: "history",
        listeners: {
            nomatch: path => reportUnknownLink(controller, path),
        },
    });

    // Registered so an ordinary visit to the site root is not reported as an
    // unknown link — the start page already shows while the Dock is empty.
    router.register("/", () => {});

    router.register("/notes", () => dispatch(controller, () => controller.openDocumentation()));

    router.register("/database/diagram", () => dispatch(controller, () => controller.openDatabaseDiagram({
        connectionId: controller.connectionId,
        database    : controller.database,
        kind        : "database",
    })));

    router.register("/schema/:schema/:view", (params, path) => dispatch(controller, () => {
        const view = schemaView(params.view);

        if (view === null) {
            reportUnknownLink(controller, path);

            return;
        }

        const ref: DbObjectRef = { connectionId: controller.connectionId, database: controller.database, schema: params.schema, kind: "schema" };

        switch (view) {
            case "diagram":      return controller.openSchemaDiagram(ref);
            case "dependencies": return controller.openSchemaDependencyGraph(ref);
            case "inheritance":  return controller.openSchemaInheritanceGraph(ref);
        }
    }));

    // The two relation patterns are registered once per RELATION_KINDS entry
    // rather than as six near-identical literal `register` calls.
    for (const { segment, kind } of RELATION_KINDS) {
        router.register(`/${segment}/:schema/:name`, (params, _path, _fragment, query) => dispatch(controller, () =>
            controller.openTable(relationRef(controller, kind, params.schema, params.name), undefined, {
                rotated: routeFlag(query.rotated),
                record:  query.record,
            })));

        router.register(`/${segment}/:schema/:name/:view`, (params, path, _fragment, query) => dispatch(controller, () => {
            const view = relationView(kind, params.view);

            if (view === null) {
                reportUnknownLink(controller, path);

                return;
            }

            const ref = relationRef(controller, kind, params.schema, params.name);

            switch (view) {
                case "structure":    return controller.openStructure(ref);
                case "definition":   return controller.openDefinition(ref);
                case "diagram":      return controller.openRelationDiagram(ref, undefined, query.depth);
                case "dependencies": return controller.openRelationDependencyGraph(ref, undefined, query.depth);
                case "inheritance":  return controller.openRelationInheritanceGraph(ref, undefined, query.depth);
            }
        }));
    }

    router.register("/sequence/:schema/:name", params => dispatch(controller, () => controller.openSequence({
        connectionId: controller.connectionId,
        database    : controller.database,
        schema      : params.schema,
        name        : params.name,
        kind        : "sequence",
    })));

    router.register("/index/:schema/:name", params => dispatch(controller, () => controller.openIndex({
        connectionId: controller.connectionId,
        database    : controller.database,
        schema      : params.schema,
        name        : params.name,
        kind        : "index",
    })));

    router.register("/function/:schema/:name", params => dispatch(controller, () => controller.openFunctionDefinition({
        connectionId: controller.connectionId,
        database    : controller.database,
        schema      : params.schema,
        name        : params.name,
        kind        : "function",
        signature   : "",
    })));

    router.register("/function/:schema/:name/:signature", params => dispatch(controller, () => controller.openFunctionDefinition({
        connectionId: controller.connectionId,
        database    : controller.database,
        schema      : params.schema,
        name        : params.name,
        kind        : "function",
        signature   : params.signature,
    })));

    router.register("/role/:role", params => dispatch(controller, () => { controller.showRole(params.role); }));

    router.register("/role/:role/:view", (params, path, _fragment, query) => dispatch(controller, () => {
        const view = roleView(params.view);

        if (view === null) {
            reportUnknownLink(controller, path);

            return;
        }

        switch (view) {
            case "grants-diagram": return controller.openRoleGrantsDiagram(params.role);
            case "membership":     return controller.openRoleMembershipDiagram(params.role, query.depth);
        }
    }));

    return router;
}
