// The MIME types the client-side exporters download files as, shared so the same
// string isn't re-declared in each export helper.

/** CSV download. */
export const CSV_MIME = "text/csv";

/** JSON download. */
export const JSON_MIME = "application/json";

/** Plain-text download (e.g. an EXPLAIN plan's FORMAT TEXT output). */
export const TEXT_MIME = "text/plain";
