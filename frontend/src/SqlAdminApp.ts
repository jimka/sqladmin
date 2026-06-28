// SQLAdmin app bootstrap.
//
// Phase 0 target: hard-code one DbObjectRef (the seeded `customers` table),
// introspect its columns, build a Model + AjaxStore, and render the rows in a
// Table inside a Dock on the Body. The full shell (activity bar, navigator,
// status bar) and the SqlAdminController mediator land in Phase 1.

import { Body, DOM } from "@jimka/typescript-ui/core";
import { Fit } from "@jimka/typescript-ui/layout";
import { Dock } from "@jimka/typescript-ui/overlay";
import { Table } from "@jimka/typescript-ui/component/table";
import type { DbObjectRef } from "./contract";
import { getColumns } from "./data/api";
import { buildModel } from "./data/buildModel";
import { buildStore } from "./data/stores";

DOM.source.getScrollBarWidth();

const CUSTOMERS: DbObjectRef = {
    connectionId: "default",
    database: "sqladmin",
    schema: "public",
    name: "customers",
    kind: "table",
};

const body = Body.getInstance();
body.setLayoutManager(Fit());

const dock = Dock();
body.addComponent(dock);

/** Introspect a table, build its store, and open it as a Dock data grid. */
async function openTable(ref: DbObjectRef): Promise<void> {
    const columns = await getColumns(ref);
    const model = buildModel(columns);
    const store = buildStore(ref, model, columns);

    dock.addPanel({
        id: `${ref.schema}.${ref.name}`,
        title: ref.name ?? ref.connectionId,
        content: Table(store),
    });

    await store.load();
}

openTable(CUSTOMERS).catch(err => console.error("Failed to open table:", err));
