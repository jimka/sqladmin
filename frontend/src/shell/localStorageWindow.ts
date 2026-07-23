// The localStorage inspector: a floating, resizable Window (reached from the
// Tools menu) that lists every key currently in the browser's localStorage
// beside its value, and offers a one-click "Clear SQLAdmin data" that removes
// the app's own keys. A non-modal Window (not a Dialog) so it can stay open
// beside the app while you inspect or clear stored state.
//
// Layout is key/value, split horizontally by a draggable gutter:
//   - left  — a Tree of keys, with the `sqladmin.` prefix trimmed and the
//             remaining key split on `.` into a path (so `sqladmin.query.history`
//             nests as query › history); unrelated origin keys are split the
//             same way. Only leaf nodes that map to an actual key carry a value;
//             intermediate segments are pure grouping. The left pane is pinned
//             (weight 0), so resizing the window only grows the value editor.
//   - right — a read-only CodeEditor showing the selected key's value. The
//             value is color-coded and pretty-printed as JSON when it parses
//             (which every `sqladmin.*` value does), else shown as raw text
//             with highlighting off.
//
// Self-contained on window.localStorage: the app's persisted state is exactly
// the `sqladmin.*` keys — query history + saved queries (data/queryStore.ts),
// notes (data/notesStore.ts), and Split/Accordion layout geometry
// (data/layoutStore.ts). History, saved queries, and notes are read fresh on
// each access, so removing them here needs no cache invalidation; the Queries
// rail, if open, only reflects a clear on its next refresh. Layout is
// different: a live Split/Accordion keeps its on-screen geometry after a
// clear (nothing here reaches into the mounted components), so the reset
// only takes effect on the next reload — and a subsequent drag re-creates the
// key it just cleared.

import { Window }               from "@jimka/typescript-ui/overlay";
import { Component, Panel }     from "@jimka/typescript-ui/core";
import { Border, HBox, Split }  from "@jimka/typescript-ui/layout";
import { Tree }                 from "@jimka/typescript-ui/component/tree";
import type { TreeNode }        from "@jimka/typescript-ui/component/tree";
import { CodeEditor }           from "@jimka/typescript-ui/component/editor";
import { Button }               from "@jimka/typescript-ui/component/button";
import { Spacer }               from "@jimka/typescript-ui/component/container";
import { Insets, Placement }    from "@jimka/typescript-ui/primitive";
import { APP_NAME }             from "../appIdentity";

// The prefix the app namespaces its persisted keys under (data/queryStore.ts,
// data/notesStore.ts, data/layoutStore.ts). "Clear SQLAdmin data" removes
// exactly these, leaving any unrelated origin keys the inspector also lists
// untouched. The prefix is also trimmed from the key list's row labels.
const APP_KEY_PREFIX = "sqladmin.";

// Initial window geometry; the window is freely movable and resizable after.
// Wider than a single-column dump to seat the key tree beside the value editor.
const WIN_X = 120;
const WIN_Y = 120;
const WIN_W = 760;
const WIN_H = 480;

// The value editor's fill weight: the only positive weight, so it absorbs every
// window-resize delta while the weight-0 tree stays put at its own preferred
// (content-derived) width. The gutter still drags the divide either way.
const VALUE_WEIGHT = 1;

// Spacing and padding for the button row.
const BUTTON_SPACING = 8;
const PAD            = 12;

/** A key/value entry: the full storage key plus its prefix-trimmed path. */
interface Entry {
    /** The full localStorage key — read/removed by exactly this string. */
    key: string;
    /** The tree path: `key` with any `sqladmin.` prefix trimmed, split on `.`. */
    label: string;
}

/** Every key currently in localStorage as a display Entry, sorted by label. */
function allEntries(): Entry[] {
    const entries: Entry[] = [];

    for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);

        if (key !== null) {
            const label = key.startsWith(APP_KEY_PREFIX) ? key.slice(APP_KEY_PREFIX.length) : key;

            entries.push({ key, label });
        }
    }

    entries.sort((a, b) => a.label.localeCompare(b.label));

    return entries;
}

/** A node while building the key trie: a path segment and its children. */
interface TrieNode {
    /** The full storage key when a key ends exactly here; undefined for a pure grouping segment. */
    key?: string;
    /** Child segments, keyed by their next path part. */
    children: Map<string, TrieNode>;
}

/**
 * Group every key into a tree, splitting each (prefix-trimmed) key on `.`. A
 * node carries `data` = the full storage key only when a key ends exactly at
 * that path; intermediate segments are pure grouping (no `data`), so selecting
 * one shows no value.
 *
 * @param entries - the keys to arrange, each with its prefix-trimmed path.
 *
 * @returns the tree's root nodes, alphabetically sorted at every level.
 */
function buildTreeNodes(entries: Entry[]): TreeNode[] {
    const roots = new Map<string, TrieNode>();

    for (const entry of entries) {
        let level = roots;
        let node: TrieNode | undefined;

        for (const segment of entry.label.split(".")) {
            node = level.get(segment);

            if (node === undefined) {
                node = { children: new Map() };
                level.set(segment, node);
            }

            level = node.children;
        }

        // The last segment's node is where this key's value lives.
        if (node !== undefined) {
            node.key = entry.key;
        }
    }

    return toTreeNodes(roots);
}

