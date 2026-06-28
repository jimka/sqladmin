// SQLAdmin app bootstrap: build the controller (mediator) and the shell, then
// mount the shell on the Body. The Dock starts empty; tables are opened by
// selecting them in the navigator.

import { Body, DOM } from "@jimka/typescript-ui/core";
import { Fit } from "@jimka/typescript-ui/layout";
import { SqlAdminController } from "./SqlAdminController";
import { SqlAdminShell } from "./shell/SqlAdminShell";

DOM.source.getScrollBarWidth();

const controller = new SqlAdminController("default");
const shell = SqlAdminShell(controller);

const body = Body.getInstance();
body.setLayoutManager(Fit());
body.addComponent(shell);
