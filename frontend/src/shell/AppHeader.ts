// The persistent brand block pinned to the leading edge of the menu bar: a
// database glyph, the app name, its version, and — when connected — the
// database name, with a hover tooltip carrying the fuller description. Built
// the way buildIdentityWidget (SqlAdminController.ts) builds the status bar's
// identity badge — an HBox of a Glyph and Text children plus a Tooltip — but
// as a class-first component (COMPONENT_CONVENTIONS.md (a)): new shell work is
// class-first, and Container (not Panel) keeps zero content insets so this
// block's own padding lines up exactly with the menu bar's own buttons beside
// it (see (a)'s Panel-vs-Container note).
//
// Every colour is a `var(--ts-ui-…, fallback)` token handed to
// setForegroundColor (the form ExplainNode.ts already uses), so the block
// tracks the library's own light/dark theme rather than pinning a fixed grey.

import { Component, Container } from "@jimka/typescript-ui/core";
import { Insets, UNBOUNDED } from "@jimka/typescript-ui/primitive";
import { HBox }             from "@jimka/typescript-ui/layout";
import { Text }             from "@jimka/typescript-ui/component/input";
import { Glyph }            from "@jimka/typescript-ui/component/display";
import { ToolBarSeparator } from "@jimka/typescript-ui/component/menubar";
import { Tooltip }          from "@jimka/typescript-ui/overlay";
import { database as databaseGlyph } from "@jimka/typescript-ui/glyphs/solid/database";
import { APP_NAME, APP_VERSION, APP_TAGLINE } from "../appIdentity";
import { appHeaderText } from "./appHeaderText";

// Registered here even though the shell's composition root also registers
// this glyph (SqlAdminShell.ts), mirroring how StartPage.ts registers its own
// glyph regardless — each component owns registering what it draws.
Glyph.register(databaseGlyph);

// Matches buildIdentityWidget's HBox spacing (SqlAdminController.ts), so the
// two "glyph + text" badges the app shows (status bar identity, menu-bar
// header) read as the same visual idiom.
const GAP = 6;

// The horizontal inset from the block's own edges, matching the padding the
// library's own menu-bar buttons use, so the header's leading/trailing edges
// line up with the "Query" menu button immediately to its right.
const PAD = 10;

// Caps the database label's width so a long database name can't push the
// trailing Shortcuts/About buttons off a narrow window; the label truncates
// with an ellipsis past this instead.
const DB_LABEL_MAX_WIDTH = 160;

/** The app-identity brand block at the leading edge of the shell's menu bar. */
export class AppHeader extends Container {
    /**
     * @param database - The connected database name, if any. Omitted (or
     *   blank) drops the separator and the database label — see appHeaderText.
     */
    constructor(database?: string) {
        const text = appHeaderText(APP_NAME, APP_VERSION, APP_TAGLINE, database);

        const glyph = new Glyph("database");

        const name = new Text(text.name, { fontWeight: "600" });
        name.setForegroundColor("var(--ts-ui-text-color, rgb(33, 33, 33))");

        const version = new Text(text.version);
        version.setForegroundColor("var(--ts-ui-menu-bar-item-shortcut-color, rgb(140, 140, 140))");

        const components: Component[] = [glyph, name, version];

        if (text.database !== null) {
            const dbLabel = new Text(text.database, { truncate: true });
            dbLabel.setForegroundColor("var(--ts-ui-menu-bar-item-shortcut-color, rgb(140, 140, 140))");
            dbLabel.setMaxSize({ width: DB_LABEL_MAX_WIDTH, height: UNBOUNDED });

            components.push(new ToolBarSeparator(), dbLabel);
        }

        super({
            layoutManager: new HBox({ spacing: GAP }),
            components,
            // `role="presentation"` keeps assistive tech from announcing this
            // block as a menu item merely because it's a child of the menu
            // bar's `role="menubar"` container. The library's typed
            // `Aria.setRole` doesn't accept "presentation" (its `AriaRole`
            // union covers only concrete widget roles), so this goes through
            // `attributes` — Component's documented raw-HTML-attribute escape
            // hatch for exactly this kind of gap (Component.ts's `attributes`
            // option doc). `getAria()` is never called on this instance, so
            // Aria's own `applyToElement` — which would otherwise run after
            // `attributes` during init and could contest the `role`
            // attribute — never runs here.
            attributes: { role: "presentation" },
        });

        this.setInsets(new Insets(0, PAD, 0, PAD));
        Tooltip.attach(this, text.tooltip);
    }
}
