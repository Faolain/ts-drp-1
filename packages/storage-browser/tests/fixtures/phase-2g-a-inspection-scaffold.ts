/* eslint-disable jsdoc/require-jsdoc -- bounded tests-only browser observation scaffold */
import { inspectStorageCapability } from "@ts-drp/storage";

import type { BrowserTestCapacityPort } from "./phase-2g-a-browser-capacity-scaffold.js";

type ObservationApi = Readonly<{
	inspectStorageCapability(port: BrowserTestCapacityPort): Promise<Readonly<Record<string, unknown>>>;
}>;

export function selectInspectionApi(module: Record<string, unknown>): ObservationApi {
	const candidate = module.inspectStorageCapability;
	if (candidate !== inspectStorageCapability)
		throw new TypeError("real inspectStorageCapability export provenance is absent");
	return Object.freeze({ inspectStorageCapability });
}
