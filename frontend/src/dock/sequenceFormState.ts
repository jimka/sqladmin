// Pure, DOM-free helpers backing the sequence info form's seeding and dirty
// tracking (see the "tsui DOM module side effects" convention — kept out of
// SequenceInfoPanel.ts so these can be unit-tested under the node vitest
// harness without touching the DOM). Distinct from `ddlSpecs.ts`'s
// `diffSequenceSpecs`: that function THROWS on a non-integer numeric field,
// which is correct for a Save-time diff but wrong for a keystroke-by-keystroke
// dirty check that must also run while a numeric field holds in-progress,
// possibly invalid text.

import type { SequenceDetail } from "../contract";
import type { EditedSequenceValues } from "./ddlSpecs";

/**
 * Map a fetched `SequenceDetail` to the form's baseline field values — the
 * same shape `diffSequenceSpecs` compares against, but used here to both seed
 * the widgets and serve as the dirty check's "unedited" snapshot. The Current
 * value field seeds as `""` (not `diffSequenceSpecs`'s `"—"` sentinel) per the
 * form's own seeding rule; `diffSequenceSpecs` already treats `""` as
 * "unset", so the two conventions stay compatible.
 *
 * @param detail - the sequence's current state and parameters.
 * @returns the form's baseline `EditedSequenceValues`.
 */
export function detailToEditedValues(detail: SequenceDetail): EditedSequenceValues {
    return {
        lastValue:  detail.lastValue ?? "",
        startValue: detail.startValue,
        increment:  detail.increment,
        minValue:   detail.minValue,
        maxValue:   detail.maxValue,
        cacheSize:  detail.cacheSize,
        cycle:      detail.cycle,
        dataType:   detail.dataType,
        owner:      detail.owner,
    };
}

/**
 * Whether the form's current field values differ from its seeded baseline —
 * never throws (unlike `diffSequenceSpecs`'s integer-string check), so it can
 * run on every keystroke including while a numeric field holds in-progress,
 * possibly non-integer text. `cycle` compares with `!==` (a boolean, not a
 * string); every other field trims before comparing so incidental leading/
 * trailing whitespace doesn't read as a change.
 *
 * @param baseline - the form's values as last seeded (from `detailToEditedValues`).
 * @param edited - the form's current field values.
 * @returns `true` if any field differs from `baseline`.
 */
export function isSequenceFormDirty(baseline: EditedSequenceValues, edited: EditedSequenceValues): boolean {
    return (
        edited.lastValue.trim()  !== baseline.lastValue.trim()  ||
        edited.startValue.trim() !== baseline.startValue.trim() ||
        edited.increment.trim()  !== baseline.increment.trim()  ||
        edited.minValue.trim()   !== baseline.minValue.trim()   ||
        edited.maxValue.trim()   !== baseline.maxValue.trim()   ||
        edited.cacheSize.trim()  !== baseline.cacheSize.trim()  ||
        edited.cycle             !== baseline.cycle             ||
        edited.dataType.trim()   !== baseline.dataType.trim()   ||
        edited.owner.trim()      !== baseline.owner.trim()
    );
}

/** The Data type combo's fixed allowlist (mirrors the backend's ALTER SEQUENCE type check). */
export const SEQUENCE_DATA_TYPE_CHOICES: readonly string[] = ["smallint", "integer", "bigint"];

/**
 * The Data type combo's item list: the fixed allowlist, plus the sequence's
 * current type appended only if it isn't already one of those three — so an
 * unexpected/legacy type (e.g. a manually-altered `numeric`) is never lost
 * from the combo's seeded selection.
 *
 * @param currentDataType - the sequence's current data type.
 * @returns the combo's item strings, current type always included.
 */
export function dataTypeItems(currentDataType: string): string[] {
    return SEQUENCE_DATA_TYPE_CHOICES.includes(currentDataType)
        ? [...SEQUENCE_DATA_TYPE_CHOICES]
        : [...SEQUENCE_DATA_TYPE_CHOICES, currentDataType];
}

/**
 * The Owner combo's item list: the connection's role names, plus the
 * sequence's current owner appended only if it isn't already among them —
 * covering both a stale/foreign owner and a degraded empty `roles` fetch
 * (see `SequenceInfoPanelDeps.roles`'s "fetch failed" fallback), where this
 * reduces to a single-item combo holding just the current owner.
 *
 * @param roles - the connection's role names (empty when the roles fetch failed).
 * @param currentOwner - the sequence's current owner.
 * @returns the combo's item strings, current owner always included.
 */
export function ownerItems(roles: readonly string[], currentOwner: string): string[] {
    return roles.includes(currentOwner) ? [...roles] : [...roles, currentOwner];
}
