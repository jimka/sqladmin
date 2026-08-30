// The app's small pure sizing/spacing constants shared across dock panels and
// dialogs — this module's counterpart to theme.ts, which owns the app's
// shared colours.

// The library's own auto-width cap (Table.clampColumnWidth clamps a derived
// width to at most this many px when a column declares no maxWidth of its
// own — see AUTO_WIDTH_CAP_PX in the library's Table.ts). Declaring this as a
// column's own `maxWidth` therefore changes nothing about that column's
// content sizing (it already gets clamped here by default); it only takes the
// column out of `absorbSlackIntoGreedy`'s leftover-width split, which skips
// any column that declares a `maxWidth`. So declaring it on every column but
// `filler` is what makes `filler` the one column that absorbs the grid's
// leftover width — see the plan's "A blank filler column absorbs leftover
// width" Architecture Decision.
export const CONTENT_WIDTH_CAP = 400;

// This app's usual dialog/panel content gap — the vertical spacing between a
// form and the control/editor below it.
export const CONTENT_SPACING = 8;
