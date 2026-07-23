// The persistent brand strip pinned above the menu bar: a database glyph, the
// app name, and its version, with a hover tooltip carrying the fuller
// description. Built the way buildIdentityWidget (SqlAdminController.ts) builds
// the status bar's identity badge — an HBox of a Glyph and Text children plus a
// Tooltip — but as a class-first component (COMPONENT_CONVENTIONS.md (a)): new
// shell work is class-first, and Container (not Panel) keeps zero content
// insets so this block owns its own padding (see (a)'s Panel-vs-Container note).
//
// It is its own row above the menu bar (SqlAdminShell.ts stacks the two in a
// VBox), so it sizes to its own content and does not contend with the menu
// bar's baseline-aligned buttons. The connected database is not shown here —
// the status bar's identity badge already pins it.
//
// Every colour is a `var(--ts-ui-…, fallback)` token handed to
// setForegroundColor (the form ExplainNode.ts already uses), so the block
// tracks the library's own light/dark theme rather than pinning a fixed grey.

import { Component, Container, callable } from "@jimka/typescript-ui/core";
import { Insets }              from "@jimka/typescript-ui/primitive";
import { HBox }                from "@jimka/typescript-ui/layout";
import { Text }                from "@jimka/typescript-ui/component/input";
import { Glyph }               from "@jimka/typescript-ui/component/display";
import { Tooltip }             from "@jimka/typescript-ui/overlay";
import { database as databaseGlyph } from "@jimka/typescript-ui/glyphs/solid/database";
import { APP_NAME, APP_VERSION, APP_TAGLINE } from "../appIdentity";
import { appHeaderText } from "./appHeaderText";

// Registered here even though the shell's composition root also registers
// this glyph (SqlAdminShell.ts), mirroring how StartPage.ts registers its own
// glyph regardless — each component owns registering what it draws.
Glyph.register(databaseGlyph);

// Matches buildIdentityWidget's HBox spacing (SqlAdminController.ts), so the
// two "glyph + text" badges the app shows (status bar identity, brand strip)
// read as the same visual idiom.
const GAP = 6;

// The horizontal inset from the strip's own edges, matching the padding the
// library's own menu-bar buttons use, so the brand text lines up with the
// "Query" menu button directly below it.
const PAD = 10;

// A little breathing room above and below so the strip reads as its own band
// rather than crowding the menu bar beneath it.
const V_PAD = 5;

// The version sits well below the 14px body default (`--ts-ui-font-size`) so it
// reads as quiet secondary text beside the app name. A literal px, not a token,
// because the library exposes no smaller font-size token to bind to. Applied
// via setFontSize() after construction, not the constructor `fontSize` option:
// a numeric fontSize passed at construction is clobbered back to the theme
// default by Text's field initializers (see LIBRARY_NOTES.md).
const VERSION_FONT_SIZE = 10;

/** The app-identity brand strip pinned above the shell's menu bar. */
class AppHeader extends Container {
    constructor() {
        const text = appHeaderText(APP_NAME, APP_VERSION, APP_TAGLINE);

        const glyph = new Glyph("database");

        const name = new Text(text.name, { fontWeight: "600" });
        name.setForegroundColor("var(--ts-ui-text-color, rgb(33, 33, 33))");

        const version = new Text(text.version);
        version.setFontSize(VERSION_FONT_SIZE);
        version.setForegroundColor("var(--ts-ui-menu-bar-item-shortcut-color, rgb(140, 140, 140))");

        const components: Component[] = [glyph, name, version];

        super({
            layoutManager: new HBox({ spacing: GAP }),
            components,
            // `role="presentation"` keeps assistive tech from announcing this
            // block as a menu item merely because it sits in the shell's top
            // chrome. The library's typed `Aria.setRole` doesn't accept
            // "presentation" (its `AriaRole` union covers only concrete widget
            // roles), so this goes through `attributes` — Component's documented
            // raw-HTML-attribute escape hatch for exactly this kind of gap
            // (Component.ts's `attributes` option doc). `getAria()` is never
            // called on this instance, so Aria's own `applyToElement` — which
            // would otherwise run after `attributes` during init and could
            // contest the `role` attribute — never runs here.
            attributes: { role: "presentation" },
        });

        this.setInsets(new Insets(V_PAD, PAD, V_PAD, PAD));
        Tooltip.attach(this, text.tooltip);
    }
}

// Callable-class export (COMPONENT_CONVENTIONS.md (d)): consumers construct
// `AppHeader()` without `new`, mirroring the library's own callable bases. The
// Proxy forwards construction via `Reflect.construct`, so `this.constructor.name`
// stays "AppHeader" and the CSS-class convention (e) is preserved.
const AppHeaderCallable = callable(AppHeader);
type AppHeaderCallable = AppHeader;
export { AppHeaderCallable as AppHeader };
