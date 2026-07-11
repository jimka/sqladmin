// SQLAdmin app bootstrap: bring up the UI runtime, gate on authentication
// (recover an existing session or show the login dialog), then build the
// controller (mediator) and mount the shell. The connection id comes from the
// authenticated session, not a hardcoded default. The Dock starts empty; tables
// are opened by selecting them in the navigator.

import { Body }               from "@jimka/typescript-ui/core";
import { Fit }                from "@jimka/typescript-ui/layout";
import { SqlAdminController } from "./SqlAdminController";
import { SqlAdminShell }      from "./shell/SqlAdminShell";
import { whoami, setCsrfToken } from "./data/api";
import { showLoginDialog }    from "./shell/loginDialog";

// An async IIFE (not top-level await) so the boot gate works regardless of the
// bundler's module target. A boot failure (e.g. whoami rejecting for a network
// reason, not a 401) is surfaced rather than swallowed silently.
(async function main(): Promise<void> {
    // Initialise the Body FIRST (empty) so the UI runtime — theme, layout, and
    // the overlay/layer manager a Dialog mounts into — is up before the login
    // dialog is shown. Without this the dialog is created but never renders.
    Body.init({ layoutManager: Fit() });

    const session = (await whoami()) ?? (await showLoginDialog());

    setCsrfToken(session.csrfToken);

    const controller = new SqlAdminController(session.connectionId);

    // Now that we are authenticated, mount the shell into the already-initialised
    // Body.
    Body.getInstance().addComponent(SqlAdminShell(controller));
})().catch((err) => {
    console.error("SQLAdmin failed to start:", err);
});
