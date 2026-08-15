// Builds the app's Router: one route per view this app can deep-link to,
// each mapped onto the controller's existing `open*` methods (see
// SqlAdminController.ts). Consume-only — nothing here ever calls
// router.navigate or getHref; the URL is read once at boot (SqlAdminApp.ts's
// router.start()) and never written. Object identity (schema/name/role) comes
// from the path; view-mode properties (depth, rotated, record) come from the
// query string — see the plan's "Object identity lives in path segments;
// view-mode properties live in the query string" Architecture Decision.
//
// Every object-bearing route also reveals its object in the sidebar: one
// `controller.selectObject(ref)` / `controller.selectRole(name)` statement per
// handler, immediately before its `open*` call and after any view-segment
// check, so an unknown view segment reveals nothing. That pairing is
// caller-side by design — the reveal is not baked into the `open*` methods,
// exactly as `openReferencedTable` pairs `openTable` with a reveal of its own.
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
import { RELATION_KINDS, ROLE_BUCKETS, relationView, schemaView, roleView, routeFlag } from "./routeTargets";
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
 * @param kind - The relation kind the route's object-kind segment named.
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

    router.register("/database/diagram", () => dispatch(controller, () => {
        const ref: DbObjectRef = {
            connectionId: controller.connectionId,
            database    : controller.database,
            kind        : "database",
        };

        controller.selectObject(ref);

        return controller.openDatabaseDiagram(ref);
    }));

    router.register("/schema/:schema/:view", (params, path) => dispatch(controller, () => {
        const view = schemaView(params.view);

        if (view === null) {
            reportUnknownLink(controller, path);

            return;
        }

        const ref: DbObjectRef = { connectionId: controller.connectionId, database: controller.database, schema: params.schema, kind: "schema" };

        controller.selectObject(ref);

        switch (view) {
            case "diagram":      return controller.openSchemaDiagram(ref);
            case "dependencies": return controller.openSchemaDependencyGraph(ref);
            case "inheritance":  return controller.openSchemaInheritanceGraph(ref);
        }
    }));

    // The two relation patterns are registered once per RELATION_KINDS entry
    // rather than as six near-identical literal `register` calls, nested
    // under /schema/:schema/ so a relation's route mirrors the navigator's
    // own schema-then-object containment.
    for (const { segment, kind } of RELATION_KINDS) {
        router.register(`/schema/:schema/${segment}/:name`, (params, _path, _fragment, query) => dispatch(controller, () => {
            const ref = relationRef(controller, kind, params.schema, params.name);

            controller.selectObject(ref);

            return controller.openTable(ref, undefined, {
                rotated: routeFlag(query.rotated),
                record:  query.record,
            });
        }));

        router.register(`/schema/:schema/${segment}/:name/:view`, (params, path, _fragment, query) => dispatch(controller, () => {
            const view = relationView(kind, params.view);

            if (view === null) {
                reportUnknownLink(controller, path);

                return;
            }

            const ref = relationRef(controller, kind, params.schema, params.name);

            controller.selectObject(ref);

            switch (view) {
                case "structure":    return controller.openStructure(ref);
                case "definition":   return controller.openDefinition(ref);
                case "diagram":      return controller.openRelationDiagram(ref, undefined, query.depth);
                case "dependencies": return controller.openRelationDependencyGraph(ref, undefined, query.depth);
                case "inheritance":  return controller.openRelationInheritanceGraph(ref, undefined, query.depth);
            }
        }));
    }

    router.register("/schema/:schema/sequence/:name", params => dispatch(controller, () => {
        const ref: DbObjectRef = {
            connectionId: controller.connectionId,
            database    : controller.database,
            schema      : params.schema,
            name        : params.name,
            kind        : "sequence",
        };

        controller.selectObject(ref);

        return controller.openSequence(ref);
    }));

    router.register("/schema/:schema/index/:name", params => dispatch(controller, () => {
        const ref: DbObjectRef = {
            connectionId: controller.connectionId,
            database    : controller.database,
            schema      : params.schema,
            name        : params.name,
            kind        : "index",
        };

        controller.selectObject(ref);

        return controller.openIndex(ref);
    }));

    // A single registration: the overload-disambiguating signature is a query
    // parameter, not a second path pattern — see the plan's "Object identity
    // lives in path segments; view-mode properties live in the query string"
    // Architecture Decision.
    router.register("/schema/:schema/function/:name", (params, _path, _fragment, query) => dispatch(controller, () => {
        const ref: DbObjectRef = {
            connectionId: controller.connectionId,
            database    : controller.database,
            schema      : params.schema,
            name        : params.name,
            kind        : "function",
            signature   : query.signature ?? "",
        };

        // The reveal matches on name and kind, not signature, so an overloaded
        // routine selects its first leaf while the tab opens the exact overload.
        controller.selectObject(ref);

        return controller.openFunctionDefinition(ref);
    }));

    // The three role buckets are registered once per ROLE_BUCKETS entry, the
    // same technique RELATION_KINDS uses — mirroring RolesTree's own
    // Users/Groups/Predefined navigator sections. The bucket segment is
    // never validated against the role's actual classification here; any of
    // the three opens the same role by name (see the plan's Architecture
    // Decisions).
    for (const bucket of ROLE_BUCKETS) {
        router.register(`/role/${bucket}/:role`, params => dispatch(controller, () => {
            controller.selectRole(params.role);
            controller.showRole(params.role);
        }));

        router.register(`/role/${bucket}/:role/:view`, (params, path, _fragment, query) => dispatch(controller, () => {
            const view = roleView(params.view);

            if (view === null) {
                reportUnknownLink(controller, path);

                return;
            }

            controller.selectRole(params.role);

            switch (view) {
                case "grants-diagram": return controller.openRoleGrantsDiagram(params.role);
                case "membership":     return controller.openRoleMembershipDiagram(params.role, query.depth);
            }
        }));
    }

    return router;
}
