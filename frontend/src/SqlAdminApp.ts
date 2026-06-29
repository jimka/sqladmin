// SQLAdmin app bootstrap: build the controller (mediator) and the shell, then
// mount the shell on the Body. The Dock starts empty; tables are opened by
// selecting them in the navigator.

import { Body }               from "@jimka/typescript-ui/core";
import { Fit }                from "@jimka/typescript-ui/layout";
import { SqlAdminController } from "./SqlAdminController";
import { SqlAdminShell }      from "./shell/SqlAdminShell";

const controller = new SqlAdminController("default");

Body.init({
    layoutManager: Fit(),
    components:    [SqlAdminShell(controller)],
});
