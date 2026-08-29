// The dismissible in-content error row: a warning glyph, wrapping message
// text, and a dismiss button, shown at the bottom of a host component while
// an error is live. One owner for the row, so the query panel and the two DDL
// dialogs cannot drift apart the way the row's three hand-copied versions did.
// The banner attaches itself to `host` on `show()` and detaches on `hide()`;
// `onChange` is where the host relayouts (e.g. `dialog.resizeToContent()`).

import { Container, callable }    from "@jimka/typescript-ui/core";
import type { Component }         from "@jimka/typescript-ui/core";
import { HBox }                   from "@jimka/typescript-ui/layout";
import type { LayoutConstraints } from "@jimka/typescript-ui/layout";
import { Text }                   from "@jimka/typescript-ui/component/input";
import { Glyph }                  from "@jimka/typescript-ui/component/display";
import { circle_exclamation }     from "@jimka/typescript-ui/glyphs/solid/circle_exclamation";
import { xmark }                  from "@jimka/typescript-ui/glyphs/solid/xmark";
import { glyphButton }            from "./glyphButton";
import { DESTRUCTIVE_COLOR, NEUTRAL_COLOR } from "../theme";

Glyph.register(circle_exclamation, xmark);

// The library's own error-notification wash (Notification/Dialog use the same
// token — see typescript-ui's Theme.ts) rather than a hand-rolled tint off
// DESTRUCTIVE_COLOR: it already tracks the active theme (including dark
// mode), which a literal rgba() derived from this app's own palette would
// not. The fallback is ModernTheme's light-mode value, for a render that
// somehow predates the theme CSS variables being set.
const ERROR_BANNER_BG = "var(--ts-ui-notification-error-bg, rgba(244, 214, 214, 0.75))";

// Gap between the glyph, message, and dismiss button — the same order of
// magnitude as this app's other in-dialog content spacing.
const BANNER_SPACING = 8;

/** Construction inputs for {@link ErrorBanner}. */
export interface ErrorBannerOptions {
    /** The component the banner attaches to while shown. */
    host: Component;
    /** Constraints passed to `host.addComponent`. Omit for a plain append. */
    constraints?: LayoutConstraints;
    /** Run after every `show()` (attach or message update) and `hide()`, so the host can relayout. */
    onChange?: () => void;
}

/**
 * The dismissible in-content error row: a warning glyph, wrapping message
 * text, and a dismiss button. Attaches itself to `host` on `show()` and
 * detaches on `hide()`.
 */
class ErrorBanner extends Container {
    private readonly _message    : Text;
    private readonly _host       : Component;
    private readonly _constraints: LayoutConstraints | undefined;
    private readonly _onChange   : (() => void) | undefined;
    private _shown = false;

    /**
     * @param options - the host to attach to, the constraints to attach
     *   with, and the callback to run after every attach/detach/message update.
     */
    constructor(options: ErrorBannerOptions) {
        const icon    = new Glyph("circle-exclamation", { foregroundColor: DESTRUCTIVE_COLOR });
        const message = new Text("", { whiteSpace: "normal", truncate: false });

        super({ layoutManager: new HBox({ spacing: BANNER_SPACING, itemAlign: "stretch" }) });

        this._message     = message;
        this._host        = options.host;
        this._constraints = options.constraints;
        this._onChange    = options.onChange;

        this.addComponent(icon);
        this.addComponent(message, { weight: 1 });
        this.addComponent(glyphButton("xmark", NEUTRAL_COLOR, "Dismiss", () => this.hide()));
        this.setBackgroundColor(ERROR_BANNER_BG);
    }

    /** Whether the banner is currently attached to its host. */
    isShown(): boolean {
        return this._shown;
    }

    /**
     * Set the message from `error` and attach to the host if not already
     * shown. `onChange` fires on every call, not just the attach — two of
     * this class's three original call sites resized their dialog on every
     * message update (including a repeat failure while already shown), and
     * an unconditional relayout is a harmless superset for the third.
     */
    show = (error: unknown): void => {
        this._message.setText(error instanceof Error ? error.message : String(error));

        if (!this._shown) {
            this._host.addComponent(this, this._constraints);
            this._shown = true;
        }

        this._onChange?.();
    };

    /** Detach from the host. A no-op when not shown. */
    hide = (): void => {
        if (this._shown) {
            this._host.removeComponent(this);
            this._shown = false;
            this._onChange?.();
        }
    };
}

// Callable-class export: consumers may write `ErrorBanner(options)`, no `new`.
const ErrorBannerCallable = callable(ErrorBanner);
type  ErrorBannerCallable = ErrorBanner;
export { ErrorBannerCallable as ErrorBanner };
