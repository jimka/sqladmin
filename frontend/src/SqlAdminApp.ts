// SQLAdmin app bootstrap: build the controller (mediator) and the shell, mount
// the shell on the Body, and open the seeded customers table in the Dock.
// Phase 1 in progress — the WEST navigator and the rest of the shell follow.

import { Body, DOM } from "@jimka/typescript-ui/core";
import { Fit } from "@jimka/typescript-ui/layout";
import type { DbObjectRef } from "./contract";
import { SqlAdminController } from "./SqlAdminController";
import { SqlAdminShell } from "./shell/SqlAdminShell";

DOM.source.getScrollBarWidth();

const CUSTOMERS: DbObjectRef = {
    connectionId: "default",
    database: "sqladmin",
    schema: "public",
    name: "customers",
    kind: "table",
};

const controller = new SqlAdminController("default");
const shell = SqlAdminShell(controller);

const body = Body.getInstance();
body.setLayoutManager(Fit());
body.addComponent(shell);

controller.openTable(CUSTOMERS).catch(err => console.error("Failed to open table:", err));
