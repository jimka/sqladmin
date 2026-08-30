// Two client-side download triggers, both clicking a temporary <a download>
// anchor: `download` wraps a client-serialized string in a Blob first (the
// query-result export — serialize.ts stays pure and node-testable, since the
// serializer returns a string and this module alone turns it into a file the
// browser saves); `downloadUrl` points the anchor straight at a server URL
// instead, for a response the backend streams (the table/view export route).
// Kept in its own DOM-bound module for that same node-testability reason.
//
// This is manual-verify: node vitest has no DOM anchor to click, so the
// behaviour (a file named `filename` downloads with the given content) is
// checked in the browser smoke test, not a unit test.

/**
 * Trigger a browser download of `content` as `filename` via a Blob + anchor.
 * Creates an object URL, clicks a hidden `<a download>`, then removes the anchor
 * and revokes the URL so no object URL or DOM node leaks.
 *
 * @param content - The file body (already serialized).
 * @param filename - The suggested download filename.
 * @param mimeType - The Blob's MIME type (e.g. "text/csv", "application/json").
 */
export function download(content: string, filename: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url  = URL.createObjectURL(blob);

    downloadUrl(url, filename);

    URL.revokeObjectURL(url);
}

/**
 * Trigger a browser download by navigating a hidden `<a download>` anchor
 * straight to `url` — for a server-streamed export (e.g. the table/view
 * export endpoint), where the browser downloads the response body itself
 * rather than the app serializing content into a Blob first (see
 * {@link download} for that case). The `download` attribute makes this a
 * file save rather than a top-level navigation.
 *
 * @param url - The URL to navigate the anchor to.
 * @param filename - The suggested download filename.
 */
export function downloadUrl(url: string, filename: string): void {
    const anchor = document.createElement("a");
    anchor.href     = url;
    anchor.download = filename;
    anchor.style.display = "none";

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
}
