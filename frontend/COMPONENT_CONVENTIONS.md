# Component conventions: class-first

The frontend is migrating from **builder-first** UI modules — capitalized
factory functions (`ActivityBar()`, `TableWorkPanel()`, …) that `new` up
library primitives and return a bare `Container`/`Component` or a hand-rolled
handle object — to **class-first** components: a class that `extends` a
library base type directly.

This isn't a whole-layer rewrite. Convert a module to class-first when you're
already touching it for another reason; there's no standing project to
migrate the rest in one pass. `ActivityBar` ([`src/shell/ActivityBar.ts`](src/shell/ActivityBar.ts))
and `TableWorkPanel` ([`src/dock/TableWorkPanel.ts`](src/dock/TableWorkPanel.ts))
are the worked examples; `LoginForm` ([`src/shell/LoginForm.ts`](src/shell/LoginForm.ts))
is the original in-repo precedent.

## Why factories at all, historically

Some builders (`SqlAdminShell` among them) were written as factories because
of a real library bug: the shipped `.d.ts` kept unresolved `~/*` path aliases
that collapsed every library base class to `any` for external consumers, so a
subclass inherited no members. That's fixed — see `LIBRARY_NOTES.md`,
"External consumers couldn't subclass a library class". A factory you find
today is a not-yet-migrated holdover, not evidence of a current constraint.

## (a) `extends` the callable library base

Import the callable export (`Container`, `Panel`, `Form`, …) from the
library's public entry points and `extends` it directly — the same class you'd
otherwise call as a factory:

```ts
import { Container } from "@jimka/typescript-ui/core";

export class ActivityBar extends Container {
    constructor(views: ActivityView[]) {
        super({ layoutManager: new BorderLayout({ spacing: 0 }) });
        // ...
    }
}
```

Don't reach for the underscore-prefixed raw alias (`_Container`, `_Panel`,
…) — the library itself never imports those; the callable extends fine and
is the public, documented surface.

Pick the base that matches what the builder actually assembles. `Panel`
defaults to a 4px content inset (see `Panel.ts`'s `_defaultPanelOptions`);
if the current builder relies on zero insets (as `ActivityBar` does, to keep
its collapsed rail width exact), extend `Container` instead — extending
`Panel` would silently reintroduce the inset.

## (b) The super-cascade trap

`this` is unavailable until `super()` returns, and the library's option
cascade runs setters **during** `super()`. So:

1. Build child widgets and anything `super()` needs as **locals**, before the
   `super()` call.
2. Call `super({ layoutManager, components, ... })`.
3. Assign instance fields, `addComponent(...)` calls, and event-listener
   wiring **after** `super()` returns.

```ts
constructor(views: ActivityView[]) {
    const rail = new ToolBar({ orientation: "vertical" });   // local — pre-super()
    super({ layoutManager: new BorderLayout({ spacing: 0 }) });
    this.rail = rail;                                        // field assignment — post-super()
    this.addComponent(this.rail, { placement: Placement.WEST });
}
```

If a field is also touched by the option cascade itself (a cascaded setter
writes to it during `super()`), declare it with `declare` rather than a `=`
initializer — a `= initializer` runs *after* `super()` and would clobber the
cascaded value. Neither `ActivityBar` nor `TableWorkPanel` passes
cascade-touched options, so plain field assignment is enough there; reach for
`declare` only when a base option's setter genuinely writes the same field.
`LoginForm.ts` is the template for locals → `super({ components })` → field
assignment.

## (c) Event handlers become arrow-function fields

A handler registered **by reference** — `store.on("datachange",
this.syncSaveEnabled)`, `onToggleSidebar: sidebar.toggleCollapsed` — loses
its `this` if it's a plain method, because the reference is detached from
the instance the moment it's read off `this`. Any closure-over-mutable-state
that is *passed as a callback* must be a **private (or public, if the caller
needs it) arrow-function field**, which captures `this` permanently:

```ts
// Registered by reference on `store` — must be an arrow field.
private syncSaveEnabled = (): void => {
    this.saveButton.setEnabled(this.canWrite && this.store.hasPendingChanges());
};
```

This mirrors the library's own `Form.handleSubmit`. A helper that is *only*
ever invoked as `this.foo()` — never handed off by reference — may stay a
plain method. When in doubt, prefer the arrow field: it's safe under both
call styles, a plain method is only safe under one.

Stateless helpers that don't touch instance state at all (don't need to be
methods) can stay ordinary module-level functions — see `save_` and
`confirmDelete` in `TableWorkPanel.ts`, which take everything they need as
parameters and are called from an inline arrow wrapper (`() =>
save_(store, columns, notify)`), never registered by reference themselves.

