// SQLAdmin app bootstrap: gate on authentication (recover an existing session or
// show the login dialog), then build the controller (mediator) and the shell and
// mount it on the Body. The connection id comes from the authenticated session,
// not a hardcoded default. The Dock starts empty; tables are opened by selecting
// them in the navigator.

import { Body }               from "@jimka/typescript-ui/core";
import { Fit }                from "@jimka/typescript-ui/layout";
import { SqlAdminController } from "./SqlAdminController";
import { SqlAdminShell }      from "./shell/SqlAdminShell";
import { whoami, setCsrfToken } from "./data/api";
import { showLoginDialog }    from "./shell/loginDialog";

// An async IIFE (not top-level await) so the boot gate works regardless of the
// bundler's module target.
void (async function main(): Promise<void> {
    const session = (await whoami()) ?? (await showLoginDialog());

    setCsrfToken(session.csrfToken);

    const controller = new SqlAdminController(session.connectionId);

    Body.init({
        layoutManager: Fit(),
        components:    [SqlAdminShell(controller)],
    });
})();
