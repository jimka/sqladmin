// The start page's empty-workspace gating logic, split out from StartPage.ts
// so it can be unit-tested without pulling in the library's DOM-backed
// component classes (StartPage.ts's top-level imports touch `document` at
// module-load time, which the project's node-environment test runner has no
// stand-in for — see vitest.config.ts).

import type { SqlAdminController } from "../SqlAdminController";

/**
 * Whether the start page's welcome blurb should render — true only when the
 * workspace is truly empty (no recent tables and no saved queries), so the
 * blurb never shows alongside a populated Recent tables or Saved queries list.
 *
 * @param controller - Supplies the recent-tables and saved-queries lists.
 *
 * @returns Whether to show the welcome blurb.
 */
export function shouldShowWelcome(controller: Pick<SqlAdminController, "recentTables" | "savedList">): boolean {
    return controller.recentTables().length === 0 && controller.savedList().length === 0;
}
