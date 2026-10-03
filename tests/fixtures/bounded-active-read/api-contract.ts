// Deliberately uncompensated required API type RED: no optional shape or cast repairs product wiring.
import type {
	AheBoundedActiveRead,
	AheBoundedReadAcquisition,
	AheBoundedReadLimits,
	AheDurableStore,
	StoreResult,
} from "@ts-drp/storage";

import { LIMITS, OBJECT } from "./contract.js";
/**
 *
 * @param store
 */
export function required(store: AheDurableStore): Promise<StoreResult<AheBoundedReadAcquisition>> {
	const limits: AheBoundedReadLimits = LIMITS;
	return store.acquireBoundedActiveRead({ objectId: OBJECT, ancestorCount: 2, limits });
}
/**
 *
 * @param reader
 */
export function handle(reader: AheBoundedActiveRead): Promise<void> {
	void reader.checkCurrent();
	return reader.release();
}
