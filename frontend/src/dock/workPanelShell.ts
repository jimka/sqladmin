// The common dock work-panel frame: a Border layout with the toolbar pinned
// NORTH, the main surface filling CENTER, and an optional SOUTH strip (e.g. a
// pagination bar). The table, view, and role-grants panels share this shape.

import { Container } from "@jimka/typescript-ui/core";
import type { Component } from "@jimka/typescript-ui/core";
import { Border as BorderLayout } from "@jimka/typescript-ui/layout";
import { Placement } from "@jimka/typescript-ui/primitive";

/**
 * Assemble a work panel: `toolbar` pinned NORTH, `center` filling the rest, and
 * `south` (when given) pinned SOUTH.
 *
 * @param toolbar - The panel's toolbar, pinned to the top.
 * @param center - The main surface (the data grid), filling the remaining space.
 * @param south - Optional bottom strip, e.g. a PaginationBar.
 *
 * @returns The assembled panel container.
 */
export function workPanelShell(toolbar: Component, center: Component, south?: Component): Container {
    const panel = Container({ layoutManager: new BorderLayout({ spacing: 0 }) });
    panel.addComponent(toolbar, { placement: Placement.NORTH });
    panel.addComponent(center, { placement: Placement.CENTER });

    if (south) {
        panel.addComponent(south, { placement: Placement.SOUTH });
    }

    return panel;
}