/**
 * Convert one trie level into sorted {@link TreeNode}s, recursing into children.
 *
 * @param level - the sibling segments at this depth.
 *
 * @returns the level's nodes, sorted by label.
 */
function toTreeNodes(level: Map<string, TrieNode>): TreeNode[] {
    return [...level.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, node]) => ({
            label,
            // A value node carries its full storage key; a grouping node carries none.
            data:     node.key,
            children: node.children.size > 0 ? toTreeNodes(node.children) : undefined,
        }));
}

/** Remove the app's own (`sqladmin.*`) keys, leaving any other origin keys intact. */
function clearAppKeys(): void {
    // Snapshot the keys first: removing while iterating window.localStorage by
    // live index would skip entries as the collection shifts under us.
    const keys = allEntries().map(entry => entry.key);

    for (const key of keys) {
        if (key.startsWith(APP_KEY_PREFIX)) {
            window.localStorage.removeItem(key);
        }
    }
}

/**
 * Load a key's value into the editor: pretty-printed and JSON-highlighted when
 * it parses (every `sqladmin.*` value does), else the raw string with
 * highlighting off. Passing `undefined` (a grouping node, or nothing selected)
 * blanks the editor.
 *
 * @param editor - the value editor to load into.
 * @param key - the selected node's full storage key, or undefined for none.
 */
function showValue(editor: CodeEditor, key: string | undefined): void {
    if (key === undefined) {
        editor.setLanguage(null);
        editor.setValue("");

        return;
    }

    const raw = window.localStorage.getItem(key) ?? "";

    try {
        const pretty = JSON.stringify(JSON.parse(raw), null, 2);

        editor.setLanguage("json");
        editor.setValue(pretty);
    } catch {
        editor.setLanguage(null);
        editor.setValue(raw);
    }
}

/**
 * Open the localStorage inspector window. Fire-and-forget: the window owns its
 * own lifecycle (title-bar close, or the in-content Close button).
 */
export function openLocalStorageWindow(): void {
    const win = new Window("Local Storage");

    win.setX(WIN_X);
    win.setY(WIN_Y);
    win.setWidth(WIN_W);
    win.setHeight(WIN_H);

    win.setContentFactory(() => buildContent(win));
    win.show();
}

/**
 * Build the window content: a key Tree beside a color-coded value editor, split
 * horizontally, above a trailing button row (Clear · Close). Selecting a leaf
 * loads its value; Clear re-reads the emptied storage in place without reopening
 * the window.
 */
function buildContent(win: Window): Component {
    // Weight 0 in the Split below pins the tree at its own preferred
    // (content-derived) width, so a window resize only grows the value editor.
    const tree = new Tree();

    // Read-only: the inspector views and clears state, it does not edit it. The
    // value is color-coded (language set per selection) and pretty-printed.
    const editor = new CodeEditor("", { language: "json", readOnly: true });

    // A node's data is its full storage key (leaf) or undefined (grouping node),
    // which showValue maps straight to a value or a blank pane.
    tree.on("selection", (nodes: TreeNode[]) => {
        const key = nodes[0]?.data;

        showValue(editor, typeof key === "string" ? key : undefined);
    });

    /** Re-read storage into the tree, seeding a leaf selection so the value pane is never stale. */
    function refresh(): void {
        const entries = allEntries();
        tree.setNodes(buildTreeNodes(entries));
        // A small inspector tree reads best fully expanded — every key visible
        // without drilling in.
        tree.expandAll();

        // Seed the first value leaf so the value pane isn't blank. selectNode
        // (and revealByPredicate) deliberately don't emit "selection", so load
        // the value here too. An empty store leaves nothing to select.
        showValue(editor, undefined);

        if (entries.length > 0) {
            void tree.revealByPredicate(data => typeof data === "string").then(node => {
                if (node !== null && typeof node.data === "string") {
                    tree.selectNode(node);
                    showValue(editor, node.data);
                }
            });
        }
    }

    refresh();

    // A horizontal Split: the key tree pinned (weight 0) so a window resize only
    // grows the value editor (VALUE_WEIGHT), with a draggable gutter between
    // (see QueryPanel's Split).
    const body = new Component();
    body.setLayoutManager(new Split({ orientation: "horizontal" }));
    body.addComponent(tree,   { weight: 0 });
    body.addComponent(editor, { weight: VALUE_WEIGHT });

    const clearButton = Button({ text: `Clear ${APP_NAME} data`, showText: true, compact: true });
    clearButton.on("action", () => {
        clearAppKeys();
        refresh();
    });

    const closeButton = Button({ text: "Close", showText: true, compact: true });
    closeButton.on("action", () => win.requestClose());

    // CodeEditor holds a CodeMirror view and a theme subscription; release them
    // when the window closes (title-bar close or the Close button).
    win.on("close", () => editor.dispose());

    const buttons = Panel({
        layoutManager: new HBox({ spacing: BUTTON_SPACING }),
        insets       : new Insets(PAD, PAD, PAD, PAD),
    });
    buttons.addComponent(Spacer.flex());
    buttons.addComponent(clearButton);
    buttons.addComponent(closeButton);

    const root = Panel({ layoutManager: new Border() });
    root.addComponent(body,    { placement: Placement.CENTER });
    root.addComponent(buttons, { placement: Placement.SOUTH });

    return root;
}
