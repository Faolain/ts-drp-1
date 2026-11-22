import type { V3RoomCurrencyStatement } from "../../packages/node/src/v3-room.js";

/**
 * Sync before sending (live install rule): the creator's statement for its current epoch, handed
 * over with an install the way the pages' successor delivery sends it with the offer. A writer that
 * is current ignores it; one that reopened its lineage from storage installs only with it.
 * @param creator - The creator's open room, if the fixture has it.
 * @returns `{ currency }`, or `{}` when the creator has no statement to give.
 */
export function creatorCurrency(
	creator: { currencyStatement?(): V3RoomCurrencyStatement } | undefined
): { currency?: V3RoomCurrencyStatement } {
	let currency: V3RoomCurrencyStatement | undefined;
	try {
		currency = creator?.currencyStatement?.();
	} catch {
		// A closed creator room gives no statement; the install then needs none or is refused.
		currency = undefined;
	}
	return currency === undefined ? {} : { currency };
}