## (d) The instance *is* the component

A class-first component doesn't return a `{ component, ...api }` handle —
the instance itself is the mountable component (since it `extends`
`Container`/`Panel`/…), and its public methods/fields **are** the API.

Export the class through the library's `callable()` wrapper so call sites
construct it **without `new`**, matching how the library's own bases
(`Container`, `Panel`, …) are invoked. Keep the `class` declaration unexported
and re-export the wrapped value under the class name:

```ts
import { Container, callable } from "@jimka/typescript-ui/core";

class ActivityBar extends Container {
    // ...
}

// Callable-class export: consumers write `ActivityBar(views)`, no `new`.
const ActivityBarCallable = callable(ActivityBar);
type ActivityBarCallable = ActivityBar;   // so `ActivityBar` still names the type
export { ActivityBarCallable as ActivityBar };
```

Call sites then read like the library's own factories:

```ts
const sidebar = ActivityBar(views);   // no `new`
body.addComponent(sidebar);           // the instance IS the component
sidebar.toggleCollapsed();            // its methods ARE the API
```

`new ActivityBar(views)` still works and `instanceof` still holds — `callable()`
is a Proxy that forwards both call and construct — but the no-`new` form is the
house style. `this.constructor.name` stays the class's own name (the Proxy
constructs via `Reflect.construct`), so convention (e) is unaffected. Delete the
handle interface (`ActivityBarHandle` and friends) once nothing references it —
its members move directly onto the class as public fields/methods.

Migration is incremental: `AppHeader` and `ActivityBar` are the converted
examples; components still exported as a bare `export class` (and constructed
with `new`) are not-yet-migrated holdovers, not a second sanctioned style.

## (e) `constructor.name` becomes the CSS class name

The library derives a component's CSS class from `this.constructor.name`. A
factory-built `ActivityBar()` result reported the generic `"Container"`; the
class-first `ActivityBar` reports `"ActivityBar"` — more specific and
self-documenting, and safe under minification because `vite.config.ts` sets
`esbuild.keepNames: true`. Before converting a builder, grep for any app CSS
targeting the old generic class name (e.g. `.Container`) under the subtree
being converted, since the class name changing would break that selector; none
of the pilot conversions had one.

## (f) The composition fallback

Not every builder can become an `extends` class cheaply. When a builder's
body is too large or closure-dense to hoist mechanically into an `extends`
class under the super-cascade constraint (b) — dozens of interdependent
inner functions and mutable locals that would each need to become a method
and a field — converting it is a wholesale, high-risk rewrite disproportionate
to a dispose-shape cleanup. `QueryPanel` (`src/dock/QueryPanel.ts`, ~700
lines, ~25 interdependent closures) is the worked example.

There, class-first still applies, but as a **composition wrapper**: a plain
class that owns a `content` (`Container`/`Component`) field and a `dispose`
field, instead of `extends`-ing a library base. The factory's body moves into
the constructor **verbatim**, ending in two field assignments instead of a
`return { content, dispose }`:

```ts
export class QueryPanel {
    readonly content: Container;
    readonly dispose: () => void;

    constructor(options: QueryPanelOptions) {
        // ...the original factory body, unchanged...
        this.content = panel;
        this.dispose = () => { /* ...original dispose closure... */ };
    }
}
```

The consumer constructs with `new` and mounts `instance.content`, calling
`instance.dispose()` on teardown — the same call-site shape as `extends`
classes get from section (d), just without `this` referring to the mountable
component itself.

`dispose` must still be a `readonly` **arrow-function field**, not a method,
for the same by-reference reason as section (c): a consumer that stores
`panel.dispose` (e.g. in a disposer map, or in a slot object handed off
elsewhere) needs it bound at read time. The composition wrapper's closures
otherwise stay ordinary local functions/`let`s inside the constructor — they
are not hoisted to fields or methods, since composition only needs `content`
and `dispose` as public surface.

This is a **fallback from the preferred `extends` form (section (d))**, not
an equal alternative — reach for `extends` first, and use composition only
when the super-cascade hoist genuinely doesn't pay for itself. Within one
module family sharing a single disposal path (e.g. several Dock panel
builders feeding one `_panelDisposers` map), prefer applying composition
uniformly across the family rather than mixing `extends` and composition,
even where a smaller sibling could technically take `extends` — a mixed
shape fragments the pattern for no benefit. See
`plans/implemented/class-first-lifecycle-panels.md` for the worked
conversion of `QueryPanel`, `QueryResultChart`, `QueryResultGrid`,
`DefinitionPanel`, and `DocumentationPanel`.
