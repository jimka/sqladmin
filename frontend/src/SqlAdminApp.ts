// SQLAdmin app bootstrap: bring up the UI runtime, gate on authentication
// (recover an existing session or show the login dialog), then build the
// controller (mediator), mount the shell, and start the Router so a deep
// link (e.g. /table/sales/customers?record=42) opens its view on load. The
// connection id comes from the authenticated session, not a hardcoded
// default. Absent a deep link, the Dock starts empty; tables are opened by
// selecting them in the navigator.

import { Body }                 from "@jimka/typescript-ui/core";
import { Fit }                  from "@jimka/typescript-ui/layout";
import { SqlAdminController }   from "./SqlAdminController";
import { SqlAdminShell }        from "./shell/SqlAdminShell";
import { buildAppRouter }       from "./shell/appRouter";
import { whoami, setCsrfToken } from "./data/api";
import { showLoginDialog }      from "./shell/LoginDialog";
import { APP_FAVICON }          from "./appIdentity";

// An async IIFE (not top-level await) so the boot gate works regardless of the
// bundler's module target. A boot failure (e.g. whoami rejecting for a network
// reason, not a 401) is surfaced rather than swallowed silently.
(async function main(): Promise<void> {
    // Initialise the Body FIRST (empty) so the UI runtime — theme, layout, and
    // the overlay/layer manager a Dialog mounts into — is up before the login
    // dialog is shown. Without this the dialog is created but never renders.
    Body.init({ layoutManager: Fit(), favicon: APP_FAVICON });

    const session = (await whoami()) ?? (await showLoginDialog());

    setCsrfToken(session.csrfToken);

    const controller = new SqlAdminController(session.connectionId, session.username, session.database);
    const router     = buildAppRouter(controller);

    // Now that we are authenticated, mount the shell into the already-initialised
    // Body.
    Body.getInstance().addComponent(SqlAdminShell(controller));

    // start() applies the current route synchronously — call after the tree is
    // built and before the first layout frame, so a routed tab is already
    // opening when that pass runs (no flash of the start page). Mirrors the
    // docs app's own router.start() placement (packages/docs/src/main.ts in
    // the typescript-ui repo). Placed after the shell (not before) so a
    // handler that touches the navigator finds SqlAdminShell's NavigatorTree
    // already registered via controller.setNavigator; placed after the login
    // gate above (session is already resolved) so a deep link survives a
    // sign-in round-trip untouched — showLoginDialog() never navigates.
    router.start();
})().catch((err) => {
    console.error("SQLAdmin failed to start:", err);
});
